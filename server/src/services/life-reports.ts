import {listReportJobs} from '../utils/report-jobs';
import Elysia, { t } from 'elysia';
import { setup } from '../setup';
import { getEnv } from '../utils/di';
import { reportWindow } from '../utils/life-report';
import {allowBurst} from '../utils/rate-limit';
import {decodeReportRow,findReportForPeriod,saveReportSnapshot} from '../utils/report-history';
import {readReportPreferences,reserveReportWrite,updateReportPreferences,updateReportAutomation} from '../utils/report-settings';
import {REPORT_AI_MODEL,REPORT_AI_MONTHLY_FEN,REPORT_AI_PRICE_REVIEW_BEFORE} from '../utils/report-ai';
import {generateReportAnalysis,readReportAnalysis} from '../utils/report-analysis';
import {readReportAIConsent,setReportAIConsent} from '../utils/report-ai-consent';
import {optionalCheckinVault} from '../utils/checkin-key-guard';
import {saveReportWithCheckins,readReportCheckins} from '../utils/report-checkin-snapshot';
import {archiveReportCheckins} from '../utils/report-checkin-format';
import {checkinAIShareableInMail} from '../utils/report-checkin-format';
import {checkinAIRequest} from '../utils/checkin-ai';
import {generateCheckinAnalysis,readCheckinAnalysis} from '../utils/checkin-analysis';

import {previewLifeReport} from '../utils/report-data';
export {previewLifeReport,reportQueries} from '../utils/report-data';

