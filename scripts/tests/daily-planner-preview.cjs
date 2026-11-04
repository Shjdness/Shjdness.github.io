// Loopback-only synthetic UI fixture. No live credentials or production data.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../client/dist');
const boot=`
const owner=new URLSearchParams(location.search).get('qaOwner')==='2'?2:1;
document.cookie='token=x.'+(owner===2?'eyJpZCI6Mn0':'eyJpZCI6MX0')+'.x; Path=/; SameSite=Strict';
localStorage.setItem('shjdshy-life-profile',JSON.stringify({id:owner,name:'合成验收账号',role:'owner',permission:1,canWrite:true,avatar:''}));
const nativeFetch=window.fetch.bind(window),key='daily-plan-fixture:'+owner;
const state=()=>JSON.parse(localStorage.getItem(key)||'[]');
const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
window.fetch=async(url,init={})=>{
 const u=new URL(typeof url==='string'?url:url.url,location.origin),method=init.method||'GET';
 if(u.origin===location.origin)return nativeFetch(url,init);
 if(u.origin!=='https://rin-server.1322589722.workers.dev')throw Error('External access blocked in synthetic fixture');
 if(u.pathname==='/user/profile')return reply({id:owner,username:'合成验收账号',role:'owner',permission:1,canWrite:true});
 if(u.pathname.startsWith('/config'))return reply({});
 if(u.pathname==='/life/todos')return reply([{id:1,content:'合成待办：练琴',type:'task',completed:0}]);
 if(u.pathname==='/life/calendar')return reply({habits:[],logs:[],sessions:[],notes:[],basics:state()});
 if(u.pathname==='/life/basics'){
  const rows=state();if(method==='GET'){
   if(new URLSearchParams(location.search).has('qaOffline'))return reply({},503);
   return reply(rows.filter(r=>r.date>=u.searchParams.get('from')&&r.date<=u.searchParams.get('to')));
  }
  const b=JSON.parse(init.body);if(rows.filter(r=>r.date===b.date).length>=3)return reply({message:'这个日期已有三件事'},409);
  const row={...b,id:Date.now(),completed:0,revision:0};delete row.localId;rows.push(row);localStorage.setItem(key,JSON.stringify(rows));return reply({insertedId:row.id});
 }
 if(u.pathname.startsWith('/life/basics/')){
  const id=Number(u.pathname.split('/')[3]),rows=state(),row=rows.find(r=>r.id===id);
  if(!row)return reply({},404);if(method==='DELETE'){localStorage.setItem(key,JSON.stringify(rows.filter(r=>r.id!==id)));return reply('OK');}
  const b=JSON.parse(init.body);
  if(u.pathname.endsWith('/reorder')){
   const day=rows.filter(r=>r.date===row.date).sort((a,b)=>a.sortOrder-b.sortOrder||a.id-b.id),i=day.findIndex(r=>r.id===id),j=i+b.direction;
   if(j>=0&&j<day.length){[day[i],day[j]]=[day[j],day[i]];day.forEach((r,k)=>{r.sortOrder=k;r.revision++;});}
  }else{Object.assign(row,b,{revision:row.revision+1});}
  localStorage.setItem(key,JSON.stringify(rows));return reply({saved:true,revision:row.revision});
 }
 if(u.pathname==='/habit')return reply([]);
 if(u.pathname==='/reliability/capabilities')return reply({version:2,conflictAcknowledgement:true});
 return reply({});
};
`;
http.createServer((req,res)=>{
 const u=new URL(req.url,'http://localhost');
 if(u.pathname==='/qa-boot.js'){res.setHeader('Content-Type','text/javascript; charset=utf-8');return res.end(boot);}
 if(u.pathname==='/sw.js'){res.writeHead(404);return res.end();}
 const target=path.resolve(root,'.'+decodeURIComponent(u.pathname));if(target!==root&&!target.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
 if(fs.existsSync(target)&&fs.statSync(target).isFile()){res.setHeader('Content-Type',target.endsWith('.js')?'text/javascript':target.endsWith('.css')?'text/css':'application/octet-stream');return fs.createReadStream(target).pipe(res);}
 const html=fs.readFileSync(path.join(root,'index.html'),'utf8').replace('<head>','<head><script src="/qa-boot.js"></script>').replace(/<link[\s\S]*?href="https:[\s\S]*?>/g,'');
 res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',"connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-src 'none'");res.end(html);
}).listen(4192,'127.0.0.1',()=>console.log('Synthetic daily planner ready on 4192'));
