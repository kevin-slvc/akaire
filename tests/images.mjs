#!/usr/bin/env node
// 画像の添付と取り外しが、表示だけでなく IndexedDB の原寸まで一致して動くかを確かめる。
// 実行: node tests/images.mjs （npm test から呼ばれる）
//
// この検査が要る理由: 「×」で外しても原寸が IndexedDB に残り続ける不具合が実在した（v1.25で修正）。
// 表示上は消えるので画面を見ても気づけず、消したはずの画像がブラウザに残る。
// 逆方向（キャンセルで閉じたのに消える）はデータの取り違えた削除になるので、両方を見る。

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = path.join(ROOT, 'examples/sample-review.html');

const fails = [], ok = [];
const check = (name, cond, detail) => (cond ? ok : fails).push(detail ? `${name} — ${detail}` : name);

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto(pathToFileURL(SAMPLE).href);
await page.waitForTimeout(600);

const skip = page.locator('text=もう出さない').first();
if (await skip.isVisible().catch(() => false)) { await skip.click(); await page.waitForTimeout(200); }

// IndexedDB に実際に入っている原寸のキーを読む（UIの表示ではなく実体を見る）
const keys = () => page.evaluate(() => new Promise(res => {
  const r = indexedDB.open('rv-layer');
  r.onsuccess = () => {
    const db = r.result;
    if (!db.objectStoreNames.contains('images')) return res([]);
    const g = db.transaction('images', 'readonly').objectStore('images').getAllKeys();
    g.onsuccess = () => res(g.result);
    g.onerror = () => res(['READ_ERROR']);
  };
  r.onerror = () => res(['OPEN_ERROR']);
}));
const shown = () => page.evaluate(() => document.querySelectorAll('#rvimgs figure').length);

async function openFirstMark() {
  await page.locator('mark.rv').first().click();
  await page.waitForTimeout(500);
}

// 本文を選んでコメント欄を開く（実マウス入力）
{
  const b = await page.locator('strong', { hasText: '月あたり約12時間' }).first().boundingBox();
  await page.mouse.move(b.x + 2, b.y + b.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(b.x + 2 + (b.width - 4) * i / 20, b.y + b.height / 2);
    await page.waitForTimeout(8);
  }
  await page.mouse.up();
  await page.waitForTimeout(400);
}

// 1x1 PNG をペーストで添付する
await page.evaluate(() => {
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const bin = atob(b64), arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const dt = new DataTransfer();
  dt.items.add(new File([arr], 't.png', { type: 'image/png' }));
  document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
});
await page.waitForTimeout(900);
check('ペーストで画像が添付される', await shown() === 1, `表示枚数=${await shown()}`);

await page.locator('#rvnote').fill('画像つきの指摘');
await page.locator('#rvsave').click();
await page.waitForTimeout(1200);

const saved = await keys();
check('保存で原寸が IndexedDB に入る', saved.length === 1, `キー=${JSON.stringify(saved)}`);

// ×で外してキャンセル → 消えてはいけない
await openFirstMark();
await page.locator('#rvimgs figure button').first().click();
await page.waitForTimeout(300);
await page.locator('#rvcancel').click();
await page.waitForTimeout(1200);
const afterCancel = await keys();
check('キャンセルでは原寸を消さない', afterCancel.length === saved.length,
  `キャンセル後=${JSON.stringify(afterCancel)}`);

// ×で外して保存 → 消えなければならない
await openFirstMark();
check('キャンセル後も画像は残っている', await shown() === 1, `表示枚数=${await shown()}`);
await page.locator('#rvimgs figure button').first().click();
await page.waitForTimeout(300);
await page.locator('#rvsave').click();
await page.waitForTimeout(1500);
const afterSave = await keys();
check('外して保存すると原寸も消える', afterSave.length === 0, `保存後=${JSON.stringify(afterSave)}`);

check('JSエラーが出ていない', errors.length === 0, errors.join(' / '));

await browser.close();
for (const l of ok) console.log('  OK  ' + l);
for (const l of fails) console.log('  NG  ' + l);
console.log(`\n画像チェック: ${ok.length}件OK / ${fails.length}件NG`);
process.exit(fails.length ? 1 : 0);
