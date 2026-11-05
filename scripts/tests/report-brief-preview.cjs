// Loopback-only actual React component + synthetic backend. No real tokens/data.
const http=require('node:http'),path=require('node:path'),{createRequire}=require('node:module');
const local=createRequire(path.resolve('../site/package.json'));
(async()=>{
 const bundle=await local('esbuild').build({stdin:{resolveDir:process.cwd(),sourcefile:'brief-preview.tsx',loader:'tsx',contents:`
import React,{StrictMode,useState} from 'react';import {createRoot} from 'react-dom/client';
import {ReportBriefSettings} from './client/src/features/life/report-brief-settings';
let writes=0;const owners=new Map();const stats=()=>{document.getElementById('counts').textContent='设置写入 '+writes+'；AI/邮件外调 0';};
window.fetch=async(url,options={})=>{
 if(!String(url).endsWith('/life/reports/brief-mail'))throw Error('External access blocked');
 const owner=Number(String(options.headers.Authorization).includes('fixture-2')?2:1);
 const state=owners.get(owner)||{ownerId:owner,scopeVersion:3,enabled:false,revision:0,enabledAt:null,configured:true,paused:false};
 if(options.method==='POST'){const value=JSON.parse(options.body);if(value.baseRevision!==state.revision)return Response.json({}, {status:409});writes++;state.enabled=value.enabled;state.revision++;state.enabledAt=value.enabled?123:null;owners.set(owner,state);stats();return Response.json({...state,saved:true});}
 return Response.json(state);
};
function App(){const [owner,setOwner]=useState(1);document.cookie='token=fixture-'+owner+'; Path=/';return <><nav><button onClick={()=>setOwner(n=>n===1?2:1)}>切换合成账号</button><button onClick={()=>{const s=owners.get(owner);if(s){s.configured=false;owners.set(owner,s);}document.getElementById('key').textContent='模拟 Key 已丢失';}}>模拟 Key 丢失</button><span id="key"/></nav><p id="counts">设置写入 0；AI/邮件外调 0</p><ReportBriefSettings key={owner} ownerId={owner} token={'fixture-'+owner}/></>}
createRoot(document.getElementById('root')).render(<StrictMode><App/></StrictMode>);
`},bundle:true,nodePaths:[path.resolve('client/node_modules')],write:false,format:'iife',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'only-endpoint',setup(build){build.onResolve({filter:/^\.\.\/\.\.\/main$/},()=>({path:'endpoint',namespace:'fixture'}));build.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:"export const endpoint='https://fixture.invalid';",loader:'js'}));}}]});
 const js=bundle.outputFiles[0].contents;
 http.createServer((req,res)=>{if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');return res.end(js);}res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>完整明细邮件 · 合成验收</title><style>*{box-sizing:border-box}body{margin:0;padding:16px;font:16px/1.6 system-ui;color:#e3edf7;background:#122d45}section{max-width:960px;padding:20px;border:1px solid #476079;border-radius:20px;background:#29465c88}header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}h2{margin:0}button{padding:10px;margin:4px;border-radius:12px;border:1px solid #8395a7;background:#284354;color:inherit}button:disabled{opacity:.45}label{display:block;margin:16px 0}input{margin-right:8px}p{overflow-wrap:anywhere}</style><nav>本机合成界面，非生产账号</nav><div id="root"></div><script src="/bundle.js"></script></html>');}).listen(4193,'127.0.0.1',()=>console.log('Synthetic brief settings ready on 4193'));
})().catch(error=>{console.error(error);process.exitCode=1;});
