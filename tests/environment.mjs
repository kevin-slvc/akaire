#!/usr/bin/env node
// body transform下の矩形座標と、IndexedDB.open拒否時のデータ保護を実ブラウザで確かめる。
// 座標検査は合成イベントを使わず、page.mouseを段階的に動かす。

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRANSFORM = path.join(ROOT, 'tests/fixtures/body-transform.html');
const SAMPLE = path.join(ROOT, 'examples/sample-review.html');
const fails = [], ok = [];
const check = (name, cond, detail) => (cond ? ok : fails).push(detail ? `${name} — ${detail}` : name);
const near = (a, b, tolerance = 1.5) => Math.abs(a - b) <= tolerance;

async function skipGuide(page) {
  const skip = page.locator('text=もう出さない').first();
  if (await skip.isVisible().catch(() => false)) {
    await skip.click();
    await page.waitForTimeout(200);
  }
}

async function drag(page, from, to, steps = 20) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + (to.x - from.x) * i / steps,
                          from.y + (to.y - from.y) * i / steps);
    await page.waitForTimeout(8);
  }
  await page.mouse.up();
  await page.waitForTimeout(350);
}

const browser = await chromium.launch();

// 5(a): bodyのtransformが対象と矩形レイヤーへ二重に掛からないこと。
{
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(pathToFileURL(TRANSFORM).href);
  await page.waitForTimeout(600);
  await skipGuide(page);

  const text = await page.locator('#text-target').boundingBox();
  await drag(page, { x: text.x + 2, y: text.y + text.height / 2 },
                   { x: text.x + text.width - 2, y: text.y + text.height / 2 });
  // 基準に選択範囲を使わない。mouseup後はコメント欄へフォーカスが移り（v1.22）、
  // getSelection() は textarea 側を指して矩形が (0,0) になる。対象は要素の実測で取る。
  const rangeRect = text;
  const selectionBox = await page.locator('#rvsel .rvselbox').first().boundingBox();
  check('body transform下で文字選択ハイライトが重なる',
    near(selectionBox.x, rangeRect.x) && near(selectionBox.y, rangeRect.y),
    `対象=(${rangeRect.x},${rangeRect.y}) / 枠=(${selectionBox.x},${selectionBox.y})`);
  await page.locator('#rvcancel').click();
  await page.waitForTimeout(200);

  const cropTarget = await page.locator('#crop-target').boundingBox();
  const from = { x: cropTarget.x + 15, y: cropTarget.y + 15 };
  const to = { x: cropTarget.x + cropTarget.width - 15, y: cropTarget.y + cropTarget.height - 15 };
  await page.keyboard.down('Alt');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(from.x + (to.x - from.x) * i / 20,
                          from.y + (to.y - from.y) * i / 20);
    await page.waitForTimeout(8);
  }
  const cropBox = await page.locator('#rvcrop').boundingBox();
  check('body transform下でドラッグ中の切り取り枠が重なる',
    near(cropBox.x, from.x) && near(cropBox.y, from.y) &&
    near(cropBox.width, to.x - from.x) && near(cropBox.height, to.y - from.y),
    `操作=(${from.x},${from.y},${to.x-from.x},${to.y-from.y}) / ` +
    `枠=(${cropBox.x},${cropBox.y},${cropBox.width},${cropBox.height})`);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await page.waitForTimeout(300);
  await page.locator('#rvcancel').click();

  await page.locator('#rvpick').click();
  const target = await page.locator('#block-target').boundingBox();
  await page.mouse.click(target.x + target.width - 10, target.y + target.height - 10);
  await page.waitForTimeout(300);
  await page.locator('#rvnote').fill('transform下の枠位置');
  await page.locator('#rvsave').click();
  await page.waitForTimeout(400);
  const savedBox = await page.locator('#rvmarks .rvbox').first().boundingBox();
  check('body transform下で保存済みの枠が対象に重なる',
    near(savedBox.x + 3, target.x) && near(savedBox.y + 3, target.y),
    `対象=(${target.x},${target.y}) / 枠=(${savedBox.x},${savedBox.y})`);
  check('body transform検査でJSエラーが出ない', errors.length === 0, errors.join(' / '));
  await page.context().close();
}

// 5(b): API自体はあるがopenだけ拒否される環境。本文とサムネイルはlocalStorageへ残る。
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  await context.addInitScript(() => {
    const denied = {
      open() {
        const request = { error: new DOMException('site data denied', 'SecurityError') };
        setTimeout(() => request.onerror && request.onerror(new Event('error')), 0);
        return request;
      }
    };
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: denied });
  });
  const page = await context.newPage();
  const warnings = [], errors = [];
  page.on('console', msg => { if (msg.type() === 'warning') warnings.push(msg.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(pathToFileURL(SAMPLE).href);
  await page.waitForTimeout(600);
  await skipGuide(page);
  check('IndexedDB拒否fixtureでもAPIのopenは存在する',
    await page.evaluate(() => !!(indexedDB && indexedDB.open)));

  const b = await page.locator('strong', { hasText: '月あたり約12時間' }).first().boundingBox();
  await drag(page, { x: b.x + 2, y: b.y + b.height / 2 },
                   { x: b.x + b.width - 2, y: b.y + b.height / 2 });
  await page.evaluate(() => {
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const bin = atob(b64), arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([arr], 'denied.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(700);
  await page.locator('#rvnote').fill('IndexedDB拒否でも残す本文');
  await page.locator('#rvsave').click();
  await page.waitForTimeout(1000);
  await page.reload();
  await page.waitForTimeout(600);
  const persisted = await page.evaluate(() => {
    const c = window.__rv.store.comments[0];
    return c && { note: c.note, images: c.images.length, thumb: c.images[0] && c.images[0].thumb };
  });
  check('IndexedDB.open失敗を警告する',
    warnings.some(w => w.includes('IndexedDB 不可')), `警告=${JSON.stringify(warnings)}`);
  check('IndexedDB拒否後もコメント本文がリロードを越えて残る',
    persisted && persisted.note === 'IndexedDB拒否でも残す本文');
  check('IndexedDB拒否後も画像サムネイルがリロードを越えて残る',
    persisted && persisted.images === 1 && /^data:image\//.test(persisted.thumb || ''));
  check('IndexedDB拒否検査でJSエラーが出ない', errors.length === 0, errors.join(' / '));
  await context.close();
}

await browser.close();
for (const line of ok) console.log('  OK  ' + line);
for (const line of fails) console.log('  NG  ' + line);
console.log(`\n環境回帰チェック: ${ok.length}件OK / ${fails.length}件NG`);
process.exit(fails.length ? 1 : 0);
