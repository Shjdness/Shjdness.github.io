// Synthetic browser acceptance only; all non-local traffic is intercepted.
const puppeteer=require('puppeteer');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const base=process.env.WORKSPACE_QA_URL||'http://127.0.0.1:4175';
if(!['127.0.0.1','localhost'].includes(new URL(base).hostname))throw Error('Local preview required');
const output=process.env.CHECKIN_QA_OUTPUT||fs.mkdtempSync(path.join(os.tmpdir(),'life-checkin-'));fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',args:['--no-sandbox']});
 try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  let record=null,posts=0,offline=false,configured=true,owner=1;
  await page.setViewport({width:1440,height:1000});await page.setCookie({name:'token',value:'x.eyJpZCI6MX0.x',url:base});
  await page.evaluateOnNewDocument(()=>{if(!localStorage.getItem('theme'))localStorage.setItem('theme','dark');});
  await page.setRequestInterception(true);
  page.on('request',async r=>{
   if(r.url().startsWith(base))return r.continue();
   if(!r.url().startsWith('https://rin-server.1322589722.workers.dev'))return r.abort();
   const u=new URL(r.url()),headers={'access-control-allow-origin':base,'access-control-allow-headers':'authorization,content-type','access-control-allow-methods':'GET,POST,OPTIONS'};
   const send=(value,status=200)=>r.respond({status,headers,contentType:'application/json',body:JSON.stringify(value)});
   if(r.method()==='OPTIONS')return r.respond({status:204,headers});
   if(u.pathname==='/user/profile')return send({id:owner,username:'Synthetic owner',permission:1,role:'owner',canWrite:true});
   if(u.pathname.startsWith('/config'))return send({});
   if(u.pathname==='/life/todos'||u.pathname==='/habit')return send([]);
   if(u.pathname==='/life/checkins/status')return send({ownerId:owner,configured});
   if(u.pathname==='/life/checkins')return send({ownerId:owner,items:[],nextBefore:null});
   if(u.pathname.startsWith('/life/checkins/')){
    if(offline)return send({code:'SYNTHETIC_OFFLINE'},503);
    if(r.method()==='POST'){posts++;const b=JSON.parse(r.postData());assert.ok(b.record);if(b.baseRevision!==(record?.revision??0))return send({ownerId:owner,saved:false},409);record={value:b.record,revision:b.baseRevision+1,updatedAt:Math.floor(Date.now()/1000)};return send({ownerId:owner,saved:true,revision:record.revision});}
    return send({ownerId:owner,record:owner===1?record:null});
   }
   return send({});
  });
  const wait=fn=>page.waitForFunction(fn,{timeout:12000});
  const button=async text=>{await page.evaluate(text=>{const el=[...document.querySelectorAll('.checkin-workspace button')].find(b=>b.textContent===text);if(!el||el.disabled)throw Error('Button unavailable: '+text);el.click();},text);};
  await page.goto(base+'/life/check-in',{waitUntil:'networkidle2'});await wait(()=>document.querySelector('.checkin-workspace fieldset')&&!document.querySelector('.checkin-workspace fieldset').disabled);assert.equal(posts,0);
  await button('添加项目');await wait(()=>document.querySelector('.checkin-workspace article input'));
  await page.type('.checkin-workspace article input','合成练琴项目');await page.select('.checkin-workspace article select','habit');await page.select('.checkin-workspace article select:nth-of-type(1)','habit').catch(()=>{});
  const selects=await page.$$('.checkin-workspace article select');await selects[1].select('missed');await page.type('.checkin-workspace article textarea','合成短备注');
  await page.click('.checkin-workspace article input[type=checkbox]');
  await button('添加饮食记录');const meal=await page.$$('.checkin-workspace article');await meal[1].$eval('select',e=>{e.value='plan';e.dispatchEvent(new Event('change',{bubbles:true}));});await meal[1].$('textarea').then(e=>e.type('合成食谱：米饭与蔬菜'));await meal[1].$('input:not([type=checkbox])').then(e=>e.type('一碗'));
  await button('确认并保存');await wait(()=>document.querySelector('.checkin-workspace [role=status]').textContent.includes('已确认并保存'));assert.equal(posts,1);assert.equal(record.value.items[0].result,'missed');assert.equal(record.value.meals[0].kind,'plan');
  await page.reload({waitUntil:'networkidle2'});await wait(()=>document.querySelector('.checkin-workspace article input')?.value==='合成练琴项目');assert.equal(posts,1);
  offline=true;await page.type('.checkin-workspace article textarea','离线保留');await wait(()=>document.querySelector('.checkin-workspace [role=status]').textContent.includes('本机草稿已保存'));await page.reload({waitUntil:'networkidle2'});await wait(()=>document.querySelector('.checkin-workspace article textarea')?.value.includes('离线保留'));
  offline=false;record={...record,revision:2,value:{...record.value,items:record.value.items.map(i=>({...i,note:'另一设备修改'}))}};
  await page.reload({waitUntil:'networkidle2'});await wait(()=>document.querySelector('.checkin-conflict'));assert.ok(await page.$eval('.checkin-workspace article textarea',e=>e.value.includes('离线保留')));
  await button('读取云端版本比较');await wait(()=>document.querySelector('.checkin-conflict pre').textContent.includes('另一设备修改'));await button('已比较，保留本机内容并采用此基础版本');await button('确认并保存');await wait(()=>document.querySelector('.checkin-workspace [role=status]').textContent.includes('已确认并保存'));assert.equal(record.revision,3);
  for(const width of [320,360,768,1024,1440]){await page.setViewport({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Horizontal overflow '+width);}
  await page.setViewport({width:1024,height:1000});await page.evaluate(()=>document.documentElement.style.zoom='2');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Zoom overflow');await page.evaluate(()=>document.documentElement.style.zoom='');
  await page.setViewport({width:360,height:900});await page.screenshot({path:path.join(output,'checkin-mobile-dark.png'),fullPage:true});
  await page.evaluate(()=>localStorage.setItem('theme','light'));await page.reload({waitUntil:'networkidle2'});await wait(()=>document.querySelector('.checkin-workspace article'));await page.screenshot({path:path.join(output,'checkin-mobile-light.png'),fullPage:true});
  configured=false;await page.reload({waitUntil:'networkidle2'});await wait(()=>document.querySelector('.checkin-workspace [role=status]').textContent.includes('加密配置尚未就绪'));assert.equal(await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='确认并保存').disabled),true);
  owner=2;await page.setCookie({name:'token',value:'x.eyJpZCI6Mn0.x',url:base});await page.reload({waitUntil:'networkidle2'});await wait(()=>document.querySelector('.checkin-workspace fieldset')&&!document.querySelector('.checkin-workspace fieldset').disabled);assert.equal(await page.$$('.checkin-workspace article').then(x=>x.length),0);
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,posts,output,widths:[320,360,768,1024,1440],zoom:'200%',realExternalCalls:0}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
