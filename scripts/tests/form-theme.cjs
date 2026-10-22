// Local production preview only: no real account or production writes.
const puppeteer = require('puppeteer');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const base = process.env.WORKSPACE_QA_URL || 'http://127.0.0.1:4173';
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw Error('Local preview required');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'site-form-theme-'));

(async () => {
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 960, height: 900 });
    // A manual dark choice must work even when Windows/browser prefers light.
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await page.evaluateOnNewDocument(() => localStorage.setItem('theme', 'dark'));
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (request.url().startsWith(base)) return request.continue();
      if (request.url().includes('workers.dev')) return request.respond({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': base }, body: JSON.stringify(new URL(request.url()).pathname === '/feed' ? { data: [], size: 0, hasNext: false } : {}) });
      return request.abort();
    });
    await page.goto(base + '/blog', { waitUntil: 'networkidle2' });
    await page.evaluate(() => {
      // Exercise the existing page CSS and portal scope, including historical
      // white backgrounds and text/select/textarea classes used across routes.
      const sample = document.createElement('section');
      sample.id = 'form-theme-fixture';
      sample.className = 'glass-panel';
      sample.style.cssText = 'position:relative;z-index:10;padding:20px;margin:20px;display:grid;gap:12px';
      sample.innerHTML = `<h2>表单主题回归 / 不写入数据</h2>
        <input type="search" class="bg-w bg-secondary" placeholder="搜索内容">
        <div class="calendar-tools"><input type="date"><select><option>全部日历</option><option>今天</option></select></div>
        <div class="writing-kind"><select><option>普通文章</option><option>私人日记</option></select></div>
        <div class="todo-entry-actions"><select aria-label="移动清单项目"><option disabled>移动到…</option><option>待办</option><option>未来构想</option><option>成功的事汇总</option><option>每日执行</option></select></div>
        <div class="pomodoro-task"><select disabled><option>不关联待办</option></select><input placeholder="当前任务"></div>
        <div class="daily-note"><textarea placeholder="写下今天的事"></textarea></div>
        <div class="gallery-filters"><select><option>全部年份</option></select></div>
        <div class="rss-modal"><input placeholder="频道地址"><select><option>未分组</option></select><textarea placeholder="备注"></textarea></div>`;
      document.querySelector('.site-shell').append(sample);
      const portal = document.createElement('div');
      portal.className = 'ReactModalPortal';
      portal.innerHTML = '<div style="padding:20px"><input class="bg-secondary bg-w" placeholder="弹窗输入框"></div>';
      document.body.append(portal);
    });
    const samples = '#form-theme-fixture input, #form-theme-fixture textarea, #form-theme-fixture select, .ReactModalPortal input';
    const inspect = () => page.$$eval(samples, elements => elements.map(el => {
      const css = getComputedStyle(el);
      return { tag: el.tagName, background: css.backgroundColor, color: css.color, scheme: css.colorScheme };
    }));
    const dark = await inspect();
    assert(dark.length >= 12);
    for (const state of dark) {
      assert.equal(state.scheme, 'dark');
      const rgb = state.background.match(/[\d.]+/g).map(Number);
      assert(Math.max(...rgb.slice(0, 3)) < 100, JSON.stringify(state));
      assert(rgb.length === 3 || rgb[3] > 0, JSON.stringify(state));
    }
    const options = await page.$$eval('#form-theme-fixture option', elements => elements.map(el => {
      const css = getComputedStyle(el);
      return { background: css.backgroundColor, color: css.color, scheme: css.colorScheme };
    }));
    for (const state of options) {
      assert.equal(state.scheme, 'dark');
      const rgb = state.background.match(/[\d.]+/g).map(Number);
      assert(Math.max(...rgb.slice(0, 3)) < 100);
      assert(rgb.length === 3 || rgb[3] === 1, 'Native options must be opaque');
      const ink = state.color.match(/[\d.]+/g).map(Number);
      const luminance = values => values.slice(0, 3).map(x => x / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4).reduce((sum, x, i) => sum + x * [.2126, .7152, .0722][i], 0);
      assert((luminance(ink) + .05) / (luminance(rgb) + .05) >= 4.5, 'Option text contrast');
    }
    await page.hover('#form-theme-fixture input[type="search"]');
    assert.deepEqual(await inspect(), dark, 'Hover must not flip form backgrounds');
    await page.focus('#form-theme-fixture input[type="search"]');
    assert.deepEqual(await inspect(), dark, 'Focus must not flip form backgrounds');
    await page.screenshot({ path: path.join(output, 'forms-dark.png'), fullPage: true });
    await page.click('button[aria-label="Toggle light mode"]');
    for (const state of await inspect()) {
      assert.equal(state.scheme, 'light');
      assert.notEqual(state.color, dark[0].color);
    }
    await page.screenshot({ path: path.join(output, 'forms-light.png'), fullPage: true });
    await page.click('button[aria-label="Toggle dark mode"]');
    assert.deepEqual(await inspect(), dark, 'Theme switching must restore all controls');
    await page.reload({ waitUntil: 'networkidle2' });
    assert.equal(await page.$eval('html', el => el.dataset.colorMode), 'dark');
    console.log(`PASS: text/search/date/select/textarea, native options, disabled items, portals, hover/focus, contrast, manual theme and reload. Screenshots: ${output}`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
