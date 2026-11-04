// Real workerd D1, ephemeral database only. No production or provider access.
const {createRequire}=require('node:module'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const local=createRequire(path.resolve('../site/package.json')),{DatabaseSync}=require('node:sqlite'),{Miniflare,convertV4MiniflareOptions}=local('miniflare');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'private-brief-d1-')),compiled=path.join(temp,'helper.cjs');
local('esbuild').buildSync({stdin:{contents:"export {checkinVault} from './server/src/utils/checkin-vault';export {emptyCheckin} from './server/src/utils/checkin-format';export {saveCheckin} from './server/src/utils/checkin-store';export {saveReportWithCheckins,readReportCheckins} from './server/src/utils/report-checkin-snapshot';export {readReportBrief} from './server/src/utils/report-brief-snapshot';export {reportWindow} from './server/src/utils/life-report';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile:compiled});
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
  console.log('Real D1 private brief: 5 captures / 1 commit; names encrypted; owner/purpose binding; withdrawal and full rollback; 0 sends/AI calls');
 }finally{await mf.dispose();}
})().catch(error=>{console.error(error);process.exitCode=1;});
