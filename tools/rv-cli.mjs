#!/usr/bin/env node
/*
 * rv-cli — レビュー注釈レイヤーの取り外し / 戻し
 *
 *   node tools/rv-cli.mjs strip   <file.html> [...]   層を外す（元は .rvbak へ退避）
 *   node tools/rv-cli.mjs restore <file.html> [...]   層を戻す
 *   node tools/rv-cli.mjs status  <file.html> [...]   今どちらか見る
 *
 * .rvbak を持たないファイル（このCLIを通さずに読み込み行が消えたもの）の restore は
 * </body> の直前に <script src="...rv-layer.js"></script> を入れ直す（コメントは
 * ブラウザ側に残っているので、開き直せば元の注釈が戻る）。
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve, relative, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

// rv-layer.js の在り処。このスクリプトと同じ階層に置く配置と、本体をリポジトリの
// ルート・CLIを tools/ に置く配置の、どちらでも解決できるようにする
const HERE = dirname(fileURLToPath(import.meta.url));
const LAYER = [resolve(HERE, "rv-layer.js"), resolve(HERE, "..", "rv-layer.js")]
  .find(p => existsSync(p)) || resolve(HERE, "rv-layer.js");
const SCRIPT_RE = /[ \t]*<script[^>]*\bsrc=["'][^"']*rv-layer\.js(?:\?[^"']*)?["'][^>]*>\s*<\/script>[ \t]*\r?\n?/gi;
const RESOLVED_RE = /[ \t]*<script\b[^>]*>\s*window\.__rvResolved\s*=[\s\S]*?<\/script>[ \t]*\r?\n?/gi;

// /g付き正規表現は lastIndex を持ち越すので、判定のたびに戻す
function has(html) { SCRIPT_RE.lastIndex = 0; return SCRIPT_RE.test(html); }

// 読み込み行が data-rv-default="on" を持っているか。持っていると、読み手が #rv を
// 打たなくても最初から層が出る＝外部へ出す前に必ず気づきたい状態なので status で言う
const DEFAULT_RE = /<script[^>]*\bsrc=["'][^"']*rv-layer\.js(?:\?[^"']*)?["'][^>]*\bdata-rv-default=["'](?:on|1|true)["'][^>]*>/i;
function defaultOn(html) { return DEFAULT_RE.test(html); }

function relLayer(file) {
  let r = relative(dirname(resolve(file)), LAYER).split(sep).join("/");
  return r.startsWith(".") ? r : "./" + r;
}

function strip(file) {
  const html = readFileSync(file, "utf8");
  const out = html.replace(SCRIPT_RE, "").replace(RESOLVED_RE, "");
  if (out === html) return `そのまま  ${file}（層は入っていない）`;
  writeFileSync(file + ".rvbak", html);
  writeFileSync(file, out);
  return `外した    ${file}（元は ${file}.rvbak）`;
}

function restore(file) {
  const bak = file + ".rvbak";
  if (existsSync(bak)) {
    writeFileSync(file, readFileSync(bak, "utf8"));
    unlinkSync(bak);
    return `戻した    ${file}（.rvbak から。バックアップは消した）`;
  }
  const html = readFileSync(file, "utf8");
  if (has(html)) return `そのまま  ${file}（もう層が入っている）`;
  // .rvbak が無いときは元の書き方が分からないので、素の1行で戻す。
  // 外す前が data-rv-default="on" だった場合、その指定はここでは戻らない
  const tag = `<script src="${relLayer(file)}"></script>`;
  const idx = html.toLowerCase().lastIndexOf("</body>");
  const out = idx === -1 ? html + "\n" + tag + "\n"
                         : html.slice(0, idx) + tag + "\n" + html.slice(idx);
  writeFileSync(file, out);
  return `戻した    ${file}（script 1行を入れ直した。data-rv-default は復元されないので、要るなら書き足す）`;
}

const status = (file) => {
  const html = readFileSync(file, "utf8");
  if (!has(html)) return `層なし          ${file}`;
  if (defaultOn(html)) return `層あり・既定ON  ${file}（開いた人に最初から出る。外部へ出すなら外す）`;
  return `層あり          ${file}`;
};

const [cmd, ...files] = process.argv.slice(2);
const run = { strip, restore, status }[cmd];
if (!run || !files.length) {
  console.error("使い方: node tools/rv-cli.mjs <strip|restore|status> <file.html> [...]");
  process.exit(2);
}
let bad = 0;
for (const f of files) {
  // 対象はHTMLだけ。rv-layer.js 自身にはコメントとして読み込み行の例が書いてあるので、
  // 渡されると status は「層あり」と誤答し、strip はその例文を削ってしまう
  if (!/\.x?html?$/i.test(f)) {
    bad++;
    console.error(`対象外    ${f}（HTMLファイルを渡す）`);
    continue;
  }
  try { console.log(run(f)); }
  catch (e) { bad++; console.error(`失敗      ${f}: ${e.message}`); }
}
process.exit(bad ? 1 : 0);
