// Loopback-only fallback when this Windows installation cannot launch headless.
// Serves the REAL production bundle with wholly fictional in-page API fixtures.
// This server/test bootstrap is never copied to client/public or deployed.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../client/dist');
const boot=`
const fixtureOwner=new URLSearchParams(location.search).get('qaOwner')==='2'?2:1;
document.cookie='token=x.'+(fixtureOwner===2?'eyJpZCI6Mn0':'eyJpZCI6MX0')+'.x; Path=/; SameSite=Strict';
localStorage.setItem('shjdshy-life-profile',JSON.stringify({id:fixtureOwner,name:'合成验收账号',role:'owner',permission:1,canWrite:true,avatar:''}));
const actualFetch=window.fetch.bind(window);
const qaMode=new URLSearchParams(location.search).get('qaMode');
window.fixtureCalls=[];
const qaReport={version:1,ownerId:fixtureOwner,generatedAt:'2026-11-02T00:00:00.000Z',period:{kind:'daily',timezone:'Asia/Shanghai',fromDate:'2026-11-01',toDateExclusive:'2026-11-02',start:'2026-10-31T16:00:00.000Z',end:'2026-11-01T16:00:00.000Z'},coverage:'server-synced-only',mode:'statistics-preview',achievementsRecorded:2,tasksCompleted:1,ideasCreated:0,focus:{completedSessions:1,recordedMinutes:25,earlySessions:0},habitCompletions:1,daysWithNotes:0,aiEnabled:false,emailEnabled:false};
const qaRecord={version:1,state:'confirmed',items:[{key:'11111111-1111-4111-8111-111111111111',kind:'habit',source:null,name:'合成钢琴练习',result:'done',note:'合成短练习',email:true,ai:true}],meals:[{key:'22222222-2222-4222-8222-222222222222',kind:'eaten',description:'合成蔬菜与主食',portion:'合成一份',email:true,ai:true}],sleep:{bedAt:'2026-11-01T00:15:00+08:00',wakeAt:'2026-11-01T08:00:00+08:00',email:true,ai:true},targets:{bedMinute:null,wakeMinute:null}};
const qaSnapshot={version:1,scopeVersion:2,archiveOnly:true,generatedAt:qaReport.generatedAt,fromDate:'2026-11-01',toDateExclusive:'2026-11-02',rangeFrom:'2026-10-26',entries:[{date:'2026-11-01',revision:1,updatedAt:1793534400,record:qaRecord}],current:{asOf:qaReport.generatedAt,pendingTasks:2,todos:[]},reading:{markedRead:3,starred:1}};
const aiKey='fixture-ai:'+fixtureOwner+':'+(qaMode||'default');
const qaAnalysis={version:1,summary:'这是合成数据的四模块观察。',modules:{habits:{status:'observed',observations:[{text:'合成钢琴练习已有完成记录。',evidence:['H1']}],actions:['可以延续一个短练习。']},checkins:{status:'insufficient',observations:[],actions:[]},diet:{status:'observed',observations:[{text:'只按记录观察，不推算热量。',evidence:['D1']}],actions:[]},routine:{status:'observed',observations:[{text:'这是本人上床与起床时刻，不是实际睡眠测量。',evidence:['R1']}],actions:[]}}};
const showCounts=()=>{let e=document.getElementById('fixture-ai-count');if(!e){e=document.createElement('output');e.id='fixture-ai-count';e.setAttribute('aria-label','合成调用计数');document.body.appendChild(e);}e.textContent='模拟 AI 提交 '+(JSON.parse(localStorage.getItem(aiKey)||'null')?.calls||0)+' 次；真实外部请求 0 次';};
document.addEventListener('DOMContentLoaded',showCounts);
window.fetch=async(input,init={})=>{
 const u=new URL(typeof input==='string'?input:input.url,location.href);
 if(u.origin===location.origin)return actualFetch(input,init);
 if(u.origin!=='https://rin-server.1322589722.workers.dev')throw Error('External network disabled in fixture');
 window.fixtureCalls.push({path:u.pathname,method:init.method||'GET'});
 const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
 if(u.pathname==='/user/profile')return reply({id:fixtureOwner,username:'合成验收账号',role:'owner',permission:1,canWrite:true});
 if(u.pathname.startsWith('/config'))return reply({});
 if(u.pathname==='/life/todos'||u.pathname==='/habit')return reply([]);
 if(u.pathname.startsWith('/life/reports/')){
  const p=u.pathname.slice('/life/reports'.length),base={ownerId:fixtureOwner};
  if(p==='/preview')return reply(qaReport);
  if(p==='/settings')return reply({...base,preferences:{dailyTime:'08:00',weeklyTime:'08:00',weeklyDay:1,revision:1,dailyEnabled:false,weeklyEnabled:false}});
  if(p==='/status')return reply({...base,deepseekConfigured:true,apiVerified:false,aiEnabled:false,emailEnabled:false,automationEnabled:false,monthlyBudgetFen:1000,reservedMonthlyFen:5,manualAIAvailable:true,schedulerAvailable:true});
  if(p==='/history')return reply({...base,items:[{id:11,kind:'daily',period_start:1793462400,period_end:1793548800,created_at:1793577600}],nextBefore:null});
  if(p==='/history/11')return reply({...base,id:11,report:qaReport});
  if(p==='/history/11/analysis')return reply({...base,reportId:11,state:'none',analysis:null,reason:'checkin-scope-required'});
  if(p==='/history/11/checkin-analysis'){
   if(qaMode==='key-off')return reply({code:'KEY_UNAVAILABLE'},503);
   let stored=JSON.parse(localStorage.getItem(aiKey)||'null');
   if(init.method==='POST'){const b=JSON.parse(init.body);if(b.scopeVersion!==2||b.allowSelectedModules!==true)return reply({},422);if(!stored){stored={state:qaMode==='result-unknown'?'unknown':'succeeded',calls:1};localStorage.setItem(aiKey,JSON.stringify(stored));showCounts();}}
   const state=stored?.state||'none';return reply({...base,reportId:11,scopeVersion:2,report:qaReport,snapshot:qaMode==='legacy'?null:qaSnapshot,state,analysis:state==='succeeded'?qaAnalysis:null,reason:state==='unknown'?'unavailable':null,available:!stored&&!['withdrawn','archive','legacy'].includes(qaMode),unavailableReason:['withdrawn','archive'].includes(qaMode)?'scope-changed':null,requestBytes:3500,mailSafe:true});
  }
  if(p==='/history/11/checkins')return qaMode==='key-off'?reply({code:'KEY_UNAVAILABLE'},503):reply({...base,reportId:11,report:qaReport,details:qaMode==='legacy'?null:{current:qaMode!=='withdrawn'&&qaMode!=='archive',archived:qaMode==='archive',snapshot:qaSnapshot}});
  if(p==='/jobs'||p==='/mail/deliveries')return reply({...base,items:[]});
  if(p==='/mail')return reply({...base,storageConfigured:false,deliveryConfigured:false,maskedRecipient:null,verified:false,enabled:false});
  if(p==='/ai-automation')return reply({...base,enabled:false,revision:0,enabledAt:null,scope:'statistics',configured:true,pricingValid:true,monthlyBudgetFen:1000,reservedMonthlyFen:5});
 }
 if(u.pathname==='/life/checkins/status')return reply({ownerId:fixtureOwner,configured:new URLSearchParams(location.search).get('qaMode')!=='key-off'});
 if(u.pathname==='/life/checkins')return reply({ownerId:fixtureOwner,items:[],nextBefore:null});
 if(u.pathname.endsWith('/revisions')){const base=u.pathname.replace('/revisions',''),r=JSON.parse(localStorage.getItem('fixture-cloud:'+fixtureOwner+':'+base)||'null');return reply({ownerId:fixtureOwner,date:base.split('/').pop(),items:r?[{revision:r.revision,updatedAt:Math.floor(r.updatedAt),record:r.value}]:[]});}
 if(u.pathname.startsWith('/life/checkins/')){
  if(new URLSearchParams(location.search).get('qaMode')==='offline')return reply({code:'SYNTHETIC_OFFLINE'},503);
  const key='fixture-cloud:'+fixtureOwner+':'+u.pathname,record=JSON.parse(localStorage.getItem(key)||'null');
  if(init.method==='POST'){const b=JSON.parse(init.body);if(b.baseRevision!==(record?.revision??0))return reply({ownerId:fixtureOwner,saved:false},409);const next={value:b.record,revision:b.baseRevision+1,updatedAt:Date.now()/1000};localStorage.setItem(key,JSON.stringify(next));return reply({ownerId:fixtureOwner,saved:true,revision:next.revision});}
  return reply({ownerId:fixtureOwner,record});
 }
 return reply({});
};
`;
http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');if(url.pathname==='/qa-boot.js'){res.setHeader('Content-Type','text/javascript; charset=utf-8');return res.end(boot);}
 if(url.pathname==='/sw.js'){res.writeHead(404);return res.end();}
 const target=path.resolve(root,'.'+decodeURIComponent(url.pathname));if(target!==root&&!target.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
 if(fs.existsSync(target)&&fs.statSync(target).isFile()){res.setHeader('Content-Type',target.endsWith('.js')?'text/javascript':target.endsWith('.css')?'text/css':'application/octet-stream');return fs.createReadStream(target).pipe(res);}
 const index=fs.readFileSync(path.join(root,'index.html'),'utf8').replace('<head>','<head><script src="/qa-boot.js"></script>').replace(/<link[\s\S]*?href="https:[\s\S]*?>/g,'');res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',"connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-src 'none'");res.end(index);
}).listen(Number(process.env.CHECKIN_QA_PORT||4176),'127.0.0.1',()=>console.log('Synthetic check-in preview ready'));