export function LifeReportsService() {
  const env=getEnv(),db=env.DB;
  const savedReport=async(owner:number,id:number)=>{
    const rows=await db.prepare('SELECT id,kind,period_start,period_end,snapshot_json,snapshot_sha256 FROM life_reports WHERE owner_id=? AND id=?').bind(owner,id).all<Record<string,unknown>>();
    if(!rows.success)throw Error('Report read unavailable');
    return rows.results[0]?decodeReportRow(owner,rows.results[0]):null;
  };
  const authorize=({uid,admin,set}:{uid?:number;admin?:boolean;set:{headers:Record<string,unknown>;status?:number|string}})=>{
    set.headers['Cache-Control']='private, no-store, max-age=0';
    set.headers['Pragma']='no-cache';
    set.headers['Vary']='Origin, Authorization';
    if(!uid||!admin){set.status=403;return null;}return uid;
  };
  const kind=t.Optional(t.Union([t.Literal('daily'),t.Literal('weekly')]));
  return new Elysia({aot:false}).use(setup())
    .get('/life/reports/preview',async context=>{
      const owner=authorize(context);if(!owner)return 'Owner access is required';
      if(!allowBurst(`life-report:${owner}`,6)){context.set.status=429;context.set.headers['Retry-After']='60';return 'Report refresh limit reached';}
      return previewLifeReport(db,owner,context.query.kind ?? 'daily');
    },{query:t.Object({kind})})
    .get('/life/reports/status',async context=>{
      const owner=authorize(context);if(!owner)return 'Owner access is required';
      const month=new Date(Date.now()+8*3600000).toISOString().slice(0,7);
      const rows=await db.prepare('SELECT reserved_fen FROM life_report_ai_budget WHERE month=?').bind(month).all<{reserved_fen:number}>();
      if(!rows.success)throw Error('AI budget read unavailable');
      const reservedMonthlyFen=rows.results[0]?.reserved_fen??0;
      const preferences=await readReportPreferences(db,owner);
      const ai=await readReportAIConsent(db,owner),mail=await db.prepare(`SELECT p.email_enabled,c.verified_at,c.enabled_at,c.paused_reason FROM life_report_preferences p LEFT JOIN life_report_mail_contacts c ON c.owner_id=p.owner_id WHERE p.owner_id=?`).bind(owner).all<{email_enabled:number;verified_at:number|null;enabled_at:number|null;paused_reason:string|null}>();
      if(!mail.success)throw Error('Mail status unavailable');const recipient=mail.results[0];
      return {ownerId:owner,deepseekConfigured:Boolean(env.DEEPSEEK_API_KEY?.trim()),apiVerified:false,aiEnabled:ai.enabled,emailEnabled:Boolean(recipient?.email_enabled===1&&recipient.verified_at!==null&&recipient.enabled_at!==null&&!recipient.paused_reason),automationEnabled:preferences.dailyEnabled||preferences.weeklyEnabled,schedulerAvailable:true,manualAIAvailable:env.REPORT_OUTBOUND_PAUSED!=='true'&&Boolean(env.DEEPSEEK_API_KEY?.trim())&&Date.now()<REPORT_AI_PRICE_REVIEW_BEFORE&&reservedMonthlyFen+5<=REPORT_AI_MONTHLY_FEN,model:REPORT_AI_MODEL,monthlyBudgetFen:REPORT_AI_MONTHLY_FEN,reservedMonthlyFen,aiScope:'statistics'};
    })
    .get('/life/reports/settings',async context=>{
      const owner=authorize(context);if(!owner)return 'Owner access is required';
      const preferences=await readReportPreferences(db,owner);
      return {ownerId:owner,preferences,automationEnabled:preferences.dailyEnabled||preferences.weeklyEnabled};
    })
    .get('/life/reports/ai-automation',async context=>{
      const owner=authorize(context);if(!owner)return 'Owner access is required';
      const consent=await readReportAIConsent(db,owner);
      const month=new Date(Date.now()+8*3600000).toISOString().slice(0,7);
      const rows=await db.prepare('SELECT reserved_fen FROM life_report_ai_budget WHERE month=?').bind(month).all<{reserved_fen:number}>();if(!rows.success)throw Error('AI budget unavailable');
      return {ownerId:owner,enabled:consent.enabled,revision:consent.revision,enabledAt:consent.enabledAt,scope:'statistics',model:REPORT_AI_MODEL,configured:Boolean(env.DEEPSEEK_API_KEY?.trim()),paused:env.REPORT_OUTBOUND_PAUSED==='true',pricingValid:Date.now()<REPORT_AI_PRICE_REVIEW_BEFORE,monthlyBudgetFen:REPORT_AI_MONTHLY_FEN,reservedMonthlyFen:rows.results[0]?.reserved_fen??0};
    })
    .post('/life/reports/ai-automation',async context=>{
      const owner=authorize(context);if(!owner)return 'Owner access is required';
      if(context.body.enabled){
        if(!allowBurst(`life-report-ai-setting:${owner}`,8)){context.set.status=429;return {ownerId:owner,code:'AI_SETTING_RATE_LIMIT'};}
        if(env.REPORT_OUTBOUND_PAUSED==='true'||!env.DEEPSEEK_API_KEY?.trim()||Date.now()>=REPORT_AI_PRICE_REVIEW_BEFORE){context.set.status=503;return {ownerId:owner,code:'AI_NOT_AVAILABLE'};}
      }
      const result=await setReportAIConsent({db,ownerId:owner,...context.body});
      if(!result.saved)context.set.status=result.reason==='write-budget'?503:409;
      const next=await readReportAIConsent(db,owner);
      return {ownerId:owner,saved:result.saved,enabled:next.enabled,revision:next.revision,enabledAt:next.enabledAt};
    },{body:t.Object({enabled:t.Boolean(),baseRevision:t.Integer({minimum:0,maximum:Number.MAX_SAFE_INTEGER}),allowNumericAnalysis:t.Optional(t.Literal(true))},{additionalProperties:false})})
    .post('/life/reports/settings',async context=>{
      const owner=authorize(context);if(!owner)return 'Owner access is required';
      if(!allowBurst(`life-report-write:${owner}`,10)){context.set.status=429;return 'Report write limit reached';}
      const result=await updateReportPreferences(db,owner,context.body);
      if(!result.saved)context.set.status=result.paused?503:409;
      return {ownerId:owner,...result,automationEnabled:result.preferences.dailyEnabled||result.preferences.weeklyEnabled};
    },{body:t.Object({dailyTime:t.String({pattern:'^([01]\\d|2[0-3]):[0-5]\\d$'}),weeklyTime:t.String({pattern:'^([01]\\d|2[0-3]):[0-5]\\d$'}),weeklyDay:t.Integer({minimum:1,maximum:7}),baseRevision:t.Integer({minimum:0,maximum:Number.MAX_SAFE_INTEGER})},{additionalProperties:false})})
    .post('/life/reports/automation',async context=>{
      const owner=authorize(context);if(!owner)return 'Owner access is required';
      if(!allowBurst(`life-report-automation:${owner}`,10)){context.set.status=429;return 'Report setting limit reached';}
      const result=await updateReportAutomation(db,owner,context.body);
      if(!result.saved)context.set.status=result.paused?503:409;
      return {ownerId:owner,...result,automationEnabled:result.preferences.dailyEnabled||result.preferences.weeklyEnabled};
    },{body:t.Object({dailyEnabled:t.Boolean(),weeklyEnabled:t.Boolean(),baseRevision:t.Integer({minimum:0,maximum:Number.MAX_SAFE_INTEGER})},{additionalProperties:false})})
    .get('/life/reports/jobs',async context=>{
      const owner=authorize(context);if(!owner)return 'Owner access is required';
      return {ownerId:owner,items:await listReportJobs(db,owner)};
    })
    .post('/life/reports/history',async context=>{
      const owner=authorize(context);if(!owner)return 'Owner access is required';
      if(!allowBurst(`life-report-save:${owner}`,6)){context.set.status=429;return 'Report save limit reached';}
      const now=new Date(),reportKind=context.body.kind??'daily',period=reportWindow(reportKind,now);
      const existing=await findReportForPeriod(db,owner,period);
      if(existing)return {ownerId:owner,saved:true,created:false,...existing};
      const checkins=await optionalCheckinVault(env);
      if(checkins){const stored=await saveReportWithCheckins(db,checkins,owner,period,now);return {ownerId:owner,saved:true,...stored};}
      if(!await reserveReportWrite(db)){context.set.status=503;return {saved:false,code:'REPORT_WRITE_BUDGET_PAUSED'};}
      const stored=await saveReportSnapshot(db,owner,await previewLifeReport(db,owner,reportKind,now));
      return {ownerId:owner,saved:true,...stored};
    },{body:t.Object({kind},{additionalProperties:false})})
    .get('/life/reports/history',async context=>{
      const owner=authorize(context);if(!owner)return 'Owner access is required';
      const before=context.query.before?Number(context.query.before):Number.MAX_SAFE_INTEGER;
      if(!Number.isSafeInteger(before)||before<1){context.set.status=400;return 'Invalid history cursor';}
      const result=await db.prepare('SELECT id,kind,period_start,period_end,created_at FROM life_reports WHERE owner_id=? AND id<? ORDER BY id DESC LIMIT 21').bind(owner,before).all();
      if(!result.success)throw Error('Report history unavailable');
      const items=result.results.slice(0,20);
      return {ownerId:owner,items,nextBefore:result.results.length>20?String(items[items.length-1].id):null};
    },{query:t.Object({before:t.Optional(t.String({pattern:'^[0-9]{1,16}$'}))})})
    .get('/life/reports/history/:id/analysis',async context=>{
      const owner=authorize(context);if(!owner)return 'Owner access is required';
      const id=Number(context.params.id);if(!Number.isSafeInteger(id)||id<1){context.set.status=400;return 'Invalid report id';}
      const saved=await savedReport(owner,id);if(!saved){context.set.status=404;return 'Report not found';}
      return {ownerId:owner,reportId:id,...await readReportAnalysis(db,owner,saved)};
    })
    .get('/life/reports/history/:id/checkins',async context=>{
      const owner=authorize(context);if(!owner)return 'Owner access is required';
      const id=Number(context.params.id);if(!Number.isSafeInteger(id)||id<1){context.set.status=400;return 'Invalid report id';}
      if(!allowBurst(`life-report-details:${owner}`,10)){context.set.status=429;return {ownerId:owner,code:'RATE_LIMIT'};}
      const saved=await savedReport(owner,id);if(!saved){context.set.status=404;return 'Report not found';}
      const exists=await db.prepare('SELECT report_id FROM life_report_checkin_snapshots WHERE owner_id=? AND report_id=?').bind(owner,id).all();if(!exists.success)throw Error('Report extension unavailable');
      if(!exists.results.length)return {ownerId:owner,reportId:id,details:null};
      const vault=await optionalCheckinVault(env);if(!vault){context.set.status=503;return {ownerId:owner,code:'CHECKIN_KEY_UNAVAILABLE'};}
      const details=await readReportCheckins(db,vault,owner,saved);return {ownerId:owner,reportId:id,report:saved.report,details:details?{current:details.current,archived:!('sources' in details.snapshot),snapshot:'sources' in details.snapshot?archiveReportCheckins(details.snapshot,saved.report):details.snapshot}:null};
    })
    .get('/life/reports/history/:id/checkin-analysis',async context=>{
      const owner=authorize(context);if(!owner)return 'Owner access is required';const id=Number(context.params.id);if(!Number.isSafeInteger(id)||id<1){context.set.status=400;return 'Invalid report id';}
      if(!allowBurst(`life-checkin-analysis-read:${owner}`,10)){context.set.status=429;return {ownerId:owner,code:'RATE_LIMIT'};}
      const saved=await savedReport(owner,id);if(!saved){context.set.status=404;return 'Report not found';}const exists=await db.prepare('SELECT report_id FROM life_report_checkin_snapshots WHERE owner_id=? AND report_id=?').bind(owner,id).all();if(!exists.success)throw Error('Report extension unavailable');if(!exists.results.length)return {ownerId:owner,reportId:id,scopeVersion:2,report:saved.report,snapshot:null,state:'none',analysis:null,reason:'no-snapshot',available:false,unavailableReason:'no-snapshot',requestBytes:0,mailSafe:false};const vault=await optionalCheckinVault(env);if(!vault){context.set.status=503;return {ownerId:owner,code:'CHECKIN_KEY_UNAVAILABLE'};}
      const details=await readReportCheckins(db,vault,owner,saved),view=await readCheckinAnalysis(db,vault,owner,saved);let reason:string|null='no-snapshot',requestBytes=0;
      if(details){if(!details.current||!('sources' in details.snapshot))reason='scope-changed';else {const prepared=checkinAIRequest(saved.report,details.snapshot);reason=prepared.reason;requestBytes=prepared.body?new TextEncoder().encode(prepared.body).length:0;}}
      if(!reason&&env.REPORT_OUTBOUND_PAUSED==='true')reason='paused';if(!reason&&!env.DEEPSEEK_API_KEY?.trim())reason='not-configured';if(!reason&&Date.now()>=REPORT_AI_PRICE_REVIEW_BEFORE)reason='pricing-review';
      return {ownerId:owner,reportId:id,scopeVersion:2,report:saved.report,snapshot:details?('sources' in details.snapshot?archiveReportCheckins(details.snapshot,saved.report):details.snapshot):null,...view,available:!reason&&view.state==='none'&&!view.reason,unavailableReason:reason??view.reason,requestBytes,mailSafe:details?checkinAIShareableInMail(details.snapshot):false};
    })
    .post('/life/reports/history/:id/checkin-analysis',async context=>{
      const owner=authorize(context);if(!owner)return 'Owner access is required';if(env.REPORT_OUTBOUND_PAUSED==='true'){context.set.status=503;return {ownerId:owner,code:'OUTBOUND_PAUSED'};}const id=Number(context.params.id);if(!Number.isSafeInteger(id)||id<1){context.set.status=400;return 'Invalid report id';}
      if(!allowBurst(`life-checkin-analysis-write:${owner}`,3)){context.set.status=429;return {ownerId:owner,code:'RATE_LIMIT'};}const saved=await savedReport(owner,id);if(!saved){context.set.status=404;return 'Report not found';}const vault=await optionalCheckinVault(env);if(!vault){context.set.status=503;return {ownerId:owner,code:'CHECKIN_KEY_UNAVAILABLE'};}
      return {ownerId:owner,reportId:id,...await generateCheckinAnalysis({db,vault,owner,saved,scope2Approved:context.body.allowSelectedModules,enabled:true,apiKey:env.DEEPSEEK_API_KEY})};
    },{body:t.Object({scopeVersion:t.Literal(2),allowSelectedModules:t.Literal(true)},{additionalProperties:false})})
    .post('/life/reports/history/:id/analysis',async context=>{
      const owner=authorize(context);if(!owner)return 'Owner access is required';
      if(env.REPORT_OUTBOUND_PAUSED==='true'){context.set.status=503;return {ownerId:owner,code:'OUTBOUND_PAUSED'};}
      const id=Number(context.params.id);if(!Number.isSafeInteger(id)||id<1){context.set.status=400;return 'Invalid report id';}
      if(!allowBurst(`life-report-analyze:${owner}`,6)){context.set.status=429;return 'Analysis limit reached';}
      const saved=await savedReport(owner,id);if(!saved){context.set.status=404;return 'Report not found';}
      return {ownerId:owner,reportId:id,...await generateReportAnalysis({db,ownerId:owner,saved,enabled:context.body.allowNumericAnalysis,apiKey:env.DEEPSEEK_API_KEY})};
    },{body:t.Object({allowNumericAnalysis:t.Literal(true)},{additionalProperties:false})})
    .get('/life/reports/history/:id',async context=>{
      const owner=authorize(context);if(!owner)return 'Owner access is required';
      const id=Number(context.params.id);if(!Number.isSafeInteger(id)||id<1){context.set.status=400;return 'Invalid report id';}
      const result=await db.prepare('SELECT id,kind,period_start,period_end,snapshot_json,snapshot_sha256 FROM life_reports WHERE owner_id=? AND id=?').bind(owner,id).all<Record<string,unknown>>();
      if(!result.success)throw Error('Report history unavailable');
      if(!result.results.length){context.set.status=404;return 'Report not found';}
      return {ownerId:owner,...await decodeReportRow(owner,result.results[0])};
    });
}
