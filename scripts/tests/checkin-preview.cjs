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
window.fetch=async(input,init={})=>{
 const u=new URL(typeof input==='string'?input:input.url,location.href);
 if(u.origin===location.origin)return actualFetch(input,init);
 if(u.origin!=='https://rin-server.1322589722.workers.dev')throw Error('External network disabled in fixture');
 const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
 if(u.pathname==='/user/profile')return reply({id:fixtureOwner,username:'合成验收账号',role:'owner',permission:1,canWrite:true});
 if(u.pathname.startsWith('/config'))return reply({});
 if(u.pathname==='/life/todos'||u.pathname==='/habit')return reply([]);
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
