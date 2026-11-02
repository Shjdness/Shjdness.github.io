import Elysia,{t} from 'elysia';
import {setup} from '../setup';
import {getEnv} from '../utils/di';
import {checkinVault} from '../utils/checkin-vault';
import {checkinDate,checkinValue,checkinKey,shanghaiDate} from '../utils/checkin-format';
import {readCheckin,saveCheckin} from '../utils/checkin-store';
import {allowBurst} from '../utils/rate-limit';
import {checkinKeyGuard} from '../utils/checkin-key-guard';
export function LifeCheckinsService(){
  const env=getEnv(),db=env.DB;
  const authorize=(c:{uid?:number;admin?:boolean;set:{headers:Record<string,unknown>;status?:number|string}})=>{c.set.headers['Cache-Control']='private, no-store, max-age=0';c.set.headers['Vary']='Origin, Authorization';if(!c.uid||!c.admin){c.set.status=403;return null;}return c.uid;};
  const vault=async()=>{const v=await checkinVault(env.LIFE_CHECKIN_KEY??'',[env.JWT_SECRET,env.REPORT_MAIL_VAULT_KEY??'',env.DEEPSEEK_API_KEY??'',env.REPORT_QQ_SMTP_AUTH_CODE??'']);await checkinKeyGuard(db,v);return v;};
  const dateSchema=t.String({pattern:'^20[0-9]{2}-[0-9]{2}-[0-9]{2}$'});
  // Concrete bounded schema; the envelope is named record because this Elysia
  // version unwraps a value property in dynamic request validation.
  const scopes={email:t.Boolean(),ai:t.Boolean()},key=t.String({maxLength:36});
  const valueSchema=t.Object({version:t.Literal(1),state:t.Union([t.Literal('draft'),t.Literal('confirmed')]),
    items:t.Array(t.Object({key,kind:t.Union([t.Literal('habit'),t.Literal('checkin')]),source:t.Nullable(t.Object({kind:t.Union([t.Literal('habit'),t.Literal('todo')]),id:t.Integer({minimum:1,maximum:Number.MAX_SAFE_INTEGER})},{additionalProperties:false})),name:t.String({maxLength:100}),result:t.Union([t.Literal('done'),t.Literal('missed'),t.Literal('unrecorded'),t.Literal('na')]),note:t.String({maxLength:140}),...scopes},{additionalProperties:false}),{maxItems:12}),
    meals:t.Array(t.Object({key,kind:t.Union([t.Literal('plan'),t.Literal('eaten')]),description:t.String({maxLength:240}),portion:t.String({maxLength:100}),...scopes},{additionalProperties:false}),{maxItems:6}),
    sleep:t.Object({bedAt:t.Nullable(t.String({maxLength:25})),wakeAt:t.Nullable(t.String({maxLength:25})),...scopes},{additionalProperties:false}),
    targets:t.Object({bedMinute:t.Nullable(t.Integer({minimum:0,maximum:1439})),wakeMinute:t.Nullable(t.Integer({minimum:0,maximum:1439}))},{additionalProperties:false}),
  },{additionalProperties:false});
  return new Elysia({aot:false}).use(setup())
    .get('/life/checkins/status',async c=>{const owner=authorize(c);if(!owner)return 'Owner access is required';let configured=false;try{await vault();configured=true;}catch{}return {ownerId:owner,configured,scopeVersion:1,externalAnalysisAvailable:false};})
    .get('/life/checkins',async c=>{const owner=authorize(c);if(!owner)return 'Owner access is required';if(!allowBurst(`checkin-read:${owner}`,30)){c.set.status=429;return {ownerId:owner,code:'RATE_LIMIT'};}
      const before=c.query.before??'2099-12-31';try{checkinDate(before);}catch{c.set.status=400;return {ownerId:owner,code:'INVALID_DATE'};}
      const rows=await db.prepare('SELECT record_date AS date,revision,updated_at AS updatedAt FROM life_checkins WHERE owner_id=? AND record_date<? ORDER BY record_date DESC LIMIT 31').bind(owner,before).all();if(!rows.success)throw Error('Check-in history unavailable');const items=rows.results.slice(0,30);return {ownerId:owner,items,nextBefore:rows.results.length>30?(items[29] as {date:string}).date:null};
    },{query:t.Object({before:t.Optional(dateSchema)},{additionalProperties:false})})
    .get('/life/checkins/:date/revisions',async c=>{const owner=authorize(c);if(!owner)return 'Owner access is required';try{checkinDate(c.params.date);}catch{c.set.status=400;return {ownerId:owner,code:'INVALID_DATE'};}
      if(!allowBurst(`checkin-history:${owner}`,10)){c.set.status=429;return {ownerId:owner,code:'RATE_LIMIT'};}
      let v;try{v=await vault();}catch{c.set.status=503;return {ownerId:owner,code:'CHECKIN_KEY_UNAVAILABLE'};}
      const rows=await db.prepare('SELECT revision,sealed_json,updated_at FROM life_checkin_revisions WHERE owner_id=? AND record_date=? ORDER BY revision DESC LIMIT 10').bind(owner,c.params.date).all<{revision:number;sealed_json:string;updated_at:number}>();if(!rows.success)throw Error('Check-in revisions unavailable');
      const items=[];for(const r of rows.results)items.push({revision:r.revision,updatedAt:r.updated_at,record:await v.open(owner,c.params.date,r.revision,r.sealed_json)});return {ownerId:owner,date:c.params.date,items};
    },{params:t.Object({date:dateSchema})})
    .get('/life/checkins/:date',async c=>{const owner=authorize(c);if(!owner)return 'Owner access is required';try{checkinDate(c.params.date);}catch{c.set.status=400;return {ownerId:owner,code:'INVALID_DATE'};}
      let v;try{v=await vault();}catch{c.set.status=503;return {ownerId:owner,code:'CHECKIN_KEY_UNAVAILABLE'};}
      return {ownerId:owner,record:await readCheckin(db,v,owner,c.params.date)};
    },{params:t.Object({date:dateSchema})})
    .post('/life/checkins/:date',async c=>{const owner=authorize(c);if(!owner)return 'Owner access is required';if(!allowBurst(`checkin-write:${owner}`,12)){c.set.status=429;return {ownerId:owner,code:'RATE_LIMIT'};}
      let validation='DATE';try{checkinDate(c.params.date);validation='KEY';checkinKey(c.body.clientKey);validation='VALUE';checkinValue(c.body.record,c.params.date);validation='FUTURE';if(c.params.date>shanghaiDate())throw Error();}catch{c.set.status=400;return {ownerId:owner,code:'INVALID_CHECKIN_'+validation};}
      let v;try{v=await vault();}catch{c.set.status=503;return {ownerId:owner,code:'CHECKIN_KEY_UNAVAILABLE'};}
      for(const kind of ['habit','todo'] as const){const ids=c.body.record.items.filter(i=>i.source?.kind===kind).map(i=>i.source!.id);if(!ids.length)continue;
        const rows=await db.prepare(`SELECT id FROM ${kind==='habit'?'habits':'life_todos'} WHERE owner_id=? AND id IN (${ids.map(()=>'?').join(',')})`).bind(owner,...ids).all<{id:number}>();if(!rows.success)throw Error('Check-in references unavailable');if(rows.results.length!==ids.length){c.set.status=400;return {ownerId:owner,code:'CHECKIN_SOURCE_UNAVAILABLE'};}
      }
      const result=await saveCheckin(db,v,owner,c.params.date,{...c.body,value:c.body.record});if(!result.saved)c.set.status=result.reason==='budget'?503:409;return {ownerId:owner,...result};
    },{params:t.Object({date:dateSchema}),body:t.Object({baseRevision:t.Integer({minimum:0,maximum:1000000}),clientKey:t.String({maxLength:36}),record:valueSchema},{additionalProperties:false})});
}
