// Real workerd D1, ephemeral database only. No production or provider access.
const {createRequire}=require('node:module'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const local=createRequire(path.resolve('../site/package.json')),{DatabaseSync}=require('node:sqlite'),{Miniflare,convertV4MiniflareOptions}=local('miniflare');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'private-brief-d1-')),compiled=path.join(temp,'helper.cjs');
local('esbuild').buildSync({stdin:{contents:"export {checkinVault} from './server/src/utils/checkin-vault';export {emptyCheckin} from './server/src/utils/checkin-format';export {saveCheckin} from './server/src/utils/checkin-store';export {saveReportWithCheckins,readReportCheckins} from './server/src/utils/report-checkin-snapshot';export {readReportBrief} from './server/src/utils/report-brief-snapshot';export {reportWindow} from './server/src/utils/life-report';export {prepareReportMail} from './server/src/utils/report-mail-prepare';export {submitReportDelivery} from './server/src/utils/report-mail-delivery';export {reportMailVault} from './server/src/utils/report-mail-vault';export {saveReportRecipient} from './server/src/utils/report-mail-contacts';export {setBriefConsent} from './server/src/utils/report-brief-consent';export {setSelectedAIConsent} from './server/src/utils/selected-ai-consent';export {runSelectedAISchedule} from './server/src/utils/selected-ai-schedule';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile:compiled});
const {checkinVault,emptyCheckin,saveCheckin,saveReportWithCheckins,readReportCheckins,readReportBrief,reportWindow}=require(compiled);
(async()=>{
 const sqlite=new DatabaseSync(':memory:');for(const name of fs.readdirSync('server/sql').filter(s=>s.endsWith('.sql')).sort()){sqlite.exec(fs.readFileSync('server/sql/'+name,'utf8'));if(name==='0002.sql')sqlite.exec('ALTER TABLE feeds ADD COLUMN top INTEGER DEFAULT 0');}
 const ddl=sqlite.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,name").all().map(r=>r.sql);sqlite.close();
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("isolated private brief")}}',compatibilityDate:'2024-09-23',d1Databases:{DB:'isolated-private-brief'},d1Persist:false}));
 try{
  const db=await mf.getD1Database('DB');for(const sql of ddl)await db.prepare(sql).run();
  await db.prepare("INSERT INTO users(id,username,openid,permission) VALUES(1,'fixture','fixture',1),(2,'other','other',1)").run();
  await db.prepare("INSERT INTO daily_basics(owner_id,date,content) VALUES(1,'2026-11-04','synthetic private planned name')").run();
  await db.prepare("INSERT INTO life_todos(owner_id,content,type,completed) VALUES(1,'synthetic private pending title','task',0)").run();
  await db.prepare("INSERT INTO rss_subscriptions(id,owner_id,title,category,feed_url,source_url) VALUES(1,1,'synthetic private alias','音乐','https://invalid.test/1','https://invalid.test/1')").run();
  const now=new Date('2026-11-04T00:00:00Z'),period=reportWindow('daily',now),key=btoa(String.fromCharCode(...Array.from({length:32},(_,i)=>i+33))),vault=await checkinVault(key),record=emptyCheckin();record.state='confirmed';
  await saveCheckin(db,vault,1,'2026-11-03',{value:record,baseRevision:0,clientKey:crypto.randomUUID()},now.getTime()-3600000);
  await db.prepare("INSERT INTO rss_items(owner_id,subscription_id,external_id,title,url,published_at,created_at,discovery_kind) VALUES(1,1,'abcdefghijk','synthetic article','https://invalid.test/item',0,?,'feed')").bind(now.getTime()/1000-60).run();
  const save=()=>saveReportWithCheckins(db,vault,1,period,now,undefined,{scheduledFor:now}),raced=await Promise.all(Array.from({length:5},save));
  assert.equal(new Set(raced.map(r=>r.id)).size,1);assert.equal((await db.prepare('SELECT count(*) n FROM life_report_briefs').first()).n,1);
  const saved=raced[0],brief=await readReportBrief(db,vault,1,saved);assert.equal(brief.facts.today.priorities.items[0].name,'synthetic private planned name');assert.equal(brief.rss.updates.items,1);
  assert.equal(JSON.stringify(await db.prepare('SELECT * FROM life_report_briefs').first()).includes('synthetic private'),false);await assert.rejects(()=>readReportBrief(db,vault,2,saved));
  await saveCheckin(db,vault,1,'2026-11-03',{value:emptyCheckin(),baseRevision:1,clientKey:crypto.randomUUID()},now.getTime()+1000);assert.equal((await readReportCheckins(db,vault,1,saved)).current,false);
  await db.prepare("CREATE TRIGGER brief_test_abort BEFORE INSERT ON life_report_briefs BEGIN SELECT RAISE(ABORT,'synthetic transaction stop'); END").run();
  const next=new Date(now.getTime()+86400000);await assert.rejects(()=>saveReportWithCheckins(db,vault,1,reportWindow('daily',next),next,undefined,{scheduledFor:next}));
  assert.equal((await db.prepare('SELECT count(*) n FROM life_reports').first()).n,1);assert.equal((await db.prepare('SELECT count(*) n FROM life_report_checkin_snapshots').first()).n,1);assert.equal((await db.prepare('SELECT count(*) n FROM life_report_brief_consent').first()).n,0);
  // Fresh occurrence for real D1 encrypted queue/claim/admission concurrency.
  // Local mock provider only; no SMTP/HTTP provider is imported or configured.
  await db.prepare('DROP TRIGGER brief_test_abort').run();
  const {prepareReportMail,submitReportDelivery,reportMailVault,saveReportRecipient,setBriefConsent,setSelectedAIConsent,runSelectedAISchedule}=require(compiled);
  const live=new Date(Math.floor(Date.now()/1000)*1000),sec=Math.floor(live.getTime()/1000),owner=2,mailVault=await reportMailVault(btoa(String.fromCharCode(...Array.from({length:32},(_,i)=>i+1))));
  await db.prepare("INSERT INTO life_report_preferences(owner_id,email_enabled,daily_enabled) VALUES(2,1,1)").run();
  await saveReportRecipient({db,ownerId:owner,email:'fixture@example.invalid',baseRevision:0,vault:mailVault,now:live});
  await db.prepare('UPDATE life_report_preferences SET email_enabled=1 WHERE owner_id=2').run();
  await db.prepare('UPDATE life_report_mail_contacts SET verified_at=?,enabled_at=? WHERE owner_id=2').bind(sec-60,sec-60).run();
  await setBriefConsent({db,owner,enabled:true,baseRevision:0,allowNamedMail:true,now:new Date(live.getTime()-60000)});
  await setSelectedAIConsent({db,owner,enabled:true,baseRevision:0,allowSelectedAnalysis:true,now:new Date(live.getTime()-60000)});
  const approved=emptyCheckin();approved.state='confirmed';approved.items=[{key:crypto.randomUUID(),kind:'habit',source:null,name:'synthetic approved practice',result:'done',note:'',email:true,ai:true}];
  await saveCheckin(db,vault,owner,reportWindow('daily',live).fromDate,{value:approved,baseRevision:0,clientKey:crypto.randomUUID()},live.getTime()-1000);
  await db.prepare("INSERT INTO life_todos(owner_id,content,type,completed) VALUES(2,'synthetic encrypted queued task','task',0)").run();
  const current=await saveReportWithCheckins(db,vault,owner,reportWindow('daily',live),live,undefined,{scheduledFor:live});
  const job='f'.repeat(64);
  await db.prepare("INSERT INTO life_report_jobs(job_key,owner_id,kind,period_start,period_end,anchor_at,include_daily,state,report_id) VALUES(?,2,'daily',?,?,?,0,'ready',?)").bind(job,Date.parse(current.report.period.start)/1000,Date.parse(current.report.period.end)/1000,sec,current.id).run();
  let mockAI=0;const analysis={version:1,summary:'Synthetic selected analysis',modules:{habits:{status:'observed',observations:[{text:'A practice was recorded.',evidence:['H1']}],actions:[]},checkins:{status:'insufficient',observations:[],actions:[]},diet:{status:'insufficient',observations:[],actions:[]},routine:{status:'insufficient',observations:[],actions:[]}}};
  await Promise.all(Array.from({length:5},()=>runSelectedAISchedule({db,vault,apiKey:'fixture-not-a-key',now:live,fetcher:async()=>{mockAI++;return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(analysis)}}]});}})));
  assert.equal(mockAI,1);assert.equal((await db.prepare('SELECT reserved_fen FROM life_report_ai_budget').first()).reserved_fen,5);
  const options={db,ownerId:owner,jobKey:job,providerIdentity:'mock-private',checkinVault:vault,now:live};
  const prepared=await Promise.all(Array.from({length:5},()=>prepareReportMail(options)));assert.ok(prepared.every(r=>r.key===prepared[0].key));
  assert.equal((await db.prepare('SELECT count(*) n FROM life_report_private_messages').first()).n,1);
  assert.equal(JSON.stringify(await db.prepare('SELECT * FROM life_report_private_messages').first()).includes('synthetic encrypted'),false);
  let submissions=0;const provider={identity:'mock-private',async submit(message){submissions++;assert.ok(message.text.includes('synthetic encrypted queued task'));assert.ok(message.text.includes(analysis.summary));return {state:'unknown'};}};
  await Promise.all(Array.from({length:5},()=>submitReportDelivery({db,ownerId:owner,key:prepared[0].key,vault:mailVault,checkinVault:vault,provider,now:live})));
  assert.equal(submissions,1);assert.equal((await db.prepare('SELECT count(*) n FROM life_report_mail_admissions').first()).n,1);
  await setBriefConsent({db,owner,enabled:false,baseRevision:1,now:live});
  assert.equal((await prepareReportMail(options)).state,'unknown');assert.equal(submissions,1);
  console.log('Real D1: 5 captures / 1 commit; 5 selected AI ticks / 1 mock call / 5fen; encrypted result into fixed mail; 5 preparations / 1 sidecar; 5 submits / 1 mock admission; unknown retained; withdrawal/rollback; 0 external sends/AI');
 }finally{await mf.dispose();}
})().catch(error=>{console.error(error);process.exitCode=1;});
