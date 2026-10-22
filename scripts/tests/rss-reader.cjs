const puppeteer=require('puppeteer');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const base=process.env.WORKSPACE_QA_URL || 'http://127.0.0.1:4173';
if (!['127.0.0.1','localhost'].includes(new URL(base).hostname)) throw Error('Local preview required');
const output=fs.mkdtempSync(path.join(os.tmpdir(),'rss-reader-qa-'));
const subscriptions=[{id:1,title:'Independent Creator',alias:'',category:'学习',historyPolicy:'full',historyReason:'低频候选',historyStatus:'complete'}, {id:2,title:'Institution Channel',alias:'',category:'学习',historyPolicy:'two-years',historyStatus:'complete'}];
const rows=Array.from({length:425},(_,i)=>({id:i+1,externalId:String(i+1).padStart(11,'x'),subscriptionId:i%2+1,title:`${i%2?'机构':'独立'} 历史 ${i} ${i===8?'100% 进展':''}`,summary:i===10?'searchOnlyInSummary':'历史简介',author:i%2?'机构':'独立',publishedAt:new Date(Date.UTC(i<300?2025:2019,0,1)).toISOString(),publishedPrecision:'exact',read:0,starred:0,url:`https://www.youtube.com/watch?v=${String(i+1).padStart(11,'x')}`,embedUrl:'',thumbnailUrl:''}));
rows.push({...rows[0],id:999,externalId:'unknown0001',title:'旧目录日期未知',publishedPrecision:'unknown'});
(async()=>{
 const browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 try {
  const page=await browser.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.setCookie({name:'token',value:'x.eyJpZCI6MX0.x',url:base});
  await page.evaluateOnNewDocument(()=>localStorage.setItem('theme','dark'));
  await page.setViewport({width:1536,height:1000});
  await page.setRequestInterception(true);
  page.on('request',async request=>{
   if(!request.url().includes('workers.dev')) return request.continue();
   const url=new URL(request.url());
   const headers={'access-control-allow-origin':base,'access-control-allow-headers':'authorization,content-type','access-control-allow-methods':'GET,POST,OPTIONS'};
   const respond=data=>request.respond({status:200,contentType:'application/json',headers,body:JSON.stringify(data)});
   if(request.method()==='OPTIONS') return request.respond({status:204,headers});
   if(url.pathname==='/user/profile') return respond({id:1,username:'Owner',permission:true,role:'owner',canWrite:true});
   if(url.pathname==='/rss/storage') return respond({backend:{usedBytes:4194304,limitBytes:null,measured:true},rssBytes:102400,metrics:[{kind:'history',added:425,updated:0,unchanged:10,rowsRead:500,rowsWritten:1275,sizeBefore:1000000,sizeAfter:4194304}]});
   if(/^\/rss\/subscriptions\/\d+\/refresh$/.test(url.pathname)) return respond({added:0,updated:0,unchanged:15});
   if(url.pathname==='/rss') {
    let results=rows.filter(row=>(!url.searchParams.get('sourceId') || row.subscriptionId===Number(url.searchParams.get('sourceId'))));
    const years=[...new Set(results.filter(row=>row.publishedPrecision!=='unknown').map(row=>row.publishedAt.slice(0,4)))];
    const q=url.searchParams.get('q') || '',year=url.searchParams.get('year') || '';
    if(q==='独立') await new Promise(r=>setTimeout(r,700));
    results=results.filter(row=>(!q || [row.title,row.summary,row.author].some(text=>text.includes(q))) && (!year || (year==='unknown'?row.publishedPrecision==='unknown':row.publishedPrecision!=='unknown' && row.publishedAt.startsWith(year))));
    const offset=Number(url.searchParams.get('offset') || 0),limit=Number(url.searchParams.get('limit') || 200);
    return respond({subscriptions,groups:[{id:1,name:'学习',sortOrder:0}],items:results.slice(offset,offset+limit),years,counts:{all:rows.length,unread:rows.length,starred:0},page:{limit,offset,total:results.length,hasMore:offset+limit<results.length}});
   }
   return respond({});
  });
  await page.goto(base+'/life/rss',{waitUntil:'networkidle2'});
  await page.waitForSelector('.rss-card');
  assert.equal(await page.$$('.rss-card').then(x=>x.length),200);
  await page.click('.rss-sidebar-tools button[title="更新来源"]');
  await page.waitForFunction(()=>document.querySelector('.rss-message')?.textContent.includes('跳过 30'));
  await page.click('.rss-load-more');
  await page.waitForFunction(()=>document.querySelectorAll('.rss-card').length===400);
  await page.click('.rss-source-row button:first-child');
  await page.waitForFunction(()=>document.querySelector('.rss-history-tools [role="status"]').textContent.includes('214'));
  await page.select('select[aria-label="发布年份"]','2019');
  await page.waitForFunction(()=>document.querySelectorAll('.rss-card').length===63);
  await page.type('input[aria-label="搜索 RSS 内容"]','searchOnlyInSummary');
  await page.waitForFunction(()=>document.querySelectorAll('.rss-card').length===0);
  await page.select('select[aria-label="发布年份"]','');
  await page.waitForFunction(()=>document.querySelectorAll('.rss-card').length===1);
  await page.$eval('input[aria-label="搜索 RSS 内容"]',el=>el.value='');
  await page.type('input[aria-label="搜索 RSS 内容"]','独立');
  await new Promise(r=>setTimeout(r,400));
  await page.click('input[aria-label="搜索 RSS 内容"]',{clickCount:3});
  await page.type('input[aria-label="搜索 RSS 内容"]','100%');
  await page.waitForFunction(()=>document.querySelectorAll('.rss-card').length===1 && document.querySelector('.rss-card').textContent.includes('100%'));
  await new Promise(r=>setTimeout(r,800));
  assert.equal(await page.$eval('.rss-card',el=>el.textContent.includes('100%')),true,'Old search must not overwrite latest results');
  await page.click('input[aria-label="搜索 RSS 内容"]',{clickCount:3}); await page.keyboard.press('Backspace');
  await page.select('select[aria-label="发布年份"]','unknown');
  await page.waitForFunction(()=>document.querySelectorAll('.rss-card').length===1 && document.querySelector('.rss-card').textContent.includes('日期未知'));
  for (const width of [1536,960,390,320]) {
   await page.setViewport({width,height:1000});
   assert(await page.$eval('html',el=>el.scrollWidth<=innerWidth+2),`Overflow at ${width}`);
   assert(await page.$eval('.rss-history-tools',el=>el.getBoundingClientRect().top<innerHeight),'Mobile tools must be reachable without a full-height sidebar covering the reader');
   await page.screenshot({path:path.join(output,`rss-${width}.png`),fullPage:true});
  }
  assert.deepEqual(errors,[]);
  console.log(`PASS: pagination, channel+year+summary search, literal %, stale-response guard, unknown dates, 4 responsive widths. ${output}`);
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
