import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const script = await readFile(new URL('../rv-layer.js', import.meta.url), 'utf8');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({viewport:{width:1280,height:900}});
  page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  let rev = 'r1';
  await page.route('http://revision.test/**', route => route.fulfill(route.request().url().endsWith('/layer.js') ? {contentType:'text/javascript',body:script} : {contentType:'text/html; charset=utf-8', body:`<html><body><p>unchanged target</p><script>window.__rvResolved={rev:'${rev}',ids:['c1','c2','c3','c4']}</script><script src="/layer.js"></script></body></html>`}));
  await page.addInitScript(() => {
    localStorage.setItem('rv-layer:enabled','1'); localStorage.setItem('rv-layer:guide','done');
    if(!localStorage.getItem('rv:/')) localStorage.setItem('rv:/',JSON.stringify({docId:'/',comments:[
      {id:'c1',quote:'unchanged target',note:'全文の指摘',replies:[{text:'追加の指示'}],images:[],status:'open'},
      {id:'c2',quote:'old deleted target',note:'変更された引用',replies:[],images:[],status:'open'}
    ],appliedRevs:[]}));
  });
  await page.goto('http://revision.test/');
  await page.locator('#rvdone').click();
  assert.equal(await page.evaluate(() => window.__rv.store.comments[0].status),'done');
  assert.match(await page.locator('#rvdonelist').innerText(),/追加の指示/);
  assert.equal(await page.evaluate(() => window.__rv.store.comments[0].reviewedRev),undefined);
  await page.getByRole('button',{name:'確認した',exact:true}).click();
  assert.equal(await page.evaluate(() => window.__rv.store.comments[0].reviewedRev),'r1');
  await page.getByRole('button',{name:'次',exact:true}).click();
  assert.match(await page.locator('#rvdonelist').innerText(),/位置不明/);
  assert.equal(await page.getByRole('button',{name:'箇所へ移動',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'未済みへ戻す',exact:true}).click();
  await page.reload();
  assert.equal(await page.evaluate(() => window.__rv.store.comments[1].status),'open');
  assert.equal(await page.evaluate(() => window.__rv.store.comments[0].reviewedRev),'r1');
  rev = 'r2'; await page.reload();
  assert.equal(await page.evaluate(() => window.__rv.store.comments[1].status),'done');
  assert.equal(await page.evaluate(() => window.__rv.store.comments[1].reviewedRev),undefined);
  await page.locator('#rvdone').click();
  assert.match(await page.locator('#rvdonelist').innerText(),/1 \/ 1/);
  await page.setViewportSize({width:390,height:700});
  await page.waitForTimeout(1800);
  await page.screenshot({path:'/tmp/akaire-revision-review.png',fullPage:true});
  const bounds = await page.locator('#rvdonepanel').boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  await page.evaluate(() => {
    const value = JSON.parse(localStorage.getItem('rv:/'));
    value.comments.push({id:'c3',kind:'block',tag:'P',fp:'unchanged target',quote:'〔枠〕p',note:'枠の指摘',status:'open',images:[],replies:[]},
      {id:'c4',kind:'crop',tag:'P',fp:'unchanged target',quote:'〔切り取り〕p',note:'切り取りの指摘',status:'open',images:[],replies:[],rect:{x:0,y:0,w:1,h:1}});
    localStorage.setItem('rv:/',JSON.stringify(value));
  });
  rev = 'r3'; await page.reload(); await page.locator('#rvdone').click();
  assert.equal(await page.getByRole('button',{name:'箇所へ移動',exact:true}).isEnabled(),true);
  await page.getByRole('button',{name:'箇所へ移動',exact:true}).click();
  await page.getByRole('button',{name:'次',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'箇所へ移動',exact:true}).isEnabled(),true);
  await page.getByRole('button',{name:'箇所へ移動',exact:true}).click();
  await page.evaluate(() => document.querySelector('p').textContent = 'changed block');
  await page.getByRole('button',{name:'前',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'箇所へ移動',exact:true}).isDisabled(),true);
  assert.deepEqual(errors, []);
  console.log('revision-review: passed (automatic done, full thread, confirmation persistence, missing anchor, reopen protection, new revision reset)');
} finally { await browser.close(); }
