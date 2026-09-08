#!/usr/bin/env node
// roundtrip.mjs と同じ Chromium・file URL・実マウス入力で辞書を確認する。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(ROOT, 'tests/fixtures/.dict-run.html');
const source = fs.readFileSync(path.join(ROOT, 'examples/sample-review.html'), 'utf8');
const fails = [], ok = [], errors = [];
const check = (name, cond) => (cond ? ok : fails).push(name);
const writeFixture = seed => fs.writeFileSync(fixture, source.replace('../rv-layer.js', '../../rv-layer.js')
  .replace('data-rv-default="on"', `data-rv-default="on" data-rv-dict="${seed}"`));
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
page.on('pageerror', e => errors.push(String(e)));
page.on('dialog', d => d.accept());
const chips = page.locator('.rvdictinsert');
const note = page.locator('#rvnote');
const items = () => chips.allTextContents();
const stored = () => page.evaluate(() => localStorage.getItem('rv-layer:dict'));
async function open() {
  await page.locator('#rvpick').click();
  const b = await page.locator('table').first().boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.locator('#rvpop').waitFor({ state: 'visible' });
}
async function reload() {
  await note.fill('');
  await page.reload();
  await open();
}
async function register(text, expected) {
  await note.fill(text);
  await page.locator('#rvdictadd').click();
  check(`登録トースト: ${expected}`, await page.locator('#rvtoast').textContent() === expected);
}
const layout = () => page.evaluate(() => {
  const row = document.querySelector('#rvdict');
  const scroller = row.querySelector('.rvdictscroll');
  return { y: [...row.querySelectorAll('.rvdictchip')].map(c => c.getBoundingClientRect().top),
    height: row.offsetHeight, scroll: scroller.scrollWidth > scroller.clientWidth,
    fade: scroller.classList.contains('rvmore'),
    thread: document.querySelector('#rvthread').style.maxHeight,
    addX: document.querySelector('#rvdictadd').getBoundingClientRect().left };
});
try {
  writeFixture(' 太文字にして |文字色つけて||太文字にして|無くして');
  await page.goto(pathToFileURL(fixture).href);
  const skip = page.locator('text=もう出さない').first();
  if (await skip.isVisible()) await skip.click();
  await open();
  check('種: trim・空除外・重複先勝ち', JSON.stringify(await items()) === JSON.stringify(['太文字にして', '文字色つけて', '無くして']));
  check('種を読むだけでは保存しない', await stored() === null);
  const three = await layout();
  check('3件は1行', new Set(three.y).size === 1);
  await chips.first().click();
  check('空欄へのクリック挿入・フォーカス・末尾カーソル', await note.inputValue() === '太文字にして' && await note.evaluate(n => document.activeElement === n && n.selectionStart === n.value.length && n.selectionEnd === n.value.length));
  await chips.nth(1).click();
  check('既存の文へ改行付きで挿入・保存はしない', await note.inputValue() === '太文字にして\n文字色つけて' && await page.evaluate(() => window.__rv.store.comments.length) === 0);
  await note.fill('前の文');
  check('番号は通常非表示', !await page.locator('.rvdictbadge').first().isVisible());
  await page.keyboard.down('Control');
  check('Ctrlを押している間は番号表示', await page.locator('.rvdictbadge').first().isVisible());
  await page.keyboard.press('1');
  await page.keyboard.up('Control');
  await page.locator('#rvpop').waitFor({ state: 'hidden' });
  check('Ctrl+1で改行挿入して保存', await page.evaluate(() => window.__rv.store.comments[0].note) === '前の文\n太文字にして');
  await page.keyboard.press('Control+1');
  check('閉じている間はCtrl+1が効かない', await page.evaluate(() => window.__rv.store.comments.length) === 1);
  await page.locator('.rvbadge').first().click();
  await page.locator('#rvpop').waitFor({ state: 'visible' });
  check('Ctrlを離すと番号非表示', !await page.locator('.rvdictbadge').first().isVisible());
  await page.keyboard.down('Control');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  check('blurでも番号非表示', !await page.locator('.rvdictbadge').first().isVisible());
  await page.keyboard.up('Control');
  await register('  ', '入力欄に書いてから＋を押すと辞書になる');
  await register('一行目\n二行目', '1行の文だけ辞書にできる');
  await register('あ'.repeat(21), '辞書は20文字まで');
  await register('太文字にして', 'もう辞書にあります');
  check('重複チップを光らせる', await page.locator('.rvdictflash').count() === 1);
  await page.waitForTimeout(650);
  check('重複の強調は消える', await page.locator('.rvdictflash').count() === 0);
  await register('  余白を広げて  ', '辞書に足しました（4件）');
  check('登録はtrim・入力欄は保持', (await items())[3] === '余白を広げて' && await note.inputValue() === '  余白を広げて  ');
  const four = await layout();
  check('4件は行優先で2行', four.y[0] === four.y[1] && four.y[1] === four.y[2] && four.y[3] > four.y[0] && four.height > three.height);
  check('スレッド欄から辞書の実測高さを引く', four.thread.includes(String(340 + four.height)));
  await register('い'.repeat(20), '辞書に足しました（5件）');
  await register('う'.repeat(20), '辞書に足しました（6件）');
  await register('七件目', '辞書は6件まで。使わないものを×で外して');
  check('7件目を拒否し順番保持', (await items()).length === 6 && (await items())[0] === '太文字にして');
  const wide = await layout();
  check('長いチップは横スクロール・右端フェード', wide.scroll && wide.fade);
  await page.locator('.rvdictscroll').evaluate(s => { s.scrollLeft = s.scrollWidth; });
  await page.waitForTimeout(100);
  const end = await layout();
  check('＋はスクロールしても固定・右端到達でフェード消去', end.addX === wide.addX && !end.fade);
  await note.fill('');
  await chips.first().hover();
  await page.locator('.rvdictremove').first().click();
  check('削除トースト', await page.locator('#rvtoast').textContent() === '「太文字にして」を辞書から外しました');
  await reload();
  check('削除後reloadでも復活しない', !(await items()).includes('太文字にして'));
  writeFixture('別の既定語');
  await reload();
  check('保存済みなら属性を無視', !(await items()).includes('別の既定語'));
  while (await chips.count()) {
    await chips.first().hover();
    await page.locator('.rvdictremove').first().click();
  }
  await reload();
  check('空の辞書も保存し種を復活させない', await chips.count() === 0 && await page.locator('#rvdictadd').textContent() === '＋ 定型句' && await stored() === '{"v":1,"items":[]}');
  await page.evaluate(() => localStorage.setItem('rv-layer:dict', '{broken'));
  writeFixture('あいうえおかきくけこさしすせそたちつてとな|一|二|三|四|五|六|七');
  await reload();
  check('壊れたJSONは種へ戻る・21文字除外・上限6件', JSON.stringify(await items()) === JSON.stringify(['一','二','三','四','五','六']));
  check('JSエラーなし', errors.length === 0);
} finally {
  await browser.close();
  fs.rmSync(fixture, { force: true });
}
for (const line of ok) console.log('  OK  ' + line);
for (const line of fails) console.log('  NG  ' + line);
console.log(`\n辞書チェック: ${ok.length}件OK / ${fails.length}件NG`);
process.exit(fails.length ? 1 : 0);
