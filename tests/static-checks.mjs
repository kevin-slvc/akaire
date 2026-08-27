#!/usr/bin/env node
// ブラウザを開かずに、ファイル同士の食い違いを突き合わせる検査。
// 実行: node tests/static-checks.mjs （npm test から呼ばれる）
//
// ここに入れているのは「実際に一度やらかした型」だけ。思いつく限りの検査を
// 並べると、落ちても誰も直さない検査が増えて全体が信用されなくなる。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const fails = [];
const ok = [];
const check = (name, cond, detail) => (cond ? ok : fails).push(detail ? `${name} — ${detail}` : name);

const layer = read('rv-layer.js');

// 1. ガイドの全ステップに、そこへ進める呼び出しがあるか
//    v1.21で「動かす」を3番目に挿したとき、後続3箇所が古い番号のまま残り
//    ガイドが途中で止まった。番号での指定をやめた今も、キーの綴り違いで同じ形に戻りうる。
{
  const keys = [...layer.matchAll(/\{k:"([a-z]+)"/g)].map(m => m[1]);
  const advanced = new Set([...layer.matchAll(/guideAdvance\("([a-z]+)"\)/g)].map(m => m[1]));
  check('ガイド: 全ステップに進行の呼び出しがある', keys.length > 0 && keys.every(k => advanced.has(k)),
    `ステップ=${keys.join(',')} / 呼ばれている=${[...advanced].join(',')} / 呼ばれていない=${keys.filter(k => !advanced.has(k)).join(',') || 'なし'}`);
  check('ガイド: 存在しないステップを進めようとしていない',
    [...advanced].every(k => keys.includes(k)),
    `宛先の無い呼び出し=${[...advanced].filter(k => !keys.includes(k)).join(',') || 'なし'}`);
}

// 2. 版数が3箇所で揃っているか（RV_VERSION / package.json / CHANGELOG の先頭）
{
  const v = layer.match(/var RV_VERSION = "([\d.]+)"/)?.[1];
  const header = layer.match(/レビュー注釈レイヤー v([\d.]+)/)?.[1];
  const pkg = JSON.parse(read('package.json')).version;
  const clog = read('CHANGELOG.md').match(/^## v([\d.]+)/m)?.[1];
  check('版数: RV_VERSION と ファイル冒頭', v === header, `${v} vs ${header}`);
  check('版数: RV_VERSION と package.json', pkg === `${v}.0` || pkg === v, `${v} vs ${pkg}`);
  check('版数: RV_VERSION と CHANGELOG 先頭', v === clog, `${v} vs ${clog}`);
}

// 3. rev の案内が秒まで入っているか
//    分止まりだと、同じ分に2回対応したとき2回目の rev が1回目と一致し、
//    二重適用の防止に引っかかって ids すら見られず無視される（エラーは出ない）。
{
  const targets = ['rv-layer.js', 'prompts/apply-review.md', 'specs/review-package.md',
    'specs/resolved-contract.md', 'README.md'];
  const bad = targets.filter(f => /YYYYMMDDHHMM[^S]/.test(read(f)) || /rev:"r\d{12}"/.test(read(f)));
  check('rev: 案内と例が秒精度', bad.length === 0, `分止まりが残っている=${bad.join(',') || 'なし'}`);
}

// 4. 予約IDの一覧が、実装と生成側プロンプトで一致しているか
//    衝突するとレイヤーは起動を中止する。実装だけ増えて雛形が古いと、
//    生成されたHTMLが黙って起動しなくなる。
{
  const impl = new Set([...layer.match(/var RV_RESERVED_IDS = \[([\s\S]*?)\];/)[1]
    .matchAll(/"([a-z]+)"/g)].map(m => m[1]));
  const doc = read('prompts/generate-html.md');
  const missing = [...impl].filter(id => !new RegExp(`\\b${id}\\b`).test(doc));
  check('予約ID: 実装の全IDが generate-html.md に載っている', missing.length === 0,
    `雛形に無い=${missing.join(',') || 'なし'}`);
}

// 5. 同梱HTMLが </body> 直前に読み込み行を持っているか
{
  for (const dir of ['examples', 'templates']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir)).filter(x => x.endsWith('.html'))) {
      const rel = `${dir}/${f}`;
      const s = read(rel);
      const tag = s.match(/<script[^>]*src="[^"]*rv-layer\.js"[^>]*><\/script>/);
      check(`読み込み行: ${rel}`, !!tag && s.indexOf(tag[0]) < s.lastIndexOf('</body>'),
        tag ? '' : '読み込み行が無い');
    }
  }
}

for (const line of ok) console.log('  OK  ' + line);
for (const line of fails) console.log('  NG  ' + line);
console.log(`\n静的チェック: ${ok.length}件OK / ${fails.length}件NG`);
process.exit(fails.length ? 1 : 0);
