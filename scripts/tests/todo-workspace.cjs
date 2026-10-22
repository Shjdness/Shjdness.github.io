const puppeteer = require('puppeteer');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const base = process.env.WORKSPACE_QA_URL || 'http://127.0.0.1:4173';
if (!['localhost','127.0.0.1'].includes(new URL(base).hostname)) throw Error('Run against a local preview only');
const output = fs.mkdtempSync(path.join(os.tmpdir(),'site-workspace-qa-'));
const windowsChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const now = Date.now();
const iso = offset => new Date(now + offset).toISOString();
let rows = [
  { id:1, type:'task', content:'整理本周的模拟电路笔记', completed:0, deadlineAt:iso(72*3600000) },
  { id:2, type:'task', content:'为下一次组会列出三个关键问题', completed:0, deadlineAt:iso(-2*3600000) },
  { id:3, type:'learn', content:'画一张属于自己的电路学习地图', completed:0 },
  { id:4, type:'task', content:'修好了曾经觉得很难解决的问题', completed:1, completedAt:iso(-86400000) },
  { id:5, type:'success', content:'认真完成了一次组会汇报，也主动回答了问题', completed:1, completedAt:iso(-3600000) },
  { id:6, type:'daily', content:'起床后：叠被子，整理桌面', completed:0, sortOrder:1 },
  { id:7, type:'daily', content:'晚饭后：钢琴练习 20 分钟', completed:0, sortOrder:2 },
].map(value => ({ createdAt:iso(-86400000), updatedAt:iso(0), clientKey:`fixture-${value.id}`, deadlineAt:null, completedAt:null, sortOrder:0, ...value }));
let nextId = 20;
let failWrites = false;
let loseAcknowledgement = false;

