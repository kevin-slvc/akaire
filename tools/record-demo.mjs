// docs/demo.mp4 を撮り直すためのスクリプト。UIやボタン名を変えたら走らせ直す。
//
//   cd html-review-loop
//   python3 -m http.server 8765 &
//   npm i -D playwright && npx playwright install chromium
//   node tools/record-demo.mjs ./out          # out/ にwebmが出る
//   ffmpeg -i out/*.webm -vf "scale=1280:800,fps=24" -c:v libx264 \
//     -pix_fmt yuv420p -crf 26 -movflags +faststart -an docs/demo.mp4
//
// 撮るのは docs/demo-page.html（テンプレートに例の文章を入れただけのデモ用ページ）。
// 字幕はページへ差し込む固定の帯で、録画にそのまま焼き付く。マウスは見えないので
// 赤い点を追従させている。どちらもデモ専用で、レビュー層本体とは関係がない。

import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const BASE = 'http://localhost:8765/docs/demo-page.html';
const OUT  = process.argv[2];
const W = 1280, H = 800;

const CURSOR = `
(() => {
  if (document.getElementById('__demoCursor')) return;
  const c = document.createElement('div');
  c.id = '__demoCursor';
  c.style.cssText = 'position:fixed;left:-50px;top:-50px;width:18px;height:18px;'
    + 'border-radius:50%;background:rgba(220,40,60,.55);border:2px solid #fff;'
    + 'box-shadow:0 0 0 1px rgba(0,0,0,.35);z-index:2147483647;pointer-events:none;'
    + 'transform:translate(-50%,-50%);transition:width .12s,height .12s';
  document.body.appendChild(c);
  addEventListener('mousemove', e => { c.style.left = e.clientX+'px'; c.style.top = e.clientY+'px'; }, true);
  addEventListener('mousedown', () => { c.style.width='30px'; c.style.height='30px'; }, true);
  addEventListener('mouseup',   () => { c.style.width='18px'; c.style.height='18px'; }, true);
})();`;

const CAPTION = `
(() => {
  if (document.getElementById('__demoCap')) return;
  const d = document.createElement('div');
  d.id = '__demoCap';
  d.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483646;'
    + 'background:#101828;color:#fff;padding:14px 22px;font-size:19px;line-height:1.5;'
    + "font-family:'Hiragino Sans','Noto Sans JP',sans-serif;font-weight:600;letter-spacing:.02em;"
    + 'box-shadow:0 2px 12px rgba(0,0,0,.3);min-height:56px;display:flex;align-items:center';
  document.body.appendChild(d);
  document.body.style.paddingTop = '62px';
})();`;

