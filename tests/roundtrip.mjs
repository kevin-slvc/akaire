#!/usr/bin/env node
// サンプルを実ブラウザで開き、レビューの往復が1周するかを通しで確かめる。
// 実行: node tests/roundtrip.mjs （npm test から呼ばれる。playwright が要る）
//
// 合成イベントではなく実マウス入力（page.mouse）で操作する。合成した
// MouseEvent は pageX/pageY にスクロール量が乗らず、実装が正しくても
// 壊れて見えることがあるため。

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = path.join(ROOT, 'examples/sample-review.html');

const fails = [];
const ok = [];
const check = (name, cond, detail) => (cond ? ok : fails).push(detail ? `${name} — ${detail}` : name);

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));

await page.goto(pathToFileURL(SAMPLE).href);
await page.waitForTimeout(600);

// 1. data-rv-default="on" があるので、#rv を打たずに出る
check('印なしで層が出る（data-rv-default）', await page.locator('#rvbar').isVisible().catch(() => false));
check('版数が window.__rv に出ている',
  !!(await page.evaluate(() => window.__rv && window.__rv.version)));

const skip = page.locator('text=もう出さない').first();
if (await skip.isVisible().catch(() => false)) { await skip.click(); await page.waitForTimeout(200); }

async function drag(from, to, steps = 20) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps);
    await page.waitForTimeout(8);
  }
  await page.mouse.up();
  await page.waitForTimeout(350);
}

async function save(label, note) {
  if (!await page.locator('#rvpop').isVisible().catch(() => false)) {
    check(label, false, 'コメント欄が開かなかった');
    return;
  }
  const quote = ((await page.locator('#rvquote').textContent()) || '').trim();
  await page.locator('#rvnote').fill(note);
  await page.locator('#rvsave').click();
  await page.waitForTimeout(350);
  check(label, quote.length > 0, `引用=${quote.slice(0, 30)}`);
}

// 2. 文字を選ぶ
{
  const b = await page.locator('strong', { hasText: '月あたり約12時間' }).first().boundingBox();
  await drag({ x: b.x + 2, y: b.y + b.height / 2 }, { x: b.x + b.width - 2, y: b.y + b.height / 2 });
  await save('文字選択でコメントできる', '本文の数字が表の合計と合っていない');
}

// 3. 枠で表を選ぶ
{
  await page.locator('#rvpick').click();
  await page.waitForTimeout(200);
  const b = await page.locator('table').first().boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(400);
  await save('枠でブロックを選べる', '単位が混ざっていて比較できない');
}

// 4. Option+ドラッグで図を囲む
{
  const f0 = await page.locator('figure').first().boundingBox();
  await page.evaluate(y => window.scrollTo(0, y - 120), f0.y);
  await page.waitForTimeout(300);
  const f = await page.locator('figure').first().boundingBox();
  await page.keyboard.down('Alt');
  await drag({ x: f.x + 10, y: f.y + 10 }, { x: f.x + f.width - 10, y: f.y + f.height - 10 });
  await page.keyboard.up('Alt');
  await save('Option+ドラッグで範囲を囲める', '縦軸が0から始まっていない');
}

// 5. コピー文にIDが載る（AIへ渡す本体）
const out = await page.evaluate(() => window.__rv.copyText());
const ids = [...new Set([...out.matchAll(/\bc\d{13}[a-z0-9]+/g)].map(m => m[0]))];
check('コピー文に3件ぶんのIDが載る', ids.length === 3, `拾えたID=${ids.length}件`);
check('コピー文にAIへの指示が入っている', out.includes('__rvResolved'));

// 6. 済み消し込み — 実際の流れどおりファイルへ埋めて開き直す
//    （window.__rvResolved を JS で代入してからリロードしても、変数はリロードで消える）
if (ids.length === 3) {
  const orig = fs.readFileSync(SAMPLE, 'utf8');
  try {
    const tag = `<script>window.__rvResolved={rev:"rTEST${Date.now()}",ids:${JSON.stringify(ids)}}<\/script>\n`;
    fs.writeFileSync(SAMPLE, orig.replace('</body>', tag + '</body>'));
    await page.reload();
    await page.waitForTimeout(700);
    const count = (await page.locator('#rvcount').textContent()) || '';
    check('__rvResolved で3件とも済みへ落ちる', /0件|済み 3件/.test(count), `バー表示=${count.trim()}`);
  } finally {
    fs.writeFileSync(SAMPLE, orig);
  }
  check('サンプルを元の内容へ戻せた', fs.readFileSync(SAMPLE, 'utf8') === orig);
}

check('JSエラーが出ていない', errors.length === 0, errors.join(' / '));

await browser.close();
for (const line of ok) console.log('  OK  ' + line);
for (const line of fails) console.log('  NG  ' + line);
console.log(`\n実走チェック: ${ok.length}件OK / ${fails.length}件NG`);
process.exit(fails.length ? 1 : 0);
