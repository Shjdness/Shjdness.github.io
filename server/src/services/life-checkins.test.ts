import 'reflect-metadata';
import {createRequire} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
import {drizzle} from 'drizzle-orm/d1';
import {SignJWT} from 'jose';
import {expect,it} from 'vitest';
import * as schema from '../db/schema';
import {runRequestContext} from '../utils/di';
import {LifeCheckinsService} from './life-checkins';
import {checkinVault} from '../utils/checkin-vault';
import {checkinDate,checkinValue,emptyCheckin,projectCheckin} from '../utils/checkin-format';
import {readCheckin,saveCheckin} from '../utils/checkin-store';
import {LifeBackupService} from './life-backup';
import {validateBackup,encryptBackup,decryptBackup} from '../../../client/src/features/life/backup-format';
import {reportDigest} from '../utils/report-analysis-format';
import {validateCheckinBackup,withoutCheckinGrants,type CheckinBackupRow} from '../utils/checkin-backup';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');
const secret=btoa(String.fromCharCode(...Array.from({length:32},(_,i)=>i+1)));
const key=()=>crypto.randomUUID();
function fixture(){
  const sqlite=new DatabaseSync(':memory:');const folder=new URL('../../sql/',import.meta.url);
  for(const file of readdirSync(folder).filter(n=>n.endsWith('.sql')).sort()){sqlite.exec(readFileSync(new URL(file,folder),'utf8'));if(file==='0002.sql')sqlite.exec('ALTER TABLE feeds ADD COLUMN top INTEGER DEFAULT 0');}
  sqlite.exec("INSERT INTO users(id,username,openid,permission) VALUES(1,'a','a',1),(2,'b','b',1),(3,'c','c',2)");
  const prepare=(sql:string)=>{let args:unknown[]=[];return {bind(...v:unknown[]){args=v;return this;},async all(){return {success:true,results:sqlite.prepare(sql).all(...args),meta:{}};},async raw(){return sqlite.prepare(sql).all(...args).map((row:Record<string,unknown>)=>Object.values(row));}};};
  const batch=async(statements:Array<{all:()=>Promise<unknown>}>)=>{sqlite.exec('BEGIN');try{const r=await Promise.all(statements.map(s=>s.all()));sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}};
  const raw={prepare,batch} as any,db=drizzle(raw,{schema});const env={DB:raw,JWT_SECRET:'fixture-signing-secret-32-characters',RIN_GITHUB_CLIENT_ID:'fixture',RIN_GITHUB_CLIENT_SECRET:'fixture',LIFE_CHECKIN_KEY:secret} as any;
  const service=runRequestContext(env,db,()=>LifeCheckinsService());
  const request=async(id:number|undefined,path:string,body?:unknown)=>{const headers:Record<string,string>={};if(id)headers.Authorization='Bearer '+await new SignJWT({id}).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(new TextEncoder().encode(env.JWT_SECRET));if(body!==undefined)headers['Content-Type']='application/json';return await runRequestContext(env,db,()=>service.handle(new Request('http://localhost/life/checkins'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)}))) as Omit<Response,'json'>&{json:()=>Promise<any>};};
  return {sqlite,raw,db,env,request};
}
function sample(){const v=emptyCheckin();v.state='confirmed';v.items=[{key:key(),kind:'habit',source:null,name:'synthetic piano',result:'unrecorded',note:'synthetic',email:true,ai:false}];v.meals=[{key:key(),kind:'plan',description:'synthetic rice',portion:'one bowl',email:false,ai:true}];return v;}
it('strictly distinguishes missing/planned and separate content scopes, rejects injected journal fields',()=>{
  const v=sample();expect(projectCheckin(v,'2026-11-01','ai')).toMatchObject({items:[],meals:[{kind:'plan'}],sleep:null});expect(projectCheckin(v,'2026-11-01','email')).toMatchObject({items:[{result:'unrecorded'}],meals:[]});v.state='draft';expect(projectCheckin(v,'2026-11-01','ai')).toBeNull();
  expect(()=>checkinValue({...v,diary:'never allowed'},'2026-11-01')).toThrow();expect(()=>checkinDate('2026-02-30')).toThrow();expect(()=>checkinValue({...v,items:[...v.items,...v.items]},'2026-11-01')).toThrow();
  v.sleep.bedAt='2026-11-02T01:00:00+08:00';expect(checkinValue(v,'2026-11-01').sleep.bedAt).toBe(v.sleep.bedAt);v.sleep.wakeAt='2026-11-03T01:00:00+08:00';expect(()=>checkinValue(v,'2026-11-01')).toThrow();
});
it('binds ciphertext to owner/day/revision and requires an independent strong key',async()=>{
  const v=await checkinVault(secret);const sealed=await v.seal(1,'2026-11-01',1,sample());expect(sealed).not.toContain('synthetic');await expect(v.open(2,'2026-11-01',1,sealed)).rejects.toThrow();await expect(v.open(1,'2026-11-02',1,sealed)).rejects.toThrow();await expect(v.open(1,'2026-11-01',2,sealed)).rejects.toThrow();await expect(checkinVault(secret,[secret])).rejects.toThrow();await expect(checkinVault('a'.repeat(44))).rejects.toThrow();
});
it('CAS updates preserve drafts, retry once, bound history and isolate owners without side effects',async()=>{
  const f=fixture();try{const v=await checkinVault(secret),value=sample(),input={value,baseRevision:0,clientKey:key()};const [a,b]=await Promise.all([saveCheckin(f.raw,v,1,'2026-11-01',input),saveCheckin(f.raw,v,1,'2026-11-01',input)]);expect(a.saved&&b.saved).toBe(true);expect((await readCheckin(f.raw,v,1,'2026-11-01'))?.revision).toBe(1);
    expect(await readCheckin(f.raw,v,2,'2026-11-01')).toBeNull();expect(f.sqlite.prepare('SELECT sealed_json FROM life_checkins').get().sealed_json).not.toContain('synthetic');
    for(let n=1;n<14;n++){value.items[0].note='edit '+n;expect(await saveCheckin(f.raw,v,1,'2026-11-01',{value,baseRevision:n,clientKey:key()})).toMatchObject({saved:true,revision:n+1});}
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM life_checkin_revisions').get().n).toBe(10);
    const history=await (await f.request(1,'/2026-11-01/revisions')).json();expect(history.items).toHaveLength(10);expect(history.items[0].revision).toBe(14);expect((await (await f.request(2,'/2026-11-01/revisions')).json()).items).toEqual([]);expect((await f.request(3,'/2026-11-01/revisions')).status).toBe(403);
    value.items[0].note='stale';expect(await saveCheckin(f.raw,v,1,'2026-11-01',{value,baseRevision:1,clientKey:key()})).toMatchObject({saved:false,reason:'conflict'});
    const before=f.sqlite.prepare('SELECT count(*) AS n FROM life_report_analyses').get().n;expect(before).toBe(0);
  }finally{f.sqlite.close();}
});
it('protects all routes, validates fields and safely disables new storage when key is lost',async()=>{
  const f=fixture();try{for(const id of [undefined,3])for(const [path,body] of [['/status',undefined],['',undefined],['/2026-11-01',undefined],['/2026-11-01',{baseRevision:0,clientKey:key(),record:sample()}]] as const){const r=await f.request(id,path,body);expect(r.status).toBe(403);expect(r.headers.get('cache-control')).toContain('no-store');}
    const invalid=await f.request(1,'/2026-11-01',{baseRevision:0,clientKey:key(),record:{...sample(),ownerId:2}});expect([400,422]).toContain(invalid.status);
    const body={baseRevision:0,clientKey:key(),record:sample()};const saved=await f.request(1,'/2026-11-01',body);expect(saved.status,await saved.text()).toBe(200);expect((await (await f.request(2,'/2026-11-01')).json()).record).toBeNull();
    f.env.LIFE_CHECKIN_KEY=undefined;const status=await f.request(1,'/status');expect(await status.json()).toMatchObject({configured:false});expect((await f.request(1,'/2026-11-01')).status).toBe(503);expect((await f.request(1,'/2026-11-01',body)).status).toBe(503);expect(f.sqlite.prepare('SELECT count(*) AS n FROM life_checkins').get().n).toBe(1);
  }finally{f.sqlite.close();}
});
it('exports a portable encrypted v5 backup, resets grants and restores facts under a new key without resetting spend',async()=>{
  const f=fixture();try{
    const vault=await checkinVault(secret),value=sample();await saveCheckin(f.raw,vault,1,'2026-11-01',{value,baseRevision:0,clientKey:key()});value.items[0].note='corrected';await saveCheckin(f.raw,vault,1,'2026-11-01',{value,baseRevision:1,clientKey:key()});
    const service=runRequestContext(f.env,f.db,()=>LifeBackupService());const token=await new SignJWT({id:1}).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(new TextEncoder().encode(f.env.JWT_SECRET));
    const response=await runRequestContext(f.env,f.db,()=>service.handle(new Request('http://localhost/life/backup?version=5',{headers:{Authorization:'Bearer '+token}})));expect(response.status,await response.clone().text()).toBe(200);
    const backup=await validateBackup(await response.json(),1);expect(backup.counts.lifeCheckins).toBe(1);expect(backup.counts.lifeCheckinRevisions).toBe(2);
    backup.data.lifeCheckinDraftCopies=[{ownerId:1,recordDate:'2026-11-01',updatedAt:Date.now(),record:withoutCheckinGrants(value)}];backup.counts.lifeCheckinDraftCopies=1;backup.sha256=await reportDigest(JSON.stringify(backup.data));await validateBackup(backup,1);
    const json=JSON.stringify(backup);for(const forbidden of [secret,f.env.JWT_SECRET,'sealedJson','contentHmac','clientKey\":'])expect(json).not.toContain(forbidden);
    const encrypted=await encryptBackup(backup,'synthetic-long-backup-passphrase');const decoded=await decryptBackup(encrypted,'synthetic-long-backup-passphrase',1);
    const row=decoded.data.lifeCheckins[0] as CheckinBackupRow;expect(row.record).toMatchObject({state:'draft',items:[{note:'corrected',email:false,ai:false}],meals:[{email:false,ai:false}]});
    expect(decoded.data.lifeCheckinDraftCopies).toHaveLength(1);
    const restored=fixture();try{
      restored.sqlite.exec("INSERT INTO life_report_ai_budget(month,reserved_fen) VALUES('2026-11',995)");
      const newVault=await checkinVault(btoa(String.fromCharCode(...Array.from({length:32},(_,i)=>255-i))));
      expect(await saveCheckin(restored.raw,newVault,1,row.recordDate,{value:row.record,baseRevision:0,clientKey:key()})).toMatchObject({saved:true});expect((await readCheckin(restored.raw,newVault,1,row.recordDate))?.value).toEqual(row.record);expect(restored.sqlite.prepare('SELECT reserved_fen FROM life_report_ai_budget').get().reserved_fen).toBe(995);
    }finally{restored.sqlite.close();}
    const altered=structuredClone(backup);(altered.data.lifeCheckins[0] as CheckinBackupRow).record.items[0].ai=true;altered.sha256=await reportDigest(JSON.stringify(altered.data));await expect(validateBackup(altered,1)).rejects.toThrow();
    expect(()=>validateCheckinBackup([row],[row,row],1)).toThrow();
    f.env.LIFE_CHECKIN_KEY=undefined;const lost=await runRequestContext(f.env,f.db,()=>service.handle(new Request('http://localhost/life/backup?version=5',{headers:{Authorization:'Bearer '+token}})));expect(lost.status).toBe(503);expect(f.sqlite.prepare('SELECT count(*) AS n FROM life_checkins').get().n).toBe(1);
  }finally{f.sqlite.close();}
});
it('preserves source identity, rejects duplicate and cross-owner references without changing original projects',async()=>{
  const f=fixture();try{f.sqlite.exec("INSERT INTO habits(id,owner_id,name) VALUES(101,1,'owned fixture'),(102,2,'other fixture')");const value=sample();value.items[0].source={kind:'habit',id:102};const rejected=await f.request(1,'/2026-10-30',{record:value,baseRevision:0,clientKey:key()});expect(rejected.status).toBe(400);expect(f.sqlite.prepare('SELECT count(*) AS n FROM life_checkins').get().n).toBe(0);
    value.items[0].source.id=101;expect((await f.request(1,'/2026-10-30',{record:value,baseRevision:0,clientKey:key()})).status).toBe(200);expect(f.sqlite.prepare('SELECT name FROM habits WHERE id=101').get().name).toBe('owned fixture');expect(projectCheckin(value,'2026-10-30','email')?.items[0]).not.toHaveProperty('source');value.items.push({...value.items[0],key:key()});expect(()=>checkinValue(value,'2026-10-30')).toThrow();
  }finally{f.sqlite.close();}
});
it('does not overwrite an unreadable record with a syntactically valid wrong key or leave partial history after failure',async()=>{
  const f=fixture();try{const vault=await checkinVault(secret),value=sample();await saveCheckin(f.raw,vault,1,'2026-11-01',{value,baseRevision:0,clientKey:key()});value.items[0].note='new';const wrong=await checkinVault(btoa(String.fromCharCode(...Array.from({length:32},(_,i)=>255-i))));await expect(saveCheckin(f.raw,wrong,1,'2026-11-01',{value,baseRevision:1,clientKey:key()})).rejects.toThrow();
    await expect(saveCheckin(f.raw,wrong,1,'2026-10-30',{value,baseRevision:0,clientKey:key()})).rejects.toThrow();expect(f.sqlite.prepare('SELECT count(*) AS n FROM life_checkins').get().n).toBe(1);
    f.sqlite.exec("CREATE TRIGGER checkin_failure BEFORE INSERT ON life_checkin_revisions WHEN NEW.revision=2 BEGIN SELECT RAISE(ABORT,'fixture failure'); END");await expect(saveCheckin(f.raw,vault,1,'2026-11-01',{value,baseRevision:1,clientKey:key()})).rejects.toThrow();expect((await readCheckin(f.raw,vault,1,'2026-11-01'))?.revision).toBe(1);expect(f.sqlite.prepare('SELECT count(*) AS n FROM life_checkin_revisions').get().n).toBe(1);
  }finally{f.sqlite.close();}
});
