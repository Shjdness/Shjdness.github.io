// Real Miniflare/workerd D1 semantics, disposable in-memory database only.
const {createRequire}=require('node:module'),path=require('node:path'),fs=require('node:fs'),os=require('node:os'),assert=require('node:assert/strict');
const local=createRequire(path.resolve('../site/package.json'));
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'checkin-d1-')),compiled=path.join(dir,'helper.cjs');
local('esbuild').buildSync({stdin:{contents:"export {checkinVault} from './server/src/utils/checkin-vault';export {emptyCheckin} from './server/src/utils/checkin-format';export {saveCheckin,readCheckin} from './server/src/utils/checkin-store';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile:compiled});
const {checkinVault,emptyCheckin,saveCheckin,readCheckin}=require(compiled),{Miniflare,convertV4MiniflareOptions}=local('miniflare');
(async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("isolated check-in fixture")}}',compatibilityDate:'2024-09-23',d1Databases:{DB:'isolated-checkins'},d1Persist:false}));
 try{
  const db=await mf.getD1Database('DB');for(const ddl of ['CREATE TABLE users(id INTEGER PRIMARY KEY)','CREATE TABLE info(key TEXT PRIMARY KEY,value TEXT)','CREATE TABLE rss_write_budget(day TEXT PRIMARY KEY,reserved INTEGER)'])await db.prepare(ddl).run();await db.prepare('INSERT INTO users VALUES(1),(2)').run();
  const sql=fs.readFileSync('server/sql/0032-life-checkins.sql','utf8');for(const ddl of sql.match(/CREATE TABLE IF NOT EXISTS [\s\S]*?\);/g))await db.prepare(ddl).run();for(const ddl of sql.match(/CREATE TRIGGER IF NOT EXISTS [\s\S]*?END;/g))await db.prepare(ddl).run();
  const secret=btoa(String.fromCharCode(...Array.from({length:32},(_,i)=>i+1))),vault=await checkinVault(secret),record=emptyCheckin();record.items=[{key:crypto.randomUUID(),kind:'checkin',source:null,name:'synthetic',result:'unrecorded',note:'',email:false,ai:false}];
  const input={value:record,clientKey:crypto.randomUUID(),baseRevision:0},date='2026-11-01';
  const retries=await Promise.all(Array.from({length:5},()=>saveCheckin(db,vault,1,date,input)));assert.ok(retries.every(r=>r.saved));assert.equal((await readCheckin(db,vault,1,date)).revision,1);assert.equal(await readCheckin(db,vault,2,date),null);
  const raced=await Promise.all(Array.from({length:5},(_,n)=>saveCheckin(db,vault,1,date,{value:{...record,items:record.items.map(i=>({...i,note:'synthetic '+n}))},clientKey:crypto.randomUUID(),baseRevision:1})));assert.equal(raced.filter(r=>r.saved).length,1);
  for(let n=2;n<14;n++)await saveCheckin(db,vault,1,date,{value:{...record,items:record.items.map(i=>({...i,note:'next '+n}))},clientKey:crypto.randomUUID(),baseRevision:n});
  assert.equal((await db.prepare('SELECT count(*) AS n FROM life_checkin_revisions').first()).n,10);
  await db.prepare("CREATE TRIGGER fixture_fail BEFORE INSERT ON life_checkin_revisions WHEN NEW.revision=15 BEGIN SELECT RAISE(ABORT,'fixture'); END").run();await assert.rejects(()=>saveCheckin(db,vault,1,date,{value:{...record,items:record.items.map(i=>({...i,note:'fail'}))},clientKey:crypto.randomUUID(),baseRevision:14}));assert.equal((await readCheckin(db,vault,1,date)).revision,14);
  console.log(JSON.stringify({passed:true,realIsolatedD1:true,samePayloadConcurrent:5,distinctEditsWinning:1,retainedRevisions:10,triggerFailureRolledBack:true,productionWrites:0,externalCalls:0}));
 }finally{await mf.dispose();}
})().catch(e=>{console.error(e);process.exitCode=1;});
