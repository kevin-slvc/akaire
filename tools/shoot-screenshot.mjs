// docs/screenshot.png（READMEの先頭に出る1枚）を撮り直すためのスクリプト。
// UIや配色を変えたら走らせ直す。
//
//   cd akaire
//   python3 -m http.server 8765 &
//   npm i -D playwright && npx playwright install chromium
//   node tools/shoot-screenshot.mjs
//
// 出す絵は README の代替テキストと揃えてある。
// 「本文に下線と番号が付き、選択した箇所にコメント入力欄が開いている」

import { chromium } from 'playwright';

const BASE = 'http://localhost:8765/docs/demo-page.html';
const OUT  = new URL('../docs/screenshot.png', import.meta.url).pathname;
const W = 1280, H = 800;

const browser = await chromium.launch();
const page = await browser.newPage({viewport: {width: W, height: H}, deviceScaleFactor: 2});

await page.goto(BASE);
await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
await page.goto(BASE + '?rv=1');
await page.waitForTimeout(700);

// 初回の案内は絵に入れない
await page.evaluate(() => { const s = document.getElementById('rvguideskip'); if (s) s.click(); });
await page.waitForTimeout(300);

const box = sel => page.evaluate(s => {
  const r = document.querySelector(s).getBoundingClientRect();
  return {l: r.left, t: r.top, w: r.width, h: r.height};
}, sel);

const dragOver = async (sel, chars) => {
  const b = await box(sel);
  await page.mouse.move(b.l + 18, b.t + 14);
  await page.mouse.down();
  for (let s = 1; s <= chars; s++) {
    await page.mouse.move(b.l + 18 + s * 26, b.t + 14, {steps: 3});
    await page.waitForTimeout(20);
  }
  await page.mouse.up();
  await page.waitForTimeout(600);
};

const typeIn = async (sel, text) => {
  await page.click(sel);
  await page.type(sel, text, {delay: 12});
};

// 1件目は保存して、印と番号が付いた状態を作る
await dragOver('#intro .lead', 14);
await typeIn('#rvnote', 'ここ、結論が2文に割れてる。1文にまとめたい');
await page.click('#rvsave');
await page.waitForTimeout(1000);

// 2件目は開いたまま。コメント入力欄が見えている状態で撮る
await dragOver('#intro p:nth-of-type(2)', 12);
await typeIn('#rvnote', '直近3か月ぶん、という区切りの根拠を1行足したい');
await page.waitForTimeout(500);

await page.screenshot({path: OUT});
console.log(`wrote ${OUT}`);
await browser.close();
