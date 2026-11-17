#!/usr/bin/env node
// v1.34: ブロックをまたぐ選択・ダークモードの入力欄・バーを畳む を実ブラウザで確かめる。
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL = pathToFileURL(path.join(ROOT, 'tests/fixtures/multi-block-dark.html')).href + '#rv';
const fails = [], ok = [];
const check = (name, cond, detail) => (cond ? ok : fails).push(detail ? `${name} — ${detail}` : name);

const browser = await chromium.launch();
async function open(dark) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: dark ? 'dark' : 'light' });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(String(e)));
  await page.goto(URL); await page.waitForTimeout(600);
  const skip = page.locator('text=もう出さない').first();
  if (await skip.isVisible().catch(() => false)) { await skip.click(); await page.waitForTimeout(200); }
  return { ctx, page, errs };
}
async function select(page, fromSel, fromDx, toSel, toDx) {
  const a = await page.locator(fromSel).boundingBox(), b = await page.locator(toSel).boundingBox();
  await page.mouse.move(a.x + fromDx, a.y + a.height / 2); await page.mouse.down();
  await page.mouse.move(b.x + toDx, b.y + b.height / 2, { steps: 10 }); await page.mouse.up();
  await page.waitForTimeout(300);
}

// ダークモード: 入力欄の背景と文字が同じ明るさに寄らない
{
  const { ctx, page } = await open(true);
  await select(page, '#p1', 5, '#p1', 120);
  const [bg, fg] = await page.evaluate(() => { const s = getComputedStyle(document.getElementById('rvnote')); return [s.backgroundColor, s.color]; });
  const lum = c => { const [r, g, b] = c.match(/\d+/g).map(Number); return (r * 299 + g * 587 + b * 114) / 1000; };
  check('ダークモードで入力欄が読める', Math.abs(lum(bg) - lum(fg)) > 120, `背景=${bg} 文字=${fg}`);
  await ctx.close();
}

// 段落・リスト・段落をまたぐ選択
{
  const { ctx, page, errs } = await open(false);
  await select(page, '#p1', 60, '#p2', 100);
  const quote = await page.locator('#rvquote').textContent();
  check('選択が最初の段落で切れない', quote.includes('リスト二行目') && quote.includes('二つ目'), JSON.stringify(quote));
  await page.locator('#rvnote').fill('複数行テスト'); await page.click('#rvsave'); await page.waitForTimeout(300);
  const state = () => page.evaluate(() => ({
    marks: document.querySelectorAll('mark.rv').length,
    ids: new Set([...document.querySelectorAll('mark.rv')].map(m => m.dataset.id)).size,
    nums: document.querySelectorAll('.rvnum').length,
    li: [...document.querySelector('ul').children].map(c => c.tagName).join(','),
    orphan: getComputedStyle(document.getElementById('rvorphan')).display,
  }));
  let s = await state();
  check('ブロックごとに印が付き1件として数える', s.marks >= 3 && s.ids === 1 && s.nums === 1, JSON.stringify(s));
  check('リストの構造を壊さない', s.li === 'LI,LI', s.li);
  await page.reload(); await page.waitForTimeout(800);
  s = await state();
  check('再読み込み後も同じ位置に付く', s.marks >= 3 && s.ids === 1 && s.orphan === 'none', JSON.stringify(s));
  await page.locator('#l2 mark.rv').first().click(); await page.waitForTimeout(300);
  check('途中のブロックの印から開ける', (await page.locator('#rvthread').textContent()).includes('複数行テスト'));
  check('JSエラーなし', errs.length === 0, errs.join(' / '));
  await ctx.close();
}

// バーを畳む
{
  const { ctx, page } = await open(false);
  const full = await page.locator('#rvbar').boundingBox();
  await page.click('#rvmin'); await page.waitForTimeout(150);
  const min = await page.locator('#rvbar').boundingBox();
  check('−で丸1つに畳まれる', min.width <= 60 && min.height <= 60 && full.width > 200, `${full.width}→${min.width}x${min.height}`);
  await page.reload(); await page.waitForTimeout(600);
  check('畳んだ状態を覚える', (await page.locator('#rvbar').boundingBox()).width <= 60);
  await page.click('#rvexpand'); await page.waitForTimeout(150);
  check('丸を押すと元に戻る', (await page.locator('#rvbar').boundingBox()).width > 200);
  await ctx.close();
}

// DIVが数千個あるページで、切り取りの保存とスクロール後の描き直しが固まらない
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(String(e)));
  await page.goto(pathToFileURL(path.join(ROOT, 'tests/fixtures/large-dom.html')).href + '#rv');
  await page.waitForTimeout(600);
  const skip = page.locator('text=もう出さない').first();
  if (await skip.isVisible().catch(() => false)) { await skip.click(); await page.waitForTimeout(200); }
  await page.evaluate(() => window.scrollTo(0, 3000)); await page.waitForTimeout(200);
  await page.keyboard.down('Alt'); await page.mouse.move(60, 300); await page.mouse.down();
  await page.mouse.move(400, 420, { steps: 12 }); await page.mouse.up(); await page.keyboard.up('Alt');
  await page.waitForFunction(() => document.getElementById('rvpop').style.display === 'block');
  const ms = await page.evaluate(() => { document.getElementById('rvnote').value = '大きいページ'; const t = performance.now(); document.getElementById('rvsave').click(); return Math.round(performance.now() - t); });
  check('大きいページでも保存が2秒以内に終わる', ms < 2000, `${ms}ms / DIV ${await page.evaluate(() => document.querySelectorAll('div').length)}個`);
  const boxAt = () => page.evaluate(() => { const b = document.querySelector('#rvmarks .rvbox'); if (!b) return null; const r = b.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y)]; });
  const b0 = await boxAt();
  check('保存した枠がドラッグした位置に出る', b0 && Math.abs(b0[0] - 60) <= 2 && Math.abs(b0[1] - 300) <= 2, JSON.stringify(b0));
  await page.evaluate(() => window.scrollBy(0, 100)); await page.waitForTimeout(200);
  const b1 = await boxAt();
  check('スクロールに枠が付いてくる', b1 && Math.abs(b1[1] - (b0[1] - 100)) <= 2, JSON.stringify(b1));
  check('大きいページでJSエラーなし', errs.length === 0, errs.join(' / '));
  await ctx.close();
}

await browser.close();
ok.forEach(m => console.log('  OK  ' + m));
fails.forEach(m => console.log('  NG  ' + m));
console.log(`v1.34チェック: ${ok.length}件OK / ${fails.length}件NG`);
process.exit(fails.length ? 1 : 0);