(async () => {
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || (fs.existsSync(windowsChrome) ? windowsChrome : puppeteer.executablePath());
  const browser = await puppeteer.launch({ headless:true, executablePath, args:['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewport({ width:1536, height:1000 });
    await page.setCookie({ name:'token', value:'x.eyJpZCI6MX0.x', url:base });
    await page.evaluateOnNewDocument(() => { if (!localStorage.getItem('theme')) localStorage.setItem('theme','light'); });
    await page.setRequestInterception(true);
    page.on('request', async request => {
      if (!request.url().includes('rin-server.1322589722.workers.dev')) return request.continue();
      const url = new URL(request.url());
      const headers = { 'access-control-allow-origin':base, 'access-control-allow-headers':'authorization,content-type', 'access-control-allow-methods':'GET,POST,PUT,DELETE,OPTIONS' };
      const respond = (data, status=200) => request.respond({ status, contentType:'application/json', headers, body:JSON.stringify(data) });
      if (request.method() === 'OPTIONS') return request.respond({ status:204, headers });
      if (url.pathname === '/user/profile') return respond({ id:1, username:'Owner', avatar:'/avatar.jpg', permission:true, canWrite:true, role:'owner' });
      if (url.pathname.startsWith('/config')) return respond({});
      if (url.pathname === '/life/overview') return respond({ summary:{habits:4,completed:12,focusMinutes:50,rounds:2,unread:3}, habits:[], recentRss:[], basics:[], todos:rows });
      if (url.pathname === '/life/calendar') return respond({ habits:[], logs:[], sessions:[], notes:[], basics:[] });
      if (url.pathname === '/feed') return respond({ size:0, data:[], hasNext:false });
      if (url.pathname === '/life/todos' && request.method() === 'GET') return respond(rows);
      if (url.pathname.startsWith('/life/todos') && request.method() !== 'GET') {
        if (failWrites) return respond({ error:'Simulated offline' },503);
        await new Promise(resolve => setTimeout(resolve,120));
        const body = JSON.parse(request.postData() || '{}');
        if (url.pathname === '/life/todos') {
          let item = rows.find(row => row.clientKey === body.clientKey);
          if (!item) { item={ id:nextId++, createdAt:iso(0), updatedAt:iso(0), completed:body.type==='success'?1:0, ...body }; rows.push(item); }
          if (loseAcknowledgement && body.content === '确认丢失重试') { loseAcknowledgement=false; return respond({error:'Lost acknowledgement'},503); }
          return respond({ insertedId:item.id });
        }
        const id = Number(url.pathname.split('/').pop());
        if (request.method() === 'DELETE') { rows=rows.filter(item => item.id!==id); return respond('OK'); }
        const item = rows.find(value => value.id===id);
        if (!item) return respond('Not found',404);
        Object.assign(item,body,{ updatedAt:iso(0) });
        if (body.completed !== undefined) item.completed=Number(body.completed);
        return respond('OK');
      }
      return respond([]);
    });
    const wait = fn => page.waitForFunction(fn, { timeout:15000 });
    const waitRows = async fn => { const end=Date.now()+15000; while (!fn(rows)) { if(Date.now()>end) throw Error('Mock server state timed out'); await new Promise(resolve=>setTimeout(resolve,80)); } };
    const add = async (type,text) => {
      await page.type(`.todo-column--${type} .todo-column-compose textarea`,text);
      await page.click(`.todo-column--${type} .todo-column-compose button`);
    };
    await page.goto(base+'/life/todos',{waitUntil:'networkidle2'});
    await wait(() => document.querySelectorAll('.todo-entry').length===7);
    assert.equal(await page.$eval('.todo-columns',el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),4);
    await add('task','浏览器验证：新增并完成');
    await waitRows(values=>values.some(item=>item.content==='浏览器验证：新增并完成'));
    await page.evaluate(() => [...document.querySelectorAll('.todo-entry')].find(el=>el.querySelector('textarea').value==='浏览器验证：新增并完成').querySelector('.todo-primary').click());
    await waitRows(values=>values.find(item=>item.content==='浏览器验证：新增并完成')?.completed===1);
    assert.equal(rows.filter(item=>item.content==='浏览器验证：新增并完成').length,1);
    await page.click('.todo-column--learn .todo-entry .todo-primary');
    await waitRows(values=>values.find(item=>item.id===3)?.type==='task');
    const ideaDeadline=rows.find(item=>item.id===3).deadlineAt;
    assert.ok(Date.parse(ideaDeadline)>Date.now()+71*3600000);
    await page.evaluate(() => [...document.querySelectorAll('.todo-column--daily .todo-entry')].find(el=>el.querySelector('textarea').value.includes('钢琴')).querySelector('[aria-label="上移每日执行项目"]').click());
    await waitRows(values=>values.find(item=>item.id===7).sortOrder<values.find(item=>item.id===6).sortOrder);
    assert.equal(await page.$$eval('.todo-column--daily .todo-check',els=>els.length),0);
    await page.reload({waitUntil:'networkidle2'});
    await wait(() => document.querySelectorAll('.todo-entry').length===8);
    assert.equal(rows.find(item=>item.id===3).deadlineAt,ideaDeadline);
    failWrites=true;
    await add('task','离线创建：刷新后仍保留');
    await new Promise(resolve=>setTimeout(resolve,700));
    await page.reload({waitUntil:'networkidle2'});
    await wait(() => [...document.querySelectorAll('.todo-entry textarea')].some(el=>el.value==='离线创建：刷新后仍保留'));
    const offlineDeadline=await page.evaluate(()=>[...document.querySelectorAll('.todo-entry')].find(el=>el.querySelector('textarea').value==='离线创建：刷新后仍保留').querySelector('.todo-deadline').title);
    failWrites=false;
    await page.waitForSelector('.life-sync-status:not([disabled])');
    await page.click('.life-sync-status');
    await waitRows(values=>values.some(item=>item.content==='离线创建：刷新后仍保留'));
    await new Promise(resolve=>setTimeout(resolve,500));
    await page.reload({waitUntil:'networkidle2'});
    await wait(() => [...document.querySelectorAll('.todo-entry textarea')].some(el=>el.value==='离线创建：刷新后仍保留'));
    assert.equal(rows.filter(item=>item.content==='离线创建：刷新后仍保留').length,1);
    assert.equal(await page.evaluate(()=>[...document.querySelectorAll('.todo-entry')].find(el=>el.querySelector('textarea').value==='离线创建：刷新后仍保留').querySelector('.todo-deadline').title),offlineDeadline);
    await add('learn','快速连续新增 A');
    await add('daily','快速连续新增 B');
    await waitRows(values=>values.some(item=>item.content==='快速连续新增 A')&&values.some(item=>item.content==='快速连续新增 B'));
    await add('success','我主动记录了一件成功的小事');
    await waitRows(values=>values.some(item=>item.content==='我主动记录了一件成功的小事'&&item.completed===1));
    await page.evaluate(()=>[...document.querySelectorAll('.todo-entry')].find(el=>el.querySelector('textarea').value.includes('三个关键问题')).querySelectorAll('button')[2].click());
    await waitRows(values=>Date.parse(values.find(item=>item.id===2).deadlineAt)>Date.now()+71*3600000);
    loseAcknowledgement=true;
    await add('task','确认丢失重试');
    await waitRows(values=>values.some(item=>item.content==='确认丢失重试'));
    await page.waitForSelector('.life-sync-status.failed');
    await page.click('.life-sync-status');
    await page.waitForSelector('.life-sync-status.synced');
    assert.equal(rows.filter(item=>item.content==='确认丢失重试').length,1);
    await page.evaluate(()=>[...document.querySelectorAll('.todo-entry')].find(el=>el.querySelector('textarea').value.includes('学习地图')).querySelectorAll('button')[1].click());
    await page.waitForFunction(()=>location.pathname==='/life/pomodoro');
    await page.waitForSelector('.pomodoro-task select');
    assert.equal(await page.$eval('.pomodoro-task select',el=>el.value),'3');
    await page.goto(base+'/life/todos',{waitUntil:'networkidle2'});
    for (const theme of ['light','dark']) {
      await page.evaluate(theme=>{localStorage.setItem('theme',theme); document.documentElement.setAttribute('data-color-mode',theme); document.documentElement.style.colorScheme=theme;},theme);
      for (const width of [1536,960,390,320]) {
        await page.setViewport({width,height:1000});
        await new Promise(resolve=>setTimeout(resolve,250));
        const metrics=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,nav:[...document.querySelectorAll('.site-header-nav a')].map(el=>({label:el.textContent,display:getComputedStyle(el).display})),appearance:document.querySelectorAll('[href="/appearance"]').length}));
        assert.equal(metrics.width,metrics.scroll,JSON.stringify(metrics));
        assert.equal(metrics.appearance,0);
        assert.ok(metrics.nav.some(item=>item.label==='日历'&&item.display!=='none'));
        assert.ok(metrics.nav.some(item=>item.label==='年历'&&item.display!=='none'));
        if (width===390) {
          await page.click('.todo-workspace-tabs button:nth-child(4)');
          assert.equal(await page.$eval('.todo-column--daily',el=>getComputedStyle(el).display),'block');
          assert.equal(await page.$eval('.todo-column--task',el=>getComputedStyle(el).display),'none');
        }
        await page.screenshot({path:path.join(output,`todos-${theme}-${width}.png`),fullPage:false});
        console.log('viewport',theme,width,'no document overflow; navigation directly present');
      }
    }
    await page.reload({waitUntil:'networkidle2'});
    assert.equal(await page.evaluate(()=>document.documentElement.getAttribute('data-color-mode')),'dark');
    await page.setViewport({width:960,height:900});
    await page.evaluate(()=>localStorage.setItem('theme','light'));
    await page.goto(base+'/life',{waitUntil:'networkidle2'});
    await page.screenshot({path:path.join(output,'life-light.png')});
    await page.goto(base+'/',{waitUntil:'networkidle2'});
    await page.screenshot({path:path.join(output,'home-light.png')});
    assert.deepEqual(errors,[]);
    console.log('PASS: create, complete once, idea start, daily order, reload, offline retry, rapid writes, themes and navigation');
    console.log('Screenshots:',output);
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exit(1)});
