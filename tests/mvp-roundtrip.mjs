#!/usr/bin/env node
// 実際に赤を入れ、AI対応を確認し、画像と確認状態を別ブラウザへ持ち越す。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const layer = await fs.readFile(new URL('../rv-layer.js', import.meta.url), 'utf8');
const sample = await fs.readFile(new URL('../examples/sample-review.html', import.meta.url), 'utf8');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const browser = await chromium.launch();
const errors = [];
let resolved = null;
async function openPage(name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  await context.route('http://akaire-mvp.test/**', route => {
    if (route.request().url().endsWith('/rv-layer.js')) return route.fulfill({ contentType: 'text/javascript', body: layer });
    const body = resolved ? sample.replace('約12時間', '約14.5時間').replace('</body>', `<script>window.__rvResolved=${JSON.stringify(resolved)}</script></body>`) : sample;
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body });
  });
  await context.addInitScript(() => localStorage.setItem('rv-layer:guide', 'done'));
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  page.on('dialog', d => d.accept());
  await page.goto('http://akaire-mvp.test/' + name);
  return page;
}
async function carryOut(page) {
  const waiting = page.waitForEvent('download');
  await page.locator('#rvportable').click();
  const download = await waiting;
  return fs.readFile(await download.path());
}
async function carryIn(page, buffer) {
  await page.locator('#rvimportfile').setInputFiles({ name: 'review.json', mimeType: 'application/json', buffer });
  await page.waitForFunction(() => !document.getElementById('rvimport').disabled);
  assert.match(await page.locator('#rvtoast').textContent(), /レビューを読み込みました/);
}
try {
  const first = await openPage('proposal.html');
  const box = await first.getByText('月あたり約12時間', { exact: true }).boundingBox();
  await first.mouse.move(box.x + 2, box.y + box.height / 2);
  await first.mouse.down();
  await first.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 20 });
  await first.mouse.up();
  await first.locator('#rvnote').fill('本文の数字を表の合計に合わせてください');
  await first.evaluate(b64 => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([bytes], 'reference.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
  }, png);
  await first.locator('#rvimgs img').waitFor();
  await first.locator('#rvsave').click();
  const id = await first.evaluate(() => window.__rv.store.comments[0].id);
  assert.ok((await first.evaluate(() => window.__rv.copyText())).includes(id));
  resolved = { rev: 'mvp-roundtrip-1', ids: [id] };
  await first.evaluate(() => window.__rv.imagesSettled());   // 原寸の IndexedDB 書き込みが終わる前に reload しない
  await first.reload();
  await first.locator('#rvdone').click();
  await first.getByRole('button', { name: '確認した', exact: true }).click();
  const confirmed = await carryOut(first);
  assert.equal(JSON.parse(confirmed).images[0].data, 'data:image/png;base64,' + png);

  const second = await openPage('proposal-v2.html');
  await carryIn(second, confirmed);
  await second.reload();
  assert.deepEqual(await second.evaluate(() => {
    const c = window.__rv.store.comments[0]; return { id: c.id, status: c.status, checked: c.reviewedRev };
  }), { id, status: 'done', checked: resolved.rev });
  await second.locator('#rvdone').click();
  assert.match(await second.locator('.rvrevision').innerText(), /確認済み/);
  await second.screenshot({ path: '/tmp/akaire-mvp-improvements.png', fullPage: false });
  await second.getByRole('button', { name: '未済みへ戻す', exact: true }).click();
  const reopened = await carryOut(second);
  const third = await openPage('proposal-v3.html');
  await carryIn(third, reopened);
  await third.reload();
  assert.equal(await third.evaluate(() => window.__rv.store.comments[0].status), 'open');
  assert.equal(await third.evaluate(() => window.__rv.store.comments[0].reviewedRev), undefined);
  assert.ok((await third.evaluate(() => window.__rv.copyText())).includes(id));
  assert.equal(JSON.parse(await carryOut(third)).images[0].data, 'data:image/png;base64,' + png);
  await second.setViewportSize({ width: 390, height: 700 });
  const bar = await second.locator('#rvbar').boundingBox(), panel = await second.locator('#rvdonepanel').boundingBox();
  assert.ok(bar.x >= 0 && bar.x + bar.width <= 390);
  assert.ok(panel.y >= 0 && panel.y + panel.height <= bar.y);
  assert.deepEqual(errors, []);
  console.log('mvp-roundtrip: PASS (actual annotation + image → AI revision → confirmation → separate browsers → reopen preserved)');
} finally { await browser.close(); }