const run = async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: {width: W, height: H},
    recordVideo: {dir: OUT, size: {width: W, height: H}},
    deviceScaleFactor: 1
  });
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept().catch(()=>{}));
  // 字幕ファイル（srt/vtt）を作るための時刻。録画はページ生成の時点から始まる
  const t0 = Date.now();
  const cues = [];

  let resolvedIds = [];
  await ctx.route('**/demo-page.html*', async route => {
    const res = await route.fetch();
    let body = await res.text();
    if (resolvedIds.length) {
      body = body.replace('</body>',
        '<script>window.__rvResolved={rev:"demo1",ids:' + JSON.stringify(resolvedIds) + '}</script>\n</body>');
    }
    route.fulfill({status: 200, contentType: 'text/html; charset=utf-8', body});
  });

  const setup = async () => { await page.evaluate(CURSOR); await page.evaluate(CAPTION); };
  const cap = async (t, ms=0) => {
    await page.evaluate(s => { const d=document.getElementById('__demoCap'); if(d) d.textContent = s; }, t);
    cues.push({start: (Date.now() - t0) / 1000, text: t});
    if (ms) await page.waitForTimeout(ms);
  };
  const moveTo = async (x, y, steps=22) => { await page.mouse.move(x, y, {steps}); await page.waitForTimeout(180); };
  const clickAt = async (x, y) => { await moveTo(x, y); await page.mouse.down(); await page.waitForTimeout(120); await page.mouse.up(); await page.waitForTimeout(350); };
  const box = async sel => page.evaluate(s => { const r = document.querySelector(s).getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2, l:r.left, t:r.top, w:r.width, h:r.height}; }, sel);
  const typeIn = async (sel, text) => { await page.click(sel); for (const ch of text) { await page.type(sel, ch, {delay: 0}); await page.waitForTimeout(38); } };

  // --- 0. 導入 ---
  await page.goto(BASE);
  await page.waitForTimeout(400);
  await setup();
  await cap('AIに書かせたHTML。直したいところが必ず出てくる。', 3200);
  await cap('URLの末尾に #rv を付けて開く。これだけ。', 2200);

  await page.evaluate(() => { try{ localStorage.clear(); }catch(e){} });
  await page.goto(BASE + '?rv=1');
  await page.waitForTimeout(700);
  await setup();
  await cap('右下にバーが出た。左下は初回だけ出る使い方の案内。', 3600);

  // --- 1. テキスト選択 ---
  await cap('気になった一文をドラッグして選ぶ。', 1400);
  const lead = await box('#intro .lead');
  await moveTo(lead.l + 18, lead.t + 14);
  await page.mouse.down();
  for (let s = 1; s <= 14; s++) { await page.mouse.move(lead.l + 18 + s*26, lead.t + 14, {steps:3}); await page.waitForTimeout(38); }
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(700);
  await cap('選んだ場所にコメント欄が開く。', 1400);
  await typeIn('#rvnote', 'ここ、結論が2文に割れてる。1文にまとめたい');
  await page.waitForTimeout(600);
  await cap('保存すると、選んだところに印と番号が付く。', 1600);
  const save = await box('#rvsave');
  await clickAt(save.x, save.y);
  await page.waitForTimeout(2200);

  // --- 2. 枠 ---
  await cap('表や図はドラッグでは選べない。バーの〈枠〉を押す。', 2400);
  const pick = await box('#rvpick');
  await clickAt(pick.x, pick.y);
  await page.evaluate(() => document.querySelector('table').scrollIntoView({block:'center'}));
  await page.waitForTimeout(700);
  await cap('そのままクリックすると、表を丸ごと選べる。', 1600);
  const tb = await box('table');
  await moveTo(tb.x, tb.t + 30);
  await cap('押した先の表が枠で囲まれる。ここで確定。', 2200);
  await page.mouse.down(); await page.waitForTimeout(120); await page.mouse.up();
  await page.waitForTimeout(800);
  await typeIn('#rvnote', '担当が「未定」のままの行がある。埋めるか行ごと落とす');
  await page.waitForTimeout(500);
  const save2 = await box('#rvsave');
  await clickAt(save2.x, save2.y);
  await page.waitForTimeout(1200);

  // --- 3. Option+ドラッグで範囲を囲む ---
  await cap('文字でも要素でもない場所は、Optionを押しながらドラッグ。', 2600);
  await page.evaluate(() => document.querySelector('.cards').scrollIntoView({block:'center'}));
  await page.waitForTimeout(700);
  // カード2枚をまたぐ範囲を囲む（文字でも1要素でもない＝切り取りが要る場面）
  const drag = await page.evaluate(() => {
    const cs = document.querySelectorAll('.cards .card');
    const a = cs[0].getBoundingClientRect(), b = cs[1].getBoundingClientRect();
    return {x1: a.left - 8, y1: a.top - 10, x2: b.right + 8, y2: b.bottom + 10};
  });
  await moveTo(drag.x1, drag.y1);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  const stepsN = 14;
  for (let s = 1; s <= stepsN; s++) {
    await page.mouse.move(drag.x1 + (drag.x2-drag.x1)*s/stepsN,
                          drag.y1 + (drag.y2-drag.y1)*s/stepsN, {steps:3});
    await page.waitForTimeout(45);
  }
  await page.waitForTimeout(700);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await page.waitForTimeout(900);
  await cap('写真の切り取りのように、好きな範囲を四角く囲める。', 2000);
  await typeIn('#rvnote', 'この並びだけ余白が詰まって見える');
  await page.waitForTimeout(500);
  const save3 = await box('#rvsave');
  await clickAt(save3.x, save3.y);
  await page.waitForTimeout(1600);

  // --- 4. コピー ---
  await cap('書き終えたらバーの〈コピー〉。', 1800);
  await page.evaluate(() => window.scrollTo({top:0, behavior:'instant'}));
  await page.waitForTimeout(400);
  const copy = await box('#rvcopy');
  await clickAt(copy.x, copy.y);
  await page.waitForTimeout(900);
  await cap('AIに貼るだけの文面ができている。', 1000);
  await page.evaluate(() => {
    const t = window.__rv.copyText().split('\n').slice(0, 16).join('\n');
    const d = document.createElement('pre');
    d.id = '__demoPre';
    d.textContent = t;
    d.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147483645;'
      + 'width:800px;max-height:520px;overflow:hidden;background:#0b1220;color:#d6e2f5;'
      + 'padding:20px 24px;border-radius:10px;font-size:13px;line-height:1.7;white-space:pre-wrap;'
      + "font-family:ui-monospace,Menlo,monospace;box-shadow:0 20px 60px rgba(0,0,0,.5)";
    document.body.appendChild(d);
  });
  await page.waitForTimeout(6500);
  await page.evaluate(() => { const d = document.getElementById('__demoPre'); if (d) d.remove(); });

  // --- 5. 済み消し込み ---
  await cap('AIが直したHTMLには、対応済みの印が入って返ってくる。', 2600);
  // 2件のうち1件だけ直った状態を作る。全部消すと「何が残っているか」が見えない
  resolvedIds = await page.evaluate(() => window.__rv.store.comments.slice(0, 1).map(c => c.id));
  await page.goto(BASE);
  await page.waitForTimeout(900);
  await setup();
  await cap('開き直すと、直った指摘は自動で「済み」へ落ちる。', 3000);
  const done = await box('#rvdone');
  await clickAt(done.x, done.y);
  await page.waitForTimeout(2600);
  await cap('バーに残るのは、まだ直っていないぶんだけ。これをまた渡す。', 4200);

  const total = (Date.now() - t0) / 1000;
  await page.close();
  await ctx.close();
  await browser.close();

  // 字幕。各行は次の行が出るまで表示していたので、そのまま終了時刻にする
  const ts = sec => {
    const h = String(Math.floor(sec/3600)).padStart(2,'0');
    const m = String(Math.floor(sec%3600/60)).padStart(2,'0');
    const s2 = String(Math.floor(sec%60)).padStart(2,'0');
    const ms = String(Math.round((sec%1)*1000)).padStart(3,'0');
    return {h, m, s: s2, ms};
  };
  const srtT = sec => { const t = ts(sec); return `${t.h}:${t.m}:${t.s},${t.ms}`; };
  const vttT = sec => { const t = ts(sec); return `${t.h}:${t.m}:${t.s}.${t.ms}`; };
  const lines = cues.map((c, i) => ({...c, end: i+1 < cues.length ? cues[i+1].start : total}));
  const srt = lines.map((c, i) =>
    `${i+1}\n${srtT(c.start)} --> ${srtT(c.end)}\n${c.text}\n`).join('\n');
  const vtt = 'WEBVTT\n\n' + lines.map(c =>
    `${vttT(c.start)} --> ${vttT(c.end)}\n${c.text}\n`).join('\n');
  await fs.writeFile(new URL('../docs/demo.srt', import.meta.url), srt, 'utf8');
  await fs.writeFile(new URL('../docs/demo.vtt', import.meta.url), vtt, 'utf8');
  console.log(`captions: ${lines.length} cues / ${total.toFixed(1)}s`);
};
run().then(()=>console.log('done')).catch(e=>{ console.error(e); process.exit(1); });
