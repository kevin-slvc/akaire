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

// 2a. 印のクリックは既存コメント、印の上のドラッグは独立した新規コメント
{
  const mark = page.locator('mark.rv').first();
  await mark.click();
  await page.waitForTimeout(250);
  // 既存コメントを開いたときの入力欄はv1.6以降「追記」が既定なので空。本文はスレッド側に出る。
  const opened = ((await page.locator('#rvthread').textContent()) || '');
  check('印のクリックで既存コメントを開く',
    opened.includes('本文の数字が表の合計と合っていない'), `スレッド=${opened.slice(0, 40)}`);
  await page.locator('#rvcancel').click();
  await page.waitForTimeout(200);

  const b = await mark.boundingBox();
  await drag({ x: b.x + 2, y: b.y + b.height / 2 },
             { x: b.x + b.width - 2, y: b.y + b.height / 2 });
  await save('印の上のドラッグで新規コメントを立てられる', '同じ箇所への独立した2件目');
  const samePlace = await page.evaluate(() => ({
    count: window.__rv.store.comments.length,
    first: window.__rv.store.comments[0].quote,
    second: window.__rv.store.comments[1].quote
  }));
  check('印の上のドラッグは既存コメントへの追記にしない', samePlace.count === 2);
  check('印の表示番号を新規コメントの引用へ混ぜない', samePlace.second === samePlace.first,
    `1件目=${samePlace.first} / 2件目=${samePlace.second}`);
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
check('重なった印を再描画しても番号だけが本文へ漏れない',
  await page.evaluate(() => [...document.querySelectorAll('.rvnum')]
    .every(n => !!n.closest('mark.rv'))));

// 5. コピー文にIDが載る（AIへ渡す本体）
const out = await page.evaluate(() => window.__rv.copyText());
const ids = [...new Set([...out.matchAll(/\bc\d{13}[a-z0-9]+/g)].map(m => m[0]))];
check('コピー文に4件ぶんのIDが載る', ids.length === 4, `拾えたID=${ids.length}件`);
check('コピー文にAIへの指示が入っている', out.includes('__rvResolved'));
check('コピー文が番号でなくidを指定する', out.includes('ids配列には番号でなくidを入れること'));
check('コピー文が未対応idを除外する', out.includes('対応しなかったコメントのidをidsに含めないこと'));
check('コピー文が読み込み行を保持する', out.includes('rv-layer.js の読み込み行を削除しないこと'));
check('初回コピー文には既存タグの統合指示を出さない', !out.includes('前回分と今回分の和集合'));
const secondRoundOut = await page.evaluate(() => {
  window.__rvResolved = { rev: 'rSECONDROUND', ids: [] };
  return window.__rv.copyText();
});
check('2周目のコピー文だけ既存タグの統合を指示する',
  secondRoundOut.includes('古いタグを消して1つにまとめ') &&
  secondRoundOut.includes('前回分と今回分の和集合') &&
  secondRoundOut.includes('先のidsが一度も処理されず消し込みが黙って落ちる'));
// 和集合だけを伝えると、読み手が「戻す」で再オープンした指摘がAIの手で再び済みへ落ちる。
// 指摘が黙って消える型で、出力を目で読んでも矛盾に気づけないため機械で固定する。
check('2周目の和集合指示に「戻す」分の除外が付いている',
  secondRoundOut.includes('「戻す」で未済みへ戻したもののうち、今回対応していないidは和集合から外すこと'));
await page.evaluate(() => { delete window.__rvResolved; });

// 6. 済み消し込み — 実際の流れどおりファイルへ埋めて開き直す
//    （window.__rvResolved を JS で代入してからリロードしても、変数はリロードで消える）
if (ids.length === 4) {
  const orig = fs.readFileSync(SAMPLE, 'utf8');
  try {
    const tag = `<script>window.__rvResolved={rev:"rTEST${Date.now()}",ids:${JSON.stringify(ids)}}<\/script>\n`;
    fs.writeFileSync(SAMPLE, orig.replace('</body>', tag + '</body>'));
    await page.reload();
    await page.waitForTimeout(700);
    const count = (await page.locator('#rvcount').textContent()) || '';
    check('__rvResolved で4件とも済みへ落ちる', /0件|済み 4件/.test(count), `バー表示=${count.trim()}`);
  } finally {
    fs.writeFileSync(SAMPLE, orig);
  }
  check('サンプルを元の内容へ戻せた', fs.readFileSync(SAMPLE, 'utf8') === orig);
}

// 7. __rvResolved が重複していても処理を止めず、原因と対処を警告する
await page.goto(pathToFileURL(path.join(ROOT, 'tests/fixtures/duplicate-resolved.html')).href);
await page.waitForTimeout(600);
const duplicateToast = (await page.locator('#rvtoast').textContent()) || '';
check('__rvResolved の重複を警告する',
  duplicateToast.includes('__rvResolved が 2個') &&
  duplicateToast.includes('最後の1つしか効きません') &&
  duplicateToast.includes('1つにまとめてください'), `警告=${duplicateToast}`);

check('JSエラーが出ていない', errors.length === 0, errors.join(' / '));

await browser.close();
for (const line of ok) console.log('  OK  ' + line);
for (const line of fails) console.log('  NG  ' + line);
console.log(`\n実走チェック: ${ok.length}件OK / ${fails.length}件NG`);
process.exit(fails.length ? 1 : 0);
