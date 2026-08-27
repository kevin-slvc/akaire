/*
 * レビュー注釈レイヤー v1.21
 *
 * AIが生成したHTMLを、ブラウザで見たまま指摘し、その指摘をAIへ貼り戻すための
 * 1ファイル完結のスクリプト。外部依存はない。
 *
 * 使い方: HTML側は </body> 直前に
 *   <script src="rv-layer.js"></script>
 * の1行だけでよい。CSS・DOM・ロジックはすべてこのファイルが自己注入する。
 *
 * 出るかどうかは見る側のブラウザが決める。localStorage の "rv-layer:enabled" が
 * 立っているブラウザでしか描画しない。立てるのはURL末尾の #rv または ?rv=1
 * （読んだ直後に history.replaceState で消すので、印付きURLを人へ渡しても伝染しない）、
 * 止めるのは #rv-off または ?rv=0。同じHTMLを相手へ送っても相手の画面には出ないので、
 * 送付の前にファイルから層を外す作業は要らない。
 *
 * できること:
 *   - テキスト選択への指摘（1文字から付けられる）
 *   - 表・カード・図などブロック単位への指摘（「枠」ボタン、または Option+クリック）
 *   - 画面上で矩形に囲った範囲への指摘（切り取り）
 *   - 指摘への画像添付（ペースト / ドロップ）と、指摘への追記
 *   - 未対応の指摘だけをまとめてコピー（AIへそのまま貼れる形）
 *   - 元HTML・review.md・画像を含むzipの保存（「zip」ボタン。別PCや別の人へ渡すときの補助）
 *   - 初めて開いた人にだけ出る6ステップの使い方ガイド（スキップ可・window.__rv.guide()で再表示）
 *
 * 対応済みの反映:
 *   1. 「コピー」で未対応の指摘をAIへ貼る
 *   2. AIが改訂版HTMLの </body> 直前へ
 *      <script>window.__rvResolved={rev:"r<ユニークな値>",ids:["対応したid",...]}</script>
 *      を埋め込む
 *   3. 次回そのページを開いたとき、該当idの指摘が自動で対応済みへ移る
 *      （同じrevは二重に適用しない。「戻す」で未対応へ戻した指摘は、appliedRevs が
 *       効いている限り再度消し込まれない）
 *
 * 版数は RV_VERSION が正本で、バーのhover・window.__rv.version・起動時のconsoleに出る。
 * 変更履歴は CHANGELOG.md を見る。
 *
 * 層そのものをファイルから外したいとき（読み込みのリクエストも出したくない等）は
 * tools/rv-cli.mjs の strip / restore を使う。通常の送付では要らない。
 */
(function(){
"use strict";
if(window.__rvLayerLoaded) return;
window.__rvLayerLoaded = true;

// このHTMLを作った人が「開いた人には最初から出す」と決めているか。
//   <script src="rv-layer.js" data-rv-default="on"></script>
// の1語で指定する。レビューしてほしくて渡すHTMLに付ける想定で、付けなければ従来どおり
// 黙って始まる。見る側の明示指定（#rv / #rv-off）は常にこの指定より強い。
var SELF = document.currentScript ||
  document.querySelector("script[data-rv-default]") || null;
var DEFAULT_ON = !!(SELF &&
  /^(on|1|true)$/i.test(SELF.getAttribute("data-rv-default") || ""));

var LEGACY_DOC = (location.pathname.split("/").pop() || "untitled");
var DOC = location.pathname || "/";
var KEY = "rv:" + DOC;
var LEGACY_KEY = "rv:" + LEGACY_DOC;
var ENABLE_KEY = "rv-layer:enabled";
// 旧キーは「ファイル名だけ」で作られていたため、同名のファイルが複数のパスにあると
// どのページのものか判別できない。最初に取り込んだページを記録し、他のパスでは
// 二度と読まない（読むと同じコメントが各ページへ複製され、別文書のものとして扱われる）。
var GUIDE_KEY = "rv-layer:guide";                   // 初回ガイドを見終えたか（オリジン単位・ページ別ではない）
var guideStep = 0;        // 0=出していない / 1〜4=表示中のステップ
var LEGACY_CLAIM_KEY = "rv-layer:legacy-claimed";   // このブラウザで層を出すかどうか（オリジン単位）
var RV_VERSION = "1.21";   // バーのhoverと window.__rv.version に出す。ヘッダーの版数と揃える
var CTX = 30;             // 前後の文脈として保存する文字数
var ROOT = null;          // init()で確定
var store = {docId:DOC, title:document.title, updated:null, comments:[], appliedRevs:[]};
var memoryOnly = false;   // localStorage が使えない環境でのフォールバック
var noOverwrite = false;  // 読めない保存データがある。上書きしないため書き込みを止める
var seenIds = {};         // このタブが一度でも見た/作ったコメントID。他タブ由来かを見分ける
var seenReplyKeys = {};   // 見た追記が手元に無ければ、このタブで削除したものとして復活を防ぐ
var touchedIds = {};      // このタブで内容・状態・画像を変更したコメントID
var quarantined = [];     // 壊れていて読み込めなかったコメント（捨てずに持っておく）
var editing = null;       // 編集中コメントid
var pending = null;       // 未保存の新規選択
var pop = null;           // #rvpop（buildDOM後に確定）
var popImgs = [];         // 開いているポップアップに付いている画像
var popGen = 0;           // ポップアップの世代。読み込み中の画像が別コメントへ混入するのを防ぐ
var popImgsPending = 0;   // 読み込み中の画像枚数（上限判定に予約計上する）
var MAXIMG = 4;           // 1コメントあたりの画像枚数の上限
var imageDBPromise = null; // IndexedDB接続（使えなければ null を解決する）
var imageWriteTail = Promise.resolve(); // 原寸の保存・削除を順番に完了させる
var imageDBWarned = false;
var picking = false;      // 枠を選んでいる最中か
var pickBase = null;      // カーソル直下の要素
var pickLevel = 0;        // pickBaseから何段親へ上がっているか
var hoverEl = null;       // いま候補になっている枠
var blockItems = [];      // 描画中の枠コメント（リサイズで引き直す）
var dragFrom = null;      // 切り取りの始点（ページ座標）
var dragging = false;     // いま矩形を引いている最中か
var altPick = false;      // Option+ドラッグで一時的に枠モードへ入ったか
var layoutFrame = 0;      // scroll/resizeの連続発火を1描画にまとめる
var layoutObserver = null; // 折りたたみ・遅延描画による寸法変化を拾う
var pendingRange = null;  // コメントを書いている間、対象にしている文字列のレンジ
var editingBody = false;  // 既存コメントを開いているとき、入力欄が本文編集か追記か
var imageDirName = null;  // 選ばれている画像の保存先フォルダ名（未選択・許可切れならnull）

// ---------- CSS 自己注入 ----------
var CSS = ""
// レイヤーは自分で box-sizing を決める。指定しないと対象ページの設定をそのまま受け、
// border-box を敷いていないページでは width:100% の入力欄が padding と border のぶん
// はみ出す（実測18px）。対象ページ側へは影響させないよう、rvの要素だけに閉じる。
+"#rvbar,#rvbar *,#rvpop,#rvpop *,#rvdonepanel,#rvdonepanel *,#rvorphan,#rvorphan *,"
+"#rvguide,#rvguide *,"
+"#rvtoast,#rvmarks,#rvmarks *,#rvsel,#rvsel *,#rvhover,#rvhover *,#rvcrop,#rvcrop *"
+"{box-sizing:border-box}"
+"mark.rv{background:var(--rv-mark,#fdeeee);border-bottom:2px solid var(--rv-accent,#a90000);"
+"padding:1px 0;cursor:pointer;border-radius:2px}"
+"mark.rv:hover{background:var(--rv-mark-hover,#ffdada)}"
+"mark.rv .rvnum{font-size:10px;vertical-align:super;color:var(--rv-accent-hover,#ce0000);"
+"font-weight:700;margin-left:2px;font-family:ui-monospace,Menlo,monospace}"
+"#rvbar{position:fixed;right:20px;bottom:20px;z-index:2147483630;display:flex;gap:8px;"
+"align-items:center;background:var(--rv-inverse,var(--surface-dark,#000000));color:var(--rv-on-inverse,#ffffff);"
+"border-radius:999px;padding:9px 10px 9px 18px;font-size:13px;"
+"box-shadow:0 4px 18px rgba(0,0,0,.22)}"
+"#rvbar button{font:inherit;font-size:12px;border:0;border-radius:999px;"
+"padding:6px 13px;cursor:pointer;background:var(--rv-accent,#a90000);color:#fff}"
+"#rvbar button:hover{background:var(--rv-accent-hover,#ce0000)}"
+"#rvbar button.ghost{background:transparent;color:var(--rv-on-inverse-muted,#b3b3b3);padding:6px 9px}"
+"#rvbar button.ghost:hover{color:var(--rv-on-inverse,#ffffff)}"
+"#rvcount{margin-right:4px;letter-spacing:.02em}"
+"#rvpop{position:absolute;z-index:2147483640;width:290px;background:var(--rv-surface,var(--canvas,#ffffff));"
+"border:1px solid var(--rv-border,var(--hairline,#cccccc));border-radius:10px;padding:12px;"
+"box-shadow:0 8px 26px rgba(0,0,0,.18);display:none}"
+"#rvpop .q{font-size:12px;color:var(--rv-text-muted,var(--muted,#767676));margin:0 0 8px;line-height:1.55;"
+"max-height:52px;overflow:hidden;border-left:2px solid var(--rv-accent,#a90000);padding-left:8px;"
+"cursor:move;user-select:none}"
+"#rvpop.rvmoving{user-select:none}"
+"#rvpop.rvmoving *{user-select:none;cursor:move}"
+"#rvpop textarea{width:100%;min-height:70px;font:inherit;font-size:13px;"
+"border:1px solid var(--rv-border,var(--hairline,#cccccc));border-radius:6px;padding:8px;resize:vertical;"
+"background:#fff;color:var(--rv-text,var(--ink,#1a1a1a))}"
+"#rvpop .row{display:flex;gap:6px;margin-top:8px;justify-content:flex-end}"
+"#rvpop button{font:inherit;font-size:12px;border:0;border-radius:6px;"
+"padding:6px 12px;cursor:pointer;background:var(--rv-accent,#a90000);color:#fff}"
+"#rvpop button.ghost{background:var(--rv-surface-sub,var(--surface-card,#f2f2f2));color:var(--rv-text,var(--body,#1a1a1a))}"
+"#rvdonepanel{position:fixed;right:20px;bottom:70px;z-index:2147483640;width:320px;"
+"max-height:300px;overflow:auto;background:var(--rv-surface,var(--canvas,#ffffff));"
+"border:1px solid var(--rv-border,var(--hairline,#cccccc));border-radius:10px;padding:10px;"
+"box-shadow:0 8px 26px rgba(0,0,0,.18);display:none;font-size:12.5px}"
+"#rvdonepanel .rvdonerow{display:flex;justify-content:space-between;align-items:center;"
+"gap:8px;padding:6px 4px;border-bottom:1px solid var(--rv-border,var(--hairline,#cccccc))}"
+"#rvdonepanel .rvdonerow:last-child{border-bottom:0}"
+"#rvdonepanel .rvdonetxt{flex:1;color:var(--rv-text,var(--body,#1a1a1a));line-height:1.5}"
+"#rvdonepanel .rvdoneopen{cursor:pointer}"
+"#rvdonepanel .rvdoneopen:hover{color:var(--rv-accent-hover,#ce0000);text-decoration:underline}"
+"#rvdonepanel .rvdonerow button{font:inherit;font-size:11px;border:0;border-radius:6px;"
+"padding:4px 9px;cursor:pointer;background:var(--rv-surface-sub,var(--surface-card,#f2f2f2));color:var(--rv-text,var(--body,#1a1a1a))}"
+"#rvdonepanel .rvdoneempty{color:var(--rv-text-muted,var(--muted,#767676));padding:6px 4px}"
+"#rvtoast{position:fixed;left:50%;bottom:78px;transform:translateX(-50%);z-index:2147483646;"
+"background:var(--rv-inverse,var(--surface-dark,#000000));color:var(--rv-on-inverse,#ffffff);padding:9px 18px;border-radius:999px;"
+"font-size:13px;opacity:0;transition:opacity .18s;pointer-events:none}"
+"#rvtoast.on{opacity:1}"
+"#rvorphan{background:var(--rv-danger-bg,#ffeee2);border-left:3px solid var(--rv-danger,#c74700);padding:12px 16px;"
+"border-radius:0 6px 6px 0;margin:0 0 20px;font-size:13.5px;display:none}"
+"#rvpop .rvimgs{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px}"
+"#rvpop .rvimgs figure{position:relative;margin:0;line-height:0}"
+"#rvpop .rvimgs img{width:62px;height:46px;object-fit:cover;border-radius:5px;"
+"border:1px solid var(--rv-border,var(--hairline,#cccccc))}"
+"#rvpop .rvimgs button{position:absolute;top:-6px;right:-6px;width:18px;height:18px;"
+"padding:0;border-radius:999px;font-size:11px;line-height:1;background:var(--rv-inverse,var(--surface-dark,#000000));color:#fff}"
+"#rvpop .rvhint{font-size:11px;color:var(--rv-text-muted,var(--muted,#767676));margin:6px 0 0}"
+"#rvthread{margin:0 0 8px;font-size:12px;line-height:1.5;max-height:150px;overflow:auto}"
+"#rvthread .rvline{display:flex;gap:6px;align-items:flex-start;padding:4px 0;"
+"border-bottom:1px solid var(--rv-border,var(--hairline,#cccccc))}"
+"#rvthread .rvline:last-child{border-bottom:0}"
+"#rvthread .rvtxt{flex:1;white-space:pre-wrap;word-break:break-word;color:var(--rv-text,var(--body,#1a1a1a))}"
+"#rvthread .rvline.rvsub .rvtxt{color:var(--rv-text-muted,var(--muted,#767676));padding-left:10px;"
+"border-left:2px solid var(--rv-border,var(--hairline,#cccccc))}"
+"#rvthread button{flex:0 0 auto;font:inherit;font-size:10px;border:0;border-radius:5px;"
+"padding:2px 6px;cursor:pointer;background:var(--rv-surface-sub,var(--surface-card,#f2f2f2));color:var(--rv-text-muted,var(--muted,#767676))}"
+"#rvthread button:hover{color:var(--rv-text,var(--body,#1a1a1a))}"
+"#rvpop.rvdrag{outline:2px dashed var(--rv-accent,#a90000);outline-offset:3px}"
+"#rvmarks{position:absolute;left:0;top:0;width:0;height:0;z-index:2147483600}"
+"#rvsel{position:absolute;left:0;top:0;width:0;height:0;z-index:2147483615;pointer-events:none}"
+"#rvsel .rvselbox{position:absolute;background:var(--rv-select-fill,rgba(169,0,0,.15));"
+"border:1px dashed var(--rv-accent,#a90000);border-radius:3px;pointer-events:none}"
+"#rvmarks .rvbox{position:absolute;border:2px solid var(--rv-accent,#a90000);border-radius:6px;"
+"background:var(--rv-box-fill,rgba(169,0,0,.06));pointer-events:none}"
+"#rvmarks .rvbadge{position:absolute;top:-11px;left:-11px;pointer-events:auto;width:22px;height:22px;"
+"border:0;border-radius:999px;cursor:pointer;background:var(--rv-accent,#a90000);color:#fff;"
+"font:inherit;font-size:11px;font-weight:700;line-height:22px;padding:0;"
+"font-family:ui-monospace,Menlo,monospace}"
+"#rvhover{position:absolute;z-index:2147483610;pointer-events:none;display:none;"
+"border:2px dashed var(--rv-accent,#a90000);border-radius:6px;background:var(--rv-hover-fill,rgba(169,0,0,.08))}"
+"#rvhover span{position:absolute;top:-21px;left:0;background:var(--rv-inverse,var(--surface-dark,#000000));"
+"color:var(--rv-on-inverse,#ffffff);font-size:10px;padding:2px 8px;border-radius:999px;white-space:nowrap;"
+"font-family:ui-monospace,Menlo,monospace}"
+"body.rvpicking,body.rvpicking *{cursor:crosshair !important}"
+"body.rvpicking{-webkit-user-select:none;user-select:none}"
+"#rvcrop{position:absolute;z-index:2147483620;display:none;pointer-events:none;border-radius:3px;"
+"border:2px solid var(--rv-accent,#a90000);box-shadow:0 0 0 9999px rgba(0,0,0,.38)}"
+"#rvcrop span{position:absolute;bottom:-22px;right:0;background:var(--rv-inverse,var(--surface-dark,#000000));"
+"color:var(--rv-on-inverse,#ffffff);font-size:10px;padding:2px 8px;border-radius:999px;white-space:nowrap;"
+"font-family:ui-monospace,Menlo,monospace}"
// 初回ガイド。バー（右下）と済みパネル（右下・バーの上）と重ならないよう左下に置く。
+"#rvguide{position:fixed;left:20px;bottom:20px;z-index:2147483641;"
+"width:300px;max-width:calc(100vw - 40px);"
+"background:var(--rv-surface,var(--canvas,#ffffff));color:var(--rv-text,var(--ink,#1a1a1a));"
+"border:1px solid var(--rv-border,var(--hairline,#cccccc));border-left:3px solid var(--rv-accent,#a90000);"
+"border-radius:8px;padding:12px 14px;font-size:13px;line-height:1.65;"
+"box-shadow:0 8px 26px rgba(0,0,0,.18);display:none}"
+"#rvguidestep{font-size:11px;letter-spacing:.06em;color:var(--rv-text-muted,var(--muted,#767676));"
+"font-family:ui-monospace,Menlo,monospace;margin-bottom:4px}"
+"#rvguidetxt{margin:0 0 10px}"
+"#rvguide .row{display:flex;gap:6px;justify-content:flex-end;align-items:center}"
+"#rvguide button{font:inherit;font-size:12px;border:0;border-radius:6px;padding:5px 12px;"
+"cursor:pointer;background:var(--rv-accent,#a90000);color:#fff}"
+"#rvguide button.ghost{background:transparent;color:var(--rv-text-muted,var(--muted,#767676));padding:5px 6px}"
+"#rvguide button.ghost:hover{color:var(--rv-text,var(--ink,#1a1a1a))}"
+"@media print{#rvbar,#rvpop,#rvtoast,#rvdonepanel,#rvmarks,#rvsel,#rvhover,#rvcrop,#rvguide"
+"{display:none !important}}";

function injectCSS(){
  var style = document.createElement("style");
  style.setAttribute("data-rv-layer", "1");
  style.textContent = CSS;
  document.head.appendChild(style);
}

// ---------- DOM 自己注入 ----------
var RV_RESERVED_IDS = ["rvorphan","rvbar","rvcount","rvdone","rvcopy","rvexport","rvpick","rvclear",
  "rvpop","rvquote","rvimgs","rvnote","rvdel","rvcancel","rvsave","rvdonepanel","rvdonelist","rvdir",
  "rvthread",
  "rvmarks","rvsel","rvcrop","rvhover","rvtoast",
  "rvguide","rvguidetxt","rvguidestep","rvguidenext","rvguideskip"];
function rvCollisions(){
  var found = [];
  RV_RESERVED_IDS.forEach(function(id){ if(document.getElementById(id)) found.push("#" + id); });
  if(document.querySelector("mark.rv")) found.push("mark.rv");
  if(document.querySelector(".rvnum")) found.push(".rvnum");
  if(document.body.classList.contains("rvpicking")) found.push("body.rvpicking");
  return found;
}
// 名前衝突で起動を止めたとき、理由が画面から見えるようにするバナー。
// injectCSS()より前に呼ばれる経路なので、スタイルは全部インラインで持つ。
// 固定id/固定classは付けない（バナー自身が次の衝突源にならないようにするため。
// クローズは要素参照のクロージャで持ち、id探索に頼らない）。
function showCollisionBanner(names){
  var bar = document.createElement("div");
  bar.setAttribute("role", "alert");
  bar.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;" +
    "background:#3a2a20;color:var(--rv-on-inverse,#ffffff);" +
    "font:13px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;" +
    "padding:10px 44px 10px 14px;box-sizing:border-box;" +
    "box-shadow:0 2px 10px rgba(0,0,0,.35);word-break:break-word";
  var msg = document.createElement("span");
  msg.textContent = "レビュー注釈レイヤーを起動できません。このページの要素と名前が衝突しています: " +
    names.join(", ") + "。衝突している要素のid/classを変更してから、ページを開き直してください。";
  var closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "×";
  closeBtn.title = "閉じる";
  closeBtn.style.cssText = "position:absolute;top:6px;right:10px;width:24px;height:24px;" +
    "background:transparent;border:1px solid var(--rv-on-inverse,#ffffff);border-radius:4px;color:var(--rv-on-inverse,#ffffff);" +
    "font-size:15px;line-height:1;cursor:pointer;padding:0";
  bar.appendChild(msg);
  bar.appendChild(closeBtn);
  // 元のpadding-topを退避する。style.paddingTopはインライン指定だけを見るので、
  // 空文字なら「インライン指定なし」＝閉じたときに空文字へ戻せばCSS側の値がそのまま復活する。
  var prevPaddingTop = document.body.style.paddingTop;
  var baseTop = parseFloat(getComputedStyle(document.body).paddingTop) || 0;
  document.body.appendChild(bar);
  // 折り返しで2行になる幅では高さが変わるため、決め打ちせず挿入後に実測する。
  document.body.style.paddingTop = (baseTop + bar.offsetHeight) + "px";
  closeBtn.onclick = function(){
    if(bar.parentNode) bar.parentNode.removeChild(bar);
    document.body.style.paddingTop = prevPaddingTop;
  };
}
function buildDOM(){
  // rvorphan: ROOTの先頭子として挿入
  var orphanBox = document.createElement("div");
  orphanBox.id = "rvorphan";
  ROOT.insertBefore(orphanBox, ROOT.firstChild);

  // rvbar
  var bar = document.createElement("div"); bar.id = "rvbar";
  var countSpan = document.createElement("span"); countSpan.id = "rvcount"; countSpan.textContent = "コメント 0件";
  var doneBtn = document.createElement("button"); doneBtn.id = "rvdone"; doneBtn.className = "ghost";
  doneBtn.textContent = "済み"; doneBtn.style.display = "none";
  var copyBtn = document.createElement("button"); copyBtn.id = "rvcopy"; copyBtn.textContent = "コピー";
  var exportBtn = document.createElement("button"); exportBtn.id = "rvexport"; exportBtn.textContent = "zip";
  exportBtn.title = "元HTML・review.md・添付画像をまとめてzipで保存する（別のPCや別の人へ渡すとき）";
  var pickBtn = document.createElement("button"); pickBtn.id = "rvpick"; pickBtn.className = "ghost"; pickBtn.textContent = "枠";
  pickBtn.title = "次の1クリックで枠（表・カード・図など）を選ぶ。Option+クリックでも同じ";
  var clearBtn = document.createElement("button"); clearBtn.id = "rvclear"; clearBtn.className = "ghost"; clearBtn.textContent = "消去";
  bar.appendChild(countSpan); bar.appendChild(doneBtn); bar.appendChild(pickBtn);
  bar.appendChild(copyBtn); bar.appendChild(exportBtn);
  // 画像の保存先。使えないブラウザでも出す＝押したときに理由を言う。
  // 隠すと「ボタンが無い」が「未対応」なのか「古いファイルが読まれている」なのか
  // 見分けられなくなる（2026-08-21 実地で詰まった）
  var dirBtn = document.createElement("button"); dirBtn.id = "rvdir"; dirBtn.className = "ghost";
  dirBtn.textContent = "保存先";
  bar.appendChild(dirBtn);
  bar.appendChild(clearBtn);
  bar.title = "レビュー注釈レイヤー v" + RV_VERSION;
  document.body.appendChild(bar);

  // rvpop
  var popEl = document.createElement("div"); popEl.id = "rvpop";
  var q = document.createElement("div"); q.id = "rvquote"; q.className = "q";
  var thread = document.createElement("div"); thread.id = "rvthread";
  var imgs = document.createElement("div"); imgs.id = "rvimgs"; imgs.className = "rvimgs";
  var ta = document.createElement("textarea"); ta.id = "rvnote"; ta.placeholder = "ここ、こう直す";
  var row = document.createElement("div"); row.className = "row";
  var delBtn = document.createElement("button"); delBtn.id = "rvdel"; delBtn.className = "ghost"; delBtn.textContent = "削除";
  var cancelBtn = document.createElement("button"); cancelBtn.id = "rvcancel"; cancelBtn.className = "ghost"; cancelBtn.textContent = "閉じる";
  var saveBtn = document.createElement("button"); saveBtn.id = "rvsave"; saveBtn.textContent = "保存";
  row.appendChild(delBtn); row.appendChild(cancelBtn); row.appendChild(saveBtn);
  var hint = document.createElement("div"); hint.className = "rvhint";
  hint.textContent = "画像はここへペースト / ドロップ。そのままCmd+Cで本文をコピーできる";
  popEl.appendChild(q); popEl.appendChild(thread); popEl.appendChild(imgs); popEl.appendChild(ta);
  popEl.appendChild(hint); popEl.appendChild(row);
  document.body.appendChild(popEl);

  // rvdonepanel（済み一覧）
  var donePanel = document.createElement("div"); donePanel.id = "rvdonepanel";
  var doneList = document.createElement("div"); doneList.id = "rvdonelist";
  donePanel.appendChild(doneList);
  document.body.appendChild(donePanel);

  // rvmarks（枠コメントの枠線とバッジ。本文のDOMには触らず上に重ねる）
  var marks = document.createElement("div"); marks.id = "rvmarks";
  document.body.appendChild(marks);

  // rvsel（コメントを書いている間、対象にした文字列を見えるようにしておく仮マーク）
  var selLayer = document.createElement("div"); selLayer.id = "rvsel";
  document.body.appendChild(selLayer);

  // rvcrop（写真の切り取りのように矩形を引くときの枠。外側は影で暗くする）
  var crop = document.createElement("div"); crop.id = "rvcrop";
  crop.appendChild(document.createElement("span"));
  document.body.appendChild(crop);

  // rvhover（枠を選んでいる間の候補表示）
  var hov = document.createElement("div"); hov.id = "rvhover";
  hov.appendChild(document.createElement("span"));
  document.body.appendChild(hov);

  // rvtoast
  var toastEl = document.createElement("div"); toastEl.id = "rvtoast";
  document.body.appendChild(toastEl);

  // rvguide（初回だけ出る手順の案内。左下＝バーと済みパネルの反対側）
  var guide = document.createElement("div"); guide.id = "rvguide";
  var gstep = document.createElement("div"); gstep.id = "rvguidestep";
  var gtxt = document.createElement("p"); gtxt.id = "rvguidetxt";
  var grow = document.createElement("div"); grow.className = "row";
  var gskip = document.createElement("button"); gskip.id = "rvguideskip"; gskip.className = "ghost";
  gskip.textContent = "もう出さない";
  var gnext = document.createElement("button"); gnext.id = "rvguidenext"; gnext.textContent = "次へ";
  grow.appendChild(gskip); grow.appendChild(gnext);
  guide.appendChild(gstep); guide.appendChild(gtxt); guide.appendChild(grow);
  document.body.appendChild(guide);
}

// ---------- 初回ガイド ----------
// 出すのは「このブラウザで初めてレビュー層を開いた人」だけ。読むのでなく実際に手を動かして
// もらうため、各ステップは対応する操作が実際に起きたときに自動で進む（「次へ」は逃げ道）。
// 手順を進めたかどうかの記録はページ別ではなくオリジン単位＝別のページを開き直しても
// 同じ案内を最初から見せない。
var GUIDE_STEPS = [
  "本文をドラッグして選ぶと、その場にコメント欄が開く。気になった一文を選んでみて",
  "気づいたことを書いて〈保存〉。選んだところに印と番号が付く",
  "コメント欄が読みたい場所に重なったら、上の引用文を掴んで動かせる。書きかけは消えない",
  "表・カード・図はドラッグでは選べない。バーの〈枠〉を押してからクリックすると丸ごと選べる",
  "文字にも要素にも当てはまらない場所は、Optionを押しながらドラッグ。写真の切り取りのように四角く囲める",
  "書き終えたらバーの〈コピー〉。AIにそのまま貼ると、直したうえで対応済みの印まで入れて返してくる"
];
function guideSeen(){
  try{ return localStorage.getItem(GUIDE_KEY) === "done"; }catch(e){ return true; }
}
function guideFinish(msg){
  guideStep = 0;
  var g = document.getElementById("rvguide");
  if(g) g.style.display = "none";
  try{ localStorage.setItem(GUIDE_KEY, "done"); }catch(e){}
  if(msg) toast(msg);
}
function guideRender(){
  var g = document.getElementById("rvguide");
  if(!g) return;
  if(!guideStep){ g.style.display = "none"; return; }
  document.getElementById("rvguidestep").textContent = "使い方 " + guideStep + " / " + GUIDE_STEPS.length;
  document.getElementById("rvguidetxt").textContent = GUIDE_STEPS[guideStep - 1];
  document.getElementById("rvguidenext").textContent = guideStep === GUIDE_STEPS.length ? "終わり" : "次へ";
  g.style.display = "block";
}
// 引数のstepと今のstepが一致したときだけ進む。操作の順番が前後しても飛ばさない。
function guideAdvance(step){
  if(guideStep !== step) return;
  if(guideStep >= GUIDE_STEPS.length){ guideFinish("使い方はここまで。次からは出ない。この層を止めるならURL末尾に #rv-off、もう一度見るなら #rv"); return; }
  guideStep++; guideRender();
}
function guideStart(){
  guideStep = 1; guideRender();
}

function toast(msg){
  var t = document.getElementById("rvtoast");
  t.textContent = msg; t.classList.add("on");
  setTimeout(function(){ t.classList.remove("on"); }, 1600);
}
function nowISO(){
  var d = new Date(), p = function(n){ return String(n).padStart(2, "0"); };
  return d.getFullYear() + "-" + p(d.getMonth()+1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}
// 旧キーごとに「どのパスが取り込んだか」を1回だけ決める。
// 未登録なら今のパスが名乗り、登録済みなら一致するパスだけが読める。
function legacyClaimedMap(){
  try{ return JSON.parse(localStorage.getItem(LEGACY_CLAIM_KEY) || "{}") || {}; }
  catch(e){ return {}; }
}
function legacyClaimableBy(doc){
  var m = legacyClaimedMap();
  return !m[LEGACY_KEY] || m[LEGACY_KEY] === doc;
}
function claimLegacy(doc){
  try{
    var m = legacyClaimedMap();
    if(m[LEGACY_KEY] === doc) return;
    m[LEGACY_KEY] = doc;
    localStorage.setItem(LEGACY_CLAIM_KEY, JSON.stringify(m));
  }catch(e){}
}

function migrateLegacyStore(){
  try{
    localStorage.setItem(KEY, JSON.stringify(store));
  }catch(e){
    // 旧キーと新キーが一時的に併存する分だけ容量を使うため、既存save()と同じ縮退を試す。
    var compact = JSON.parse(JSON.stringify(store));
    compact.comments.forEach(function(c){
      if(c.images) c.images.forEach(function(im){ delete im.thumb; });
    });
    try{
      localStorage.setItem(KEY, JSON.stringify(compact));
      store = compact;
      toast("容量のためサムネイルを除いて旧キーから移行しました");
    }catch(e2){
      console.warn("[rv] 旧キーの保存済みコメントを新キーへ移行できません。旧キーは残します。", e2);
      return;
    }
  }
  // 旧キー自体は消さず互換用に残すが、このパスが取り込んだことを記録して
  // 同名の別パスが同じものを読まないようにする。
  claimLegacy(DOC);
  console.info("[rv] 保存済みコメントをページパス別のキーへ移行しました" +
               "（旧キーは互換用に保持。取り込み元はこのパスに固定）。");
}

// 保存データは同一オリジンの別スクリプト・手による編集・将来版との不整合で壊れうる。
// 壊れた1件をそのまま DOM 検索や文字列処理へ渡すと例外になり、
// 残りの正常なコメントまで表示・操作できなくなるので、ここで隔離する。
function sanitizeComments(list){
  var ok = [];
  list.forEach(function(c){
    if(!c || typeof c !== "object" || typeof c.id !== "string" || !c.id ||
       (c.tag != null && typeof c.tag !== "string")){
      quarantined.push(c);
      return;
    }
    if(typeof c.quote !== "string") c.quote = "";
    if(typeof c.note !== "string") c.note = "";
    if(!Array.isArray(c.replies)) c.replies = [];
    if(!Array.isArray(c.images)) c.images = [];
    if(c.rect && typeof c.rect !== "object") delete c.rect;
    if(!c.status) c.status = "open";
    ok.push(c);
  });
  return ok;
}

function load(){
  try{
    var raw = localStorage.getItem(KEY);
    var fromLegacy = false;
    if(!raw && LEGACY_KEY !== KEY && legacyClaimableBy(DOC)){
      raw = localStorage.getItem(LEGACY_KEY);
      fromLegacy = !!raw;
    }
    if(raw){
      var o = JSON.parse(raw);
      if(o && (o.docId === DOC || (fromLegacy && o.docId === LEGACY_DOC)) && Array.isArray(o.comments)){
        store = o;
        store.docId = DOC;
        if(!Array.isArray(store.appliedRevs)) store.appliedRevs = [];
        store.comments = sanitizeComments(store.comments);
        if(fromLegacy) migrateLegacyStore();
      }else{
        // ここに来るのは「保存済みの何かはあるが、この文書のものとして読めなかった」場合。
        // 黙って空の store で始めると、次の save() が既存のコメントを消してしまう。
        // 保存を止めて、消さずに残す。
        noOverwrite = true; memoryOnly = true;
        console.warn("[rv] このパスに、読み取れない保存データがあります。" +
                     "上書きしないよう保存を止めました。今開いている間だけ保持します。", raw.slice(0, 200));
      }
    }
  }catch(e){
    memoryOnly = true;
    console.warn("[rv] localStorage 不可。今開いている間だけ保持します。", e);
  }
  store.comments.forEach(function(c){
    seenIds[c.id] = true;
    (c.replies || []).forEach(markReplySeen);
  });
}
// 同じページを2つのタブで開くと、どちらも「開いた時点の store」を丸ごと持つ。
// そのまま setItem すると、もう一方のタブが足したコメントが警告なく消える。
// 書く直前にディスクの最新を読み、このタブで触っていない既知IDはディスク側へ更新する。
// このタブで触ったIDは手元を残し、追記は削除済みを除いて両方を失わないよう併合する。
// 「見たことがあるのに今の store に無い」＝このタブで削除した分なので、復活させない。
function touchComment(id){ if(id) touchedIds[id] = true; }
function replyKey(r){
  // 保存データは壊れていることがある（配列の中身がnullや文字列）。ここで落ちると
  // load()ごと止まり、正常なコメントまで表示されなくなる
  if(!r || typeof r !== "object") return null;
  var hasId = r.id != null && r.id !== "";
  return hasId ? "id:" + r.id : "body:" + (r.created || "") + "\n" + (r.text || "");
}
function markReplySeen(r){
  var k = replyKey(r);
  if(k) seenReplyKeys[k] = true;
}
function mergeReplies(local, disk){
  var merged = [], keys = {};
  function add(r, fromDisk){
    if(!r || typeof r !== "object") return;
    var key = replyKey(r);
    if(keys[key]) return;
    if(fromDisk && seenReplyKeys[key]) return;
    keys[key] = true; merged.push(r); seenReplyKeys[key] = true;   // 併合で残った分も「見た」
  }
  (local || []).forEach(function(r){ add(r, false); });
  (disk || []).forEach(function(r){ add(r, true); });
  merged.sort(function(a, b){
    var ac = a.created || "", bc = b.created || "";
    return ac < bc ? -1 : ac > bc ? 1 : 0;
  });
  return merged;
}
function mergeWithStored(){
  var raw, o;
  try{ raw = localStorage.getItem(KEY); }catch(e){ return; }
  if(!raw) return;
  try{ o = JSON.parse(raw); }catch(e){ return; }
  if(!o || o.docId !== DOC || !Array.isArray(o.comments)) return;
  var adopted = 0;
  sanitizeComments(o.comments).forEach(function(c){
    if(!seenIds[c.id]){
      (c.replies || []).forEach(markReplySeen);
      store.comments.push(c); seenIds[c.id] = true; adopted++;
      return;
    }
    var at = -1;
    for(var i=0;i<store.comments.length;i++){
      if(store.comments[i].id === c.id){ at = i; break; }
    }
    if(at === -1) return;
    if(!touchedIds[c.id]){
      (c.replies || []).forEach(markReplySeen);
      store.comments[at] = c;
      return;
    }
    store.comments[at].replies = mergeReplies(store.comments[at].replies, c.replies);
  });
  if(Array.isArray(o.appliedRevs)){
    o.appliedRevs.forEach(function(r){
      if(store.appliedRevs.indexOf(r) === -1) store.appliedRevs.push(r);
    });
  }
  if(adopted) console.info("[rv] 別のタブで追加された " + adopted + "件を取り込みました。");
}

function save(){
  store.updated = nowISO();
  // 読めない保存データを上書きしないための固定。容量不足(memoryOnly)と違い、
  // このセッション中は解除しない（解除すると守るはずのデータを消す）
  if(noOverwrite) return;
  mergeWithStored();
  try{
    localStorage.setItem(KEY, JSON.stringify(store));
    // 容量が空いた等で書けるようになったら、止めていた保存を再開する
    if(memoryOnly){ memoryOnly = false; toast("保存を再開しました"); }
    return;
  }catch(e){}
  // 容量に当たったらサムネイルだけ捨てて本文を守る（画像の実体はダウンロード済みなので残る）
  try{
    store.comments.forEach(function(c){
      if(c.images) c.images.forEach(function(im){ delete im.thumb; });
    });
    localStorage.setItem(KEY, JSON.stringify(store));
    if(memoryOnly) memoryOnly = false;
    toast("容量のためサムネイルは消しました（画像ファイルは残ります）");
  }catch(e2){
    // 次に save() が呼ばれたらまた試す（容量を空ければ復帰できる）
    if(!memoryOnly) toast("保存できません。容量を空けるまで、今開いている間だけの保持です");
    memoryOnly = true;
  }
}

function lastHeadingIn(el){
  if(/^H[2-4]$/.test(el.tagName)) return el;
  var hs = el.querySelectorAll ? el.querySelectorAll("h2,h3,h4") : [];
  return hs.length ? hs[hs.length-1] : null;
}
// 選択位置より前にある最寄りの見出し（H2〜H4。H1は文書タイトルなので除外）を拾う。
// 前方兄弟の中も降りて探すので、section > header > h2 のようなラッパー越しにも届く。
function headingOf(node){
  var el = node.nodeType === 3 ? node.parentElement : node;
  while(el && el !== ROOT){
    if(/^H[2-4]$/.test(el.tagName)) return el.textContent.trim();
    var p = el;
    while((p = p.previousElementSibling)){
      var h = lastHeadingIn(p);
      if(h) return h.textContent.trim();
    }
    el = el.parentElement;
  }
  return "導入";
}

// CC申告レビジョンの自動消し込み
function applyResolved(){
  var r = window.__rvResolved;
  if(!r || !r.rev || !Array.isArray(r.ids)) return;
  if(store.appliedRevs.indexOf(r.rev) !== -1) return; // 適用済みrevは無視
  var n = 0;
  store.comments.forEach(function(c){
    if(c.status === "open" && r.ids.indexOf(c.id) !== -1){
      touchComment(c.id);
      c.status = "done"; c.resolvedRev = r.rev; c.resolvedAt = nowISO(); n++;
    }
  });
  store.appliedRevs.push(r.rev);
  save();
  if(n > 0) toast("対応分 " + n + "件を済みにしました");
}

// Date.now() だけだと、同じミリ秒に2件作ったとき同じIDになる。衝突すると
// 編集・削除・済み判定が別のコメントを巻き込む（IDで引き当てているため）。
// タブごとに違う接尾辞と連番を足して、同じブラウザの別タブとも衝突しないようにする。
var idTab = Math.random().toString(36).slice(2, 6);
var idSeq = 0;
function newCommentId(){
  return "c" + Date.now() + idTab + (++idSeq).toString(36);
}

function openComments(){ return store.comments.filter(function(c){ return c.status !== "done"; }); }
function doneComments(){ return store.comments.filter(function(c){ return c.status === "done"; }); }

var SKIP = {SCRIPT:1, STYLE:1, TEXTAREA:1, BUTTON:1};
function textNodes(){
  var out = [], w = document.createTreeWalker(ROOT, NodeFilter.SHOW_TEXT, {
    acceptNode: function(n){
      var p = n.parentElement;
      while(p && p !== ROOT){
        if(SKIP[p.tagName] || (p.classList && p.classList.contains("rvnum")) ||
           p.id === "rvbar" || p.id === "rvpop" || p.id === "rvtoast" ||
           p.id === "rvdonepanel" || p.id === "rvorphan" ||
           p.id === "rvmarks" || p.id === "rvhover" || p.id === "rvcrop")
          return NodeFilter.FILTER_REJECT;
        p = p.parentElement;
      }
      return n.nodeValue.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  var n; while((n = w.nextNode())) out.push(n);
  return out;
}
function flat(){
  var ns = textNodes(), s = "", map = [];
  for(var i=0;i<ns.length;i++){ map.push({node:ns[i], at:s.length}); s += ns[i].nodeValue; }
  return {text:s, map:map};
}
function locate(f, pos){
  for(var i=f.map.length-1;i>=0;i--){
    if(f.map[i].at <= pos) return {node:f.map[i].node, offset:pos - f.map[i].at};
  }
  return null;
}
// レンジの終端専用。locate() は境界ちょうどの位置を「次のノードの先頭0文字目」に写すが、
// 引用が段落の末尾で終わるとその次のノードは別のブロックにある。そのままレンジの
// 終端にすると境界をまたぎ、render() の extractContents が <p> ごと切り出して
// <mark> の中へ入れてしまう（段落が「最初の1文字」と「残り全部」に割れる）。
// 終端は「ひとつ前のノードの末尾」へ寄せる。
function locateEnd(f, pos){
  for(var i=f.map.length-1;i>=0;i--){
    if(f.map[i].at < pos){
      var len = f.map[i].node.nodeValue.length;
      return {node:f.map[i].node, offset:Math.min(pos - f.map[i].at, len)};
    }
  }
  return locate(f, pos);
}
// flat() と同じ基準で、DOM Rangeの境界を本文先頭からの絶対位置へ変換する。
function flatOffset(f, container, offset){
  if(container.nodeType === 3){
    for(var i=0;i<f.map.length;i++){
      if(f.map[i].node === container) return f.map[i].at + offset;
    }
  }
  var total = 0;
  for(var j=0;j<f.map.length;j++){
    var n = f.map[j].node;
    if(container.contains && container.contains(n)){
      var child = n;
      while(child.parentNode && child.parentNode !== container) child = child.parentNode;
      if(child.parentNode === container){
        var k = 0;
        while(k < offset && container.childNodes[k]){
          if(container.childNodes[k] === child){ total += n.nodeValue.length; break; }
          k++;
        }
      }
    } else if(n.compareDocumentPosition(container) & Node.DOCUMENT_POSITION_FOLLOWING){
      total += n.nodeValue.length;
    }
  }
  return total;
}
function nearestMatch(text, needle, target, inner){
  if(!needle) return -1;
  var at = 0, best = -1, distance = Infinity;
  while((at = text.indexOf(needle, at)) !== -1){
    var d = typeof target === "number" ? Math.abs(at + inner - target) : at;
    if(d < distance){ best = at; distance = d; }
    at += 1;
  }
  return best;
}
function normQuote(q){ return (q || "").replace(/\s+/g, " ").trim(); }
// before+quote+after で厳密に、外れたら quote 単独で再照合。
// 複数一致時は、作成時の絶対位置 pos に最も近い候補を選ぶ（旧データは従来通り先頭）。
function findRange(c){
  var f = flat(), i = -1, off = 0;
  if(c.before || c.after){
    off = (c.before || "").length;
    i = nearestMatch(f.text, (c.before || "") + c.quote + (c.after || ""), c.pos, off);
  }
  // 1文字の引用は単独だと同じ字のどこにでも当たる。文脈が外れたときは別の場所へ
  // 静かに付け替えず、未照合（#rvorphan）として出す。
  if(i < 0 && normQuote(c.quote).length > 1){ i = nearestMatch(f.text, c.quote, c.pos, 0); off = 0; }
  if(i < 0) return null;
  var a = locate(f, i+off), b = locateEnd(f, i+off+c.quote.length);
  if(!a || !b) return null;
  var r = document.createRange();
  try{ r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset); }catch(e){ return null; }
  return r;
}
function isLayoutContainer(el){
  var d = getComputedStyle(el).display;
  return d === "flex" || d === "inline-flex" || d === "grid" || d === "inline-grid";
}
function directChildOf(container, node){
  var el = node.nodeType === 3 ? node.parentElement : node;
  while(el && el.parentElement && el.parentElement !== container) el = el.parentElement;
  return el && el.parentElement === container ? el : null;
}
function commonElement(a, b){
  var x = a.nodeType === 3 ? a.parentElement : a;
  var y = b.nodeType === 3 ? b.parentElement : b;
  while(x){
    if(x.contains(y)) return x;
    x = x.parentElement;
  }
  return ROOT;
}
// flex/gridの別アイテムへ選択が延びたときは、アイテム単体で切らずレイアウト境界まで上げる。
function layoutBoundary(a, b){
  var ae = a.nodeType === 3 ? a.parentElement : a;
  var be = b.nodeType === 3 ? b.parentElement : b;
  var common = commonElement(ae, be), el = ae;
  while(el){
    if(isLayoutContainer(el)){
      if(el.contains(be)){
        if(directChildOf(el, ae) !== directChildOf(el, be)) return el;
      } else { return common; }
    }
    if(el === ROOT) break;
    el = el.parentElement;
  }
  el = be;
  while(el){
    if(isLayoutContainer(el) && !el.contains(ae)) return common;
    if(el === ROOT) break;
    el = el.parentElement;
  }
  return null;
}
function blockOf(node, endNode){
  var el = node.nodeType === 3 ? node.parentElement : node;
  while(el && el !== ROOT && getComputedStyle(el).display === "inline") el = el.parentElement;
  if(endNode && el && !el.contains(endNode)){
    var boundary = layoutBoundary(node, endNode);
    if(boundary) return boundary;
  }
  return el || ROOT;
}
function clearMarks(){
  var ms = ROOT.querySelectorAll("mark.rv");
  for(var i=0;i<ms.length;i++){
    var m = ms[i], p = m.parentNode;
    var num = m.querySelector(".rvnum"); if(num) num.remove();
    while(m.firstChild) p.insertBefore(m.firstChild, m);
    p.removeChild(m); p.normalize();
  }
}

function render(){
  clearMarks();
  var open = openComments(), done = doneComments();
  var orphan = [];
  blockItems = [];
  for(var i=0;i<open.length;i++){
    var c = open[i];
    if(c.kind === "crop"){
      var cb = cropBox(c);
      if(!cb){ orphan.push(c); continue; }
      blockItems.push({c:c, box:cb, n:i+1});
      continue;
    }
    if(c.kind === "block"){
      var bel = findBlock(c);
      if(!bel){ orphan.push(c); continue; }
      blockItems.push({c:c, el:bel, n:i+1});
      continue;
    }
    var r = findRange(c);
    if(!r){ orphan.push(c); continue; }
    // <mark> はインライン要素なので、レンジがブロックの境界をまたいだまま
    // extractContents すると <mark> が <p> 等を内包し、元の段落が割れる。
    // 復元したレンジは保存時と同じとは限らないので、包む直前にもう一度確かめる。
    var sb = blockOf(r.startContainer);
    if(!sb.contains(r.endContainer)){
      try{ r.setEnd(sb, sb.childNodes.length); }catch(e){ orphan.push(c); continue; }
      if(r.collapsed){ orphan.push(c); continue; }
    }
    var m = document.createElement("mark");
    m.className = "rv"; m.dataset.id = c.id;
    try{ m.appendChild(r.extractContents()); r.insertNode(m); }
    catch(e){ orphan.push(c); continue; }
    var s = document.createElement("span");
    s.className = "rvnum"; s.textContent = String(i+1);
    m.appendChild(s);
  }
  var countText = "コメント " + open.length + "件";
  if(done.length) countText += "（済み " + done.length + "件）";
  if(orphan.length) countText += " / 未照合" + orphan.length;
  if(memoryOnly) countText += "（保存なし）";
  document.getElementById("rvcount").textContent = countText;

  var box = document.getElementById("rvorphan");
  if(box){
    if(orphan.length){
      box.style.display = "block";
      // 引用文には元のページの文字列が、指摘文には入力した文字列がそのまま入る。
      // innerHTML へ連結するとタグに見える文字列がHTMLとして解釈されるので、
      // ここだけは必ず DOM を組んで入れる。
      box.textContent = "";
      var ohead = document.createElement("strong");
      ohead.textContent = "本文が変わって位置を見失ったコメント " + orphan.length + "件";
      box.appendChild(ohead);
      box.appendChild(document.createTextNode("（コピーには含まれます）"));
      orphan.forEach(function(c){
        box.appendChild(document.createElement("br"));
        box.appendChild(document.createTextNode("「" + c.quote.slice(0,24) + "…」 → " + c.note));
      });
    } else { box.style.display = "none"; }
  }

  drawBlockBoxes();
  refreshLayoutObserver();

  var doneBtn = document.getElementById("rvdone");
  if(doneBtn) doneBtn.style.display = done.length ? "" : "none";
  if(!done.length){
    var dp = document.getElementById("rvdonepanel");
    if(dp) dp.style.display = "none";
  }
  renderDonePanel();
}

function renderDonePanel(){
  var list = document.getElementById("rvdonelist");
  if(!list) return;
  list.innerHTML = "";
  var done = doneComments();
  if(!done.length){
    var empty = document.createElement("div");
    empty.className = "rvdoneempty";
    empty.textContent = "済みコメントはありません";
    list.appendChild(empty);
    return;
  }
  done.forEach(function(c){
    var row = document.createElement("div");
    row.className = "rvdonerow";
    var txt = document.createElement("span");
    txt.className = "rvdonetxt rvdoneopen";
    var reps = (c.replies || []).length;
    txt.textContent = "[" + c.heading + "]「" + c.quote.slice(0,24) + "…」→" + c.note.slice(0,40) +
                      (reps ? "（追記" + reps + "）" : "");
    txt.title = "開いて全文と追記を読む";
    // 読むだけなら状態を変えさせない。「戻す」を押さないと中身が読めないのを避ける
    txt.onclick = function(ev){
      ev.stopPropagation();
      if(pop.style.display === "block" && !tryClose()) return;
      editing = c.id; pending = null; editingBody = false;
      var r = row.getBoundingClientRect();
      openPop(r.left + Math.min(r.width / 2, 140), r.top, c.quote, c.note, c.images);
    };
    var btn = document.createElement("button");
    btn.textContent = "戻す";
    btn.onclick = function(){
      touchComment(c.id);
      c.status = "open"; save(); render(); toast("戻しました");
    };
    row.appendChild(txt); row.appendChild(btn);
    list.appendChild(row);
  });
}

// コピー文字列を組み立てるだけの関数（clipboard操作はしない。テスト用にwindow.__rvへ露出）
function copyText(){
  var open = openComments();
  if(!open.length) return null;
  var out = "## レビューコメント — " + document.title + "（" + nowISO() + "）\n\n";
  open.forEach(function(c, i){
    out += (i+1) + ". [" + c.heading + "] (id:" + c.id + ")\n";
    out += "   > " + c.quote.replace(/\n+/g, " ") + "\n";
    out += "   " + c.note.replace(/\n/g, "\n   ") + "\n";
    (c.replies || []).forEach(function(r){
      out += "   └ 追記: " + r.text.replace(/\n/g, "\n     ") + "\n";
    });
    if(c.images && c.images.length){
      out += "   [画像] " + c.images.map(function(im){ return im.name; }).join(" , ") + "\n";
    }
    out += "\n";
  });
  out += "---\n";
  out += "AIへ: 対応が済んだものは、改訂版HTMLの </body> 直前に\n";
  out += "<script>window.__rvResolved={rev:\"r{YYYYMMDDHHMM}\",ids:[\"対応したid\",...]}</script>\n";
  out += "を埋め込むこと（revは毎回ユニークに。注釈レイヤーが次回表示時に自動で済みへ落とす）";
  if(open.some(function(c){ return c.kind === "block"; })){
    out += "\n〔枠〕が付いた行は、文字列でなくそのブロック（表・カード・図など）全体への指摘。" +
           "タグ名とクラス、続く「…」の先頭テキストで該当箇所を特定すること";
  }
  if(open.some(function(c){ return c.kind === "crop"; })){
    out += "\n〔切り取り〕が付いた行は、画面上で矩形に囲った範囲への指摘。" +
           "px寸法・囲みを含む要素・「…」に写っていたテキストが手がかり";
  }
  if(open.some(function(c){ return c.images && c.images.length; })){
    out += "\n添付画像は [画像] のファイル名でこのPCに保存されている。" +
           (imageDirName ? "保存先フォルダは「" + imageDirName + "」。"
                         : "ブラウザのダウンロードフォルダにある。") +
           "見つからなければ find ~ -name 'rv-" + docSlug() + "-*' で探して読むこと";
  }
  return out;
}

// 書き出したいのはROOT配下だけでなく文書全体（<head>のscript行等も含む）なので、
// documentElementを丸ごとクローンしてから注釈UIだけ取り除く。ライブDOMには触れない。
function stripRvChrome(docEl){
  var chrome = docEl.querySelectorAll(
    "#rvbar,#rvpop,#rvtoast,#rvdonepanel,#rvorphan,#rvmarks,#rvsel,#rvhover,#rvcrop,#rvguide");
  for(var i=0;i<chrome.length;i++){
    if(chrome[i].parentNode) chrome[i].parentNode.removeChild(chrome[i]);
  }
  var marks = docEl.querySelectorAll("mark.rv");
  for(var j=0;j<marks.length;j++){
    var m = marks[j], p = m.parentNode;
    if(!p) continue;
    var num = m.querySelector(".rvnum"); if(num) num.remove();
    while(m.firstChild) p.insertBefore(m.firstChild, m);
    p.removeChild(m); p.normalize();
  }
  var body = docEl.querySelector("body");
  if(body) body.classList.remove("rvpicking");
}
// 表示中のDOMから復元する経路。<script src=".../rv-layer.js">と埋め込み済みの
// window.__rvResolved は注釈UIではないので触らず残る。
function domSourceHtml(){
  var clone = document.documentElement.cloneNode(true);
  stripRvChrome(clone);
  return "<!doctype html>\n" + clone.outerHTML;
}
// 元ファイルをそのまま取り直せるならそれが一番正確（改変ゼロ）。file://等でfetchが
// 効かない・失敗する場合だけDOM復元へ落ちる。
// 注釈を外した表示中のページの、見えている文字だけを取り出す。
// 再取得したHTMLが同じページかを比べるために使う。
function visibleTextOf(docLike){
  var body = docLike.querySelector ? docLike.querySelector("body") : null;
  if(!body) return "";
  var t = body.textContent || "";
  return t.replace(/\s+/g, " ").trim();
}
// 再取得したHTMLが、読み手が実際に見ていた内容と同じか確かめる。
// サーバーが時刻や認証で中身を変える場合、SPAが表示後にDOMを組む場合、
// 再取得版は注釈した画面と別物になる。そのままAIへ渡すと、見てもいない内容を直させる。
function sourceMatchesView(fetchedText, domText){
  try{
    var parse = new DOMParser();
    var a = visibleTextOf(parse.parseFromString(fetchedText, "text/html"));
    // 表示中の側は domSourceHtml()（注釈UIを外した版）を使う。
    // 生の document を使うと、レイヤー自身のバー・ポップアップ・番号バッジの文字が
    // 混ざって常に食い違い、一致しているページまで不一致と判定してしまう。
    var b = visibleTextOf(parse.parseFromString(domText, "text/html"));
    if(!a || !b) return false;
    var diff = Math.abs(a.length - b.length) / Math.max(a.length, b.length);
    return diff <= 0.1;   // 1割を超えて違えば別物とみなす
  }catch(e){ return false; }
}
function getSourceHtml(){
  if(typeof fetch === "function" && /^https?:$/.test(location.protocol) &&
     typeof DOMParser === "function"){
    return fetch(location.href, {cache:"no-store"}).then(function(res){
      if(!res.ok) throw new Error("HTTP " + res.status);
      return res.text();
    }).then(function(text){
      var dom = domSourceHtml();
      if(sourceMatchesView(text, dom)) return {text:text, method:"fetch"};
      console.warn("[rv] 再取得したHTMLが表示中の内容と食い違うため、表示中のDOMから書き出します。");
      return {text:dom, method:"dom-mismatch"};
    }).catch(function(){
      return {text:domSourceHtml(), method:"dom"};
    });
  }
  return Promise.resolve({text:domSourceHtml(), method:"dom"});
}
function sourceFileName(){
  var name = LEGACY_DOC;
  return /\.html?$/i.test(name) ? name : (docSlug() + ".html");
}
// zip内の review.md。copyText() は既存契約を保つため変更せず、こちらは別に組み立てる。
// AIが指示の末尾を読み落とすことがあるため、対応手順とidの正本宣言は冒頭に置く。
function reviewText(imageResult, open, sourceInfo){
  open = open || openComments();
  if(!open.length) return null;
  imageResult = imageResult || {fallback:[], omitted:[], names:{}};
  sourceInfo = sourceInfo || {filename:sourceFileName(), method:"dom"};
  var out = "# HTMLレビュー修正指示\n\n";
  out += "- 編集対象: source/" + sourceInfo.filename + "\n";
  out += "- 文書タイトル: " + document.title + "\n";
  out += "- 書き出し日時: " + nowISO() + "\n";
  out += "- 未済みコメント: " + open.length + "件\n";
  out += "- 元HTMLの取得経路: " + (
    sourceInfo.method === "fetch" ?
      "fetch（サーバーから再取得。表示中の内容と一致することを確認済み）" :
    sourceInfo.method === "dom-mismatch" ?
      "DOMシリアライズ（サーバーから再取得したHTMLが表示中の内容と食い違ったため、" +
      "読み手が実際に見ていた表示中のページを採用した。サーバー側は別の内容を返している）" :
      "DOMシリアライズ（表示中のページから復元。属性順序等に軽微な整形差が出ることがある）") + "\n\n";
  out += "## AIへの対応手順\n\n";
  out += "対応が済んだら、source/" + sourceInfo.filename + " の改訂版の </body> 直前に\n\n";
  out += "<script>window.__rvResolved={rev:\"r{YYYYMMDDHHMM}\",ids:[\"対応したid\",...]}</script>\n\n";
  out += "を埋め込むこと（revは毎回ユニークに。注釈レイヤーが次回表示時に自動で済みへ落とす）。\n\n";
  out += "**番号（下の「1.」「2.」…）は表示用の見出しで、正本は各コメントの id。" +
         "ids配列には番号でなくidを入れること。**\n";
  if(open.some(function(c){ return c.kind === "block"; })){
    out += "\n〔枠〕が付いたコメントは、文字列でなくそのブロック（表・カード・図など）全体への指摘。" +
           "タグ名とクラス、続く「…」の先頭テキストで該当箇所を特定すること\n";
  }
  if(open.some(function(c){ return c.kind === "crop"; })){
    out += "\n〔切り取り〕が付いたコメントは、画面上で矩形に囲った範囲への指摘。" +
           "px寸法・囲みを含む要素・「…」に写っていたテキストが手がかり\n";
  }
  if(open.some(function(c){ return c.images && c.images.length; })){
    out += "\n添付画像は各コメントの「添付」に images/ パスがあるものだけ同梱されている。" +
           "「zip未収録」は書き出せる画像データがないため、コメント本文だけで対応すること\n";
  }
  out += "\n## コメント\n";
  open.forEach(function(c, i){
    var kindLabel = c.kind === "block" ? "枠" : c.kind === "crop" ? "切り取り" : "テキスト";
    out += "\n### " + (i+1) + ". " + c.id + "\n\n";
    out += "- 種別: " + kindLabel + "\n";
    out += "- セクション: " + c.heading + "\n";
    out += "- 対象: 「" + c.quote.replace(/\n+/g, " ") + "」\n";
    out += "- 修正指示: " + c.note.replace(/\n+/g, " ") + "\n";
    if(c.replies && c.replies.length){
      out += "- 追記:\n";
      c.replies.forEach(function(r){ out += "  - " + r.text.replace(/\n+/g, " ") + "\n"; });
    }
    if(c.images && c.images.length){
      out += "- 添付:\n";
      c.images.forEach(function(im){
        if(imageResult.omitted.indexOf(im.name) !== -1){
          out += "  - " + im.name + "（zip未収録：原寸を取得できず、サムネイルもなし）\n";
          return;
        }
        var path = "images/" + (imageResult.names[im.name] || im.name);
        if(imageResult.fallback.indexOf(im.name) !== -1) path += "（サムネイルのみ・原寸なし）";
        out += "  - " + path + "\n";
      });
    }
  });
  return out;
}

function utf8Bytes(s){
  var out = [];
  for(var i=0;i<s.length;i++){
    var c = s.charCodeAt(i);
    if(c >= 0xd800 && c <= 0xdbff && i+1 < s.length){
      var lo = s.charCodeAt(i+1);
      if(lo >= 0xdc00 && lo <= 0xdfff){ c = 0x10000 + ((c-0xd800)<<10) + (lo-0xdc00); i++; }
      else c = 0xfffd;
    }
    else if(c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if(c < 0x80) out.push(c);
    else if(c < 0x800) out.push(0xc0 | (c>>6), 0x80 | (c&63));
    else if(c < 0x10000) out.push(0xe0 | (c>>12), 0x80 | ((c>>6)&63), 0x80 | (c&63));
    else out.push(0xf0 | (c>>18), 0x80 | ((c>>12)&63), 0x80 | ((c>>6)&63), 0x80 | (c&63));
  }
  return new Uint8Array(out);
}

var CRC_TABLE = (function(){
  var t = [];
  for(var n=0;n<256;n++){
    var c = n;
    for(var k=0;k<8;k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes){
  var c = 0xffffffff;
  for(var i=0;i<bytes.length;i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function put16(out, at, v){ out[at] = v & 255; out[at+1] = (v >>> 8) & 255; }
function put32(out, at, v){
  out[at] = v & 255; out[at+1] = (v >>> 8) & 255;
  out[at+2] = (v >>> 16) & 255; out[at+3] = (v >>> 24) & 255;
}
function dosStamp(d){
  var year = Math.max(1980, d.getFullYear());
  return {time:(d.getHours()<<11) | (d.getMinutes()<<5) | (d.getSeconds()>>1),
          date:((year-1980)<<9) | ((d.getMonth()+1)<<5) | d.getDate()};
}
// stored(method=0) の最小zip。各ファイルは既に Uint8Array にしてから渡す
function makeZip(files){
  var stamp = dosStamp(new Date()), localSize = 0, centralSize = 0;
  files.forEach(function(f){
    f.nameBytes = utf8Bytes(f.name); f.crc = crc32(f.data); f.offset = localSize;
    localSize += 30 + f.nameBytes.length + f.data.length;
    centralSize += 46 + f.nameBytes.length;
  });
  if(files.length > 65535 || localSize + centralSize + 22 > 0xffffffff)
    throw new Error("zipが大きすぎます（ZIP64には未対応）");
  var out = new Uint8Array(localSize + centralSize + 22), at = 0;
  files.forEach(function(f){
    put32(out, at, 0x04034b50); put16(out, at+4, 20); put16(out, at+6, 0x0800);
    put16(out, at+8, 0); put16(out, at+10, stamp.time); put16(out, at+12, stamp.date);
    put32(out, at+14, f.crc); put32(out, at+18, f.data.length); put32(out, at+22, f.data.length);
    put16(out, at+26, f.nameBytes.length); put16(out, at+28, 0); at += 30;
    out.set(f.nameBytes, at); at += f.nameBytes.length;
    out.set(f.data, at); at += f.data.length;
  });
  var centralAt = at;
  files.forEach(function(f){
    put32(out, at, 0x02014b50); put16(out, at+4, 20); put16(out, at+6, 20);
    put16(out, at+8, 0x0800); put16(out, at+10, 0);
    put16(out, at+12, stamp.time); put16(out, at+14, stamp.date);
    put32(out, at+16, f.crc); put32(out, at+20, f.data.length); put32(out, at+24, f.data.length);
    put16(out, at+28, f.nameBytes.length); put16(out, at+30, 0); put16(out, at+32, 0);
    put16(out, at+34, 0); put16(out, at+36, 0); put32(out, at+38, 0); put32(out, at+42, f.offset);
    at += 46; out.set(f.nameBytes, at); at += f.nameBytes.length;
  });
  put32(out, at, 0x06054b50); put16(out, at+4, 0); put16(out, at+6, 0);
  put16(out, at+8, files.length); put16(out, at+10, files.length);
  put32(out, at+12, centralSize); put32(out, at+16, centralAt); put16(out, at+20, 0);
  return out;
}
function zipFileName(){
  var d = new Date(), p = function(n){ return n < 10 ? "0" + n : String(n); };
  return "rv-" + docSlug() + "-" + d.getFullYear() + p(d.getMonth()+1) + p(d.getDate()) +
         "-" + p(d.getHours()) + p(d.getMinutes()) + ".zip";
}
function downloadBlob(blob, name){
  var url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
}
// 添付画像の原寸はIndexedDBにしか無いので、別PCや別の人へ渡す道はこのzipだけ。
// 「書き出し」ボタンと「コピー」の自動生成の両方から呼ぶので、名前は呼び側が決める
// （コピー側はzipが出来る前に文面へ名前を書くため、名前を先に確定させる必要がある）。
function makeReviewZip(open, name){
  return Promise.all([
    imageWriteTail.then(function(){ return collectExportImages(open); }),
    getSourceHtml()
  ]).then(function(both){
    var result = both[0], src = both[1];
    var sourceInfo = {filename:sourceFileName(), method:src.method};
    var files = [
      {name:"review.md", data:utf8Bytes(reviewText(result, open, sourceInfo))},
      {name:"source/" + sourceInfo.filename, data:utf8Bytes(src.text)}
    ].concat(result.files);
    downloadBlob(new Blob([makeZip(files)], {type:"application/zip"}), name);
    return result;
  });
}
function exportReview(){
  var open = openComments();
  if(!open.length){ toast("未済みコメントはありません"); return; }
  var btn = document.getElementById("rvexport");
  btn.disabled = true; toast("zipを作っています");
  var name = zipFileName();
  makeReviewZip(open, name).then(function(result){
    btn.disabled = false;
    var notes = [];
    if(result.fallback.length) notes.push("サムネイル代用 " + result.fallback.length + "件");
    if(result.omitted.length) notes.push("画像欠落 " + result.omitted.length + "件");
    toast("書き出しました" + (notes.length ? "（" + notes.join(" / ") + "）" : ""));
  }, function(e){
    btn.disabled = false; console.warn("[rv] zipを書き出せませんでした。", e);
    toast("zipを書き出せませんでした");
  });
}

window.__rv = {
  version: RV_VERSION,
  // このページが data-rv-default="on" を持っているか（出ない理由を切り分けるとき用）
  defaultOn: DEFAULT_ON,
  // 使い方ガイドをもう一度出す（デモや録画の撮り直し用）。
  guide: function(){ try{ localStorage.removeItem(GUIDE_KEY); }catch(e){} guideStart(); },
  get store(){ return store; },
  get memoryOnly(){ return memoryOnly; },
  copyText: copyText
};

// ---------- 画像添付 ----------
function warnImageDB(e){
  if(imageDBWarned) return;
  imageDBWarned = true;
  console.warn("[rv] IndexedDB 不可。原寸は従来通りダウンロードし、注釈にはサムネイルだけ残します。", e);
}
function openImageDB(){
  if(imageDBPromise) return imageDBPromise;
  imageDBPromise = new Promise(function(resolve){
    if(!window.indexedDB){ warnImageDB(); resolve(null); return; }
    var req;
    try{ req = window.indexedDB.open("rv-layer", 2); }
    catch(e){ warnImageDB(e); resolve(null); return; }
    var settled = false;
    var finish = function(db){
      if(settled){ if(db) db.close(); return; }
      settled = true; resolve(db);
    };
    req.onupgradeneeded = function(){
      if(!req.result.objectStoreNames.contains("images")) req.result.createObjectStore("images");
      // handles: 保存先フォルダのハンドル。file://はどのページでも同じoriginなので、
      // 一度選べば別のレビューページを開いても同じフォルダが使える
      if(!req.result.objectStoreNames.contains("handles")) req.result.createObjectStore("handles");
    };
    req.onsuccess = function(){ finish(req.result); };
    req.onerror = function(){ warnImageDB(req.error); finish(null); };
    req.onblocked = function(){ warnImageDB("open blocked"); finish(null); };
  });
  return imageDBPromise;
}
function queueImageOp(work){
  imageWriteTail = imageWriteTail.then(work, work).then(function(v){ return v; }, function(e){
    warnImageDB(e); return false;
  });
  return imageWriteTail;
}
function putImage(name, blob){
  if(!name || !blob) return Promise.resolve(false);
  return queueImageOp(function(){
    return openImageDB().then(function(db){
      if(!db) return false;
      return new Promise(function(resolve){
        var tx;
        try{ tx = db.transaction("images", "readwrite"); tx.objectStore("images").put(blob, name); }
        catch(e){ warnImageDB(e); resolve(false); return; }
        tx.oncomplete = function(){ resolve(true); };
        tx.onerror = tx.onabort = function(){ warnImageDB(tx.error); resolve(false); };
      });
    });
  });
}
function getImage(name){
  if(!name) return Promise.resolve(null);
  return openImageDB().then(function(db){
    if(!db) return null;
    return new Promise(function(resolve){
      var req;
      try{ req = db.transaction("images", "readonly").objectStore("images").get(name); }
      catch(e){ warnImageDB(e); resolve(null); return; }
      req.onsuccess = function(){ resolve(req.result || null); };
      req.onerror = function(){ warnImageDB(req.error); resolve(null); };
    });
  });
}
function deleteImages(names){
  names = names.filter(function(name, i){ return name && names.indexOf(name) === i; });
  if(!names.length) return Promise.resolve(true);
  return queueImageOp(function(){
    return openImageDB().then(function(db){
      if(!db) return false;
      return new Promise(function(resolve){
        var tx;
        try{
          tx = db.transaction("images", "readwrite");
          names.forEach(function(name){ tx.objectStore("images").delete(name); });
        }catch(e){ warnImageDB(e); resolve(false); return; }
        tx.oncomplete = function(){ resolve(true); };
        tx.onerror = tx.onabort = function(){ warnImageDB(tx.error); resolve(false); };
      });
    });
  });
}
function deleteCommentImages(comments){
  var names = [];
  comments.forEach(function(c){
    (c.images || []).forEach(function(im){ if(im.name) names.push(im.name); });
  });
  deleteImages(names);
}
function dataURIToBlob(data){
  if(!data || typeof data !== "string") return null;
  try{
    var comma = data.indexOf(","), meta = data.slice(0, comma), body = data.slice(comma+1);
    if(comma < 0) return null;
    var raw = /;base64/i.test(meta) ? atob(body) : decodeURIComponent(body);
    var bytes = new Uint8Array(raw.length);
    for(var i=0;i<raw.length;i++) bytes[i] = raw.charCodeAt(i) & 255;
    var m = /^data:([^;,]+)/i.exec(meta);
    return new Blob([bytes], {type:m ? m[1] : "application/octet-stream"});
  }catch(e){ return null; }
}
function blobBytes(blob){
  return new Promise(function(resolve, reject){
    var reader = new FileReader();
    reader.onload = function(){ resolve(new Uint8Array(reader.result)); };
    reader.onerror = function(){ reject(reader.error || new Error("画像を読めませんでした")); };
    reader.readAsArrayBuffer(blob);
  });
}
function imageExt(type, name){
  type = String(type || "").toLowerCase();
  var known = {"image/jpeg":"jpg", "image/pjpeg":"jpg", "image/png":"png", "image/gif":"gif",
    "image/webp":"webp", "image/avif":"avif", "image/svg+xml":"svg", "image/bmp":"bmp",
    "image/x-icon":"ico", "image/vnd.microsoft.icon":"ico", "image/tiff":"tif",
    "image/heic":"heic", "image/heif":"heif", "image/apng":"apng"};
  if(known[type]) return known[type];
  var m = /^image\/([a-z0-9.+-]+)$/.exec(type);
  if(m){
    var sub = m[1].replace(/^x-/, "").replace(/\+xml$/, "");
    if(/^[a-z0-9][a-z0-9-]{0,15}$/.test(sub)) return sub;
  }
  var byName = /\.([A-Za-z0-9][A-Za-z0-9-]{0,15})$/.exec(name || "");
  return byName ? byName[1].toLowerCase() : "img";
}
function nameWithExt(name, ext){
  return /\.[A-Za-z0-9][A-Za-z0-9-]{0,15}$/.test(name) ?
    name.replace(/\.[A-Za-z0-9][A-Za-z0-9-]{0,15}$/, "." + ext) : name + "." + ext;
}
function uniqueExportName(name, used){
  if(used.indexOf(name) === -1) return name;
  var m = /^(.*?)(\.[^.]+)?$/.exec(name), base = m[1], ext = m[2] || "", n = 2;
  while(used.indexOf(base + "-" + n + ext) !== -1) n++;
  return base + "-" + n + ext;
}
function exportImageRefs(open){
  var refs = [], names = [];
  open.forEach(function(c){
    (c.images || []).forEach(function(im){
      if(im.name && names.indexOf(im.name) === -1){ names.push(im.name); refs.push(im); }
    });
  });
  return refs;
}
function collectExportImages(open){
  var refs = exportImageRefs(open);
  return Promise.all(refs.map(function(im){
    return getImage(im.name).then(function(original){
      var fallback = !original, blob = original || dataURIToBlob(im.thumb);
      if(!blob){
        console.warn("[rv] 原寸もサムネイルも無いためzipへ入れられません: " + im.name);
        return {im:im, blob:null, fallback:true};
      }
      return blobBytes(blob).then(function(bytes){ return {im:im, blob:blob, data:bytes, fallback:fallback}; });
    });
  })).then(function(items){
    var files = [], fallback = [], omitted = [], names = {}, used = [];
    items.forEach(function(item){
      if(!item.blob){ omitted.push(item.im.name); return; }
      if(item.fallback) fallback.push(item.im.name);
      var name = nameWithExt(item.im.name, imageExt(item.blob.type, item.im.name));
      name = uniqueExportName(name, used); used.push(name); names[item.im.name] = name;
      files.push({name:"images/" + name, data:item.data});
    });
    return {files:files, fallback:fallback, omitted:omitted, names:names};
  });
}
function docSlug(){
  return LEGACY_DOC.replace(/\.html?$/i, "").replace(/[^A-Za-z0-9\-_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "page";
}
function renderPopImgs(){
  var box = document.getElementById("rvimgs");
  if(!box) return;
  box.innerHTML = "";
  popImgs.forEach(function(im, i){
    var fig = document.createElement("figure");
    var el = document.createElement("img");
    el.src = im.thumb || im.data;
    el.alt = im.name || ("画像" + (i+1));
    var del = document.createElement("button");
    del.type = "button"; del.textContent = "×"; del.title = "この画像を外す";
    del.onclick = function(ev){
      ev.stopPropagation();
      touchComment(editing);
      popImgs.splice(i, 1); renderPopImgs();
    };
    fig.appendChild(el); fig.appendChild(del);
    box.appendChild(fig);
  });
}
function addImage(file){
  if(!file || !/^image\//.test(file.type)) return;
  // 読み込みは非同期なので、判定の時点で読み込み中の分も数に入れないと
  // 複数枚を一度に投下したとき全部が判定を通過して上限をすり抜ける
  if(popImgs.length + popImgsPending >= MAXIMG){ toast("画像は" + MAXIMG + "枚までです"); return; }
  var gen = popGen;   // この読み込みがどのポップアップに属するか
  popImgsPending++;
  var done = function(){ if(gen === popGen) popImgsPending--; };
  var reader = new FileReader();
  reader.onload = function(){
    var img = new Image();
    img.onload = function(){
      // 読み込み中に別のコメントを開いた/閉じた場合、この画像は行き先を失っている。
      // そのまま push すると無関係なコメントへ混入する
      if(gen !== popGen){ toast("画像の読み込み中にコメントが切り替わったため、添付を取りやめました"); return; }
      done();
      var max = 320, sc = Math.min(1, max / Math.max(img.width, img.height));
      var cv = document.createElement("canvas");
      cv.width = Math.max(1, Math.round(img.width * sc));
      cv.height = Math.max(1, Math.round(img.height * sc));
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      var ext = imageExt(file.type, file.name);
      touchComment(editing);
      popImgs.push({name:null, ext:ext, data:reader.result, blob:file, thumb:cv.toDataURL("image/jpeg", 0.6)});
      renderPopImgs();
      toast("画像を1枚つけました");
    };
    img.onerror = function(){ done(); toast("この画像は読めませんでした"); };
    img.src = reader.result;
  };
  reader.onerror = function(){ done(); toast("この画像は読めませんでした"); };
  reader.readAsDataURL(file);
}
function imageSequenceTaken(commentId, n){
  var prefix = "rv-" + docSlug() + "-" + commentId + "-" + n + ".", taken = false;
  store.comments.forEach(function(c){
    (c.images || []).forEach(function(im){ if(im.name && im.name.indexOf(prefix) === 0) taken = true; });
  });
  popImgs.forEach(function(im){ if(im.name && im.name.indexOf(prefix) === 0) taken = true; });
  return taken;
}
// ---------- 画像の保存先フォルダ（任意・Chromium系のみ） ----------
// 無くても成立する飾り。コピー文面はファイル名で渡すので、受け手のAIは
// ダウンロードフォルダでも選んだフォルダでも名前で見つけられる。
// フォルダを選ぶ利点は2つだけ＝ダウンロードの通知が出ない・まとめて捨てられる。
function dirPickerAvailable(){ return typeof window.showDirectoryPicker === "function"; }
// コピー文面は同期で組むので、フォルダ名だけ手元に控えておく。
// ボタンの見た目もここで揃える（選ばれているかが一目で分かるようにする）。
function setImageDir(dir){
  imageDirName = dir ? dir.name : null;
  var btn = document.getElementById("rvdir");
  if(!btn) return;
  btn.textContent = imageDirName ? "保存先 ✓" : "保存先";
  btn.title = imageDirName
    ? "画像は「" + imageDirName + "」へ書かれる（押すと選び直せる）"
    : "画像の保存先フォルダを選ぶ。選ばないあいだはダウンロードフォルダへ落ちる";
}
function readDirHandle(){
  return openImageDB().then(function(db){
    if(!db || !db.objectStoreNames.contains("handles")) return null;
    return new Promise(function(resolve){
      var req;
      try{ req = db.transaction("handles", "readonly").objectStore("handles").get("imageDir"); }
      catch(e){ resolve(null); return; }
      req.onsuccess = function(){ resolve(req.result || null); };
      req.onerror = function(){ resolve(null); };
    });
  }).catch(function(){ return null; });
}
function writeDirHandle(handle){
  return openImageDB().then(function(db){
    if(!db || !db.objectStoreNames.contains("handles")) return false;
    return new Promise(function(resolve){
      var tx;
      try{
        tx = db.transaction("handles", "readwrite");
        if(handle) tx.objectStore("handles").put(handle, "imageDir");
        else tx.objectStore("handles").delete("imageDir");
      }catch(e){ resolve(false); return; }
      tx.oncomplete = function(){ resolve(true); };
      tx.onerror = tx.onabort = function(){ resolve(false); };
    });
  }).catch(function(){ return false; });
}
// 保存の瞬間は許可を「聞き直さない」。requestPermissionは直前のクリックが要るうえ、
// IndexedDBを待つ間に有効期限が切れうるため、聞き直しは「保存先」ボタン側だけで行う。
function dirIfAllowed(){
  return readDirHandle().then(function(dir){
    if(!dir || !dir.queryPermission) return null;
    return dir.queryPermission({mode:"readwrite"}).then(function(state){
      return state === "granted" ? dir : null;
    }, function(){ return null; });
  });
}
function downloadOriginal(name, dataURI){
  var a = document.createElement("a");
  a.href = dataURI; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}
// 原寸をローカルへ出す。フォルダが選ばれて許可も生きていればそこへ書き、
// それ以外は従来どおりダウンロードへ落とす（＝どの環境でも必ずどこかに残る）。
function saveOriginal(name, blob, dataURI){
  return dirIfAllowed().then(function(dir){
    if(!dir) return null;
    return dir.getFileHandle(name, {create:true})
      .then(function(fh){ return fh.createWritable(); })
      .then(function(w){ return Promise.resolve(w.write(blob)).then(function(){ return w.close(); }); })
      .then(function(){ return dir.name; });
  }).catch(function(e){
    console.warn("[rv] 保存先フォルダへ書けませんでした。ダウンロードへ落とします。", e);
    return null;
  }).then(function(writtenTo){
    if(writtenTo) return writtenTo;
    downloadOriginal(name, dataURI);
    return null;
  });
}

// 保存されていない画像に名前を付け、原寸を残してコメントの形へ畳む。
// 原寸は (1)IndexedDB＝「書き出し」zip用 と (2)ローカルのファイル＝コピペ運用用 の両方へ出す。
function flushImages(commentId){
  var next = 1;
  popImgs.forEach(function(im){
    if(im.name) return;
    while(imageSequenceTaken(commentId, next)) next++;
    im.name = "rv-" + docSlug() + "-" + commentId + "-" + next + "." + im.ext;
    next++;
    var name = im.name, data = im.data, blob = im.blob || dataURIToBlob(data);
    putImage(name, blob);            // 「書き出し」zip用。失敗してもコピペ運用には響かない
    saveOriginal(name, blob, data);  // コピー文面がファイル名で指す実体
  });
  return popImgs.map(function(im){ return {name:im.name, thumb:im.thumb}; });
}

// ---------- 枠（ブロック）へのコメント ----------
var RVIDS = /^rv(orphan|bar|pop|toast|donepanel|marks|sel|hover|crop)$/;
function isRvNode(el){
  return !!(el && ((el.id && RVIDS.test(el.id)) ||
    (el.tagName === "MARK" && el.classList && el.classList.contains("rv"))));
}
function isRvChrome(el){
  return !!(el && el.closest && el.closest("#rvbar,#rvpop,#rvtoast,#rvdonepanel,#rvorphan,#rvmarks,#rvhover,#rvcrop,#rvguide"));
}
// ROOTからの位置。rvが差し込んだ要素は数に入れない（#rvorphanでズレるのを避ける）
function blockPath(el){
  var parts = [], n = el;
  while(n && n !== ROOT && n.parentElement){
    var k = 0, found = 0;
    for(var c = n.parentElement.firstElementChild; c; c = c.nextElementSibling){
      if(isRvNode(c)) continue;
      k++;
      if(c === n){ found = k; break; }
    }
    if(!found) return null;
    parts.unshift(found);
    n = n.parentElement;
  }
  return parts.join(">");
}
function elByPath(path){
  if(path == null) return null;
  if(path === "") return ROOT;   // ROOT自身を指す
  var n = ROOT, parts = path.split(">");
  for(var i=0;i<parts.length;i++){
    var want = parseInt(parts[i], 10), k = 0, hit = null;
    for(var c = n.firstElementChild; c; c = c.nextElementSibling){
      if(isRvNode(c)) continue;
      if(++k === want){ hit = c; break; }
    }
    if(!hit) return null;
    n = hit;
  }
  return n;
}
function textOfBlock(el, f){
  f = f || flat();
  var s = "";
  for(var i=0;i<f.map.length;i++) if(el.contains(f.map[i].node)) s += f.map[i].node.nodeValue;
  return s.replace(/\s+/g, " ").trim();
}
function fpOf(el, f){
  var t = textOfBlock(el, f).slice(0, 80);
  if(t) return t;
  var img = el.tagName === "IMG" ? el : el.querySelector("img");
  if(img) return "[img:" + (img.getAttribute("src") || "").split("/").pop().slice(0, 40) + "]";
  return "";
}
function fpMatch(a, b){
  var n = Math.min(40, a.length, b.length);
  return n >= 8 && a.slice(0, n) === b.slice(0, n);
}
function classSig(el){
  if(typeof el.className !== "string") return "";
  return el.className.trim().split(/\s+/).filter(Boolean).sort().join(".");
}
function attrSig(el){
  var keep = {id:1,name:1,href:1,src:1,alt:1,title:1,role:1,"aria-label":1};
  var out = [];
  for(var i=0;i<el.attributes.length;i++){
    var a = el.attributes[i];
    if(keep[a.name] || a.name.indexOf("data-") === 0) out.push(a.name + "=" + a.value);
  }
  return out.sort().join("|");
}
function elementOrder(el){
  var all = ROOT.getElementsByTagName("*"), n = 0;
  for(var i=0;i<all.length;i++){
    if(isRvNode(all[i]) || isRvChrome(all[i])) continue;
    if(all[i] === el) return n;
    n++;
  }
  return -1;
}
function blockTextBounds(el, f){
  var start = -1, end = -1;
  for(var i=0;i<f.map.length;i++){
    if(!el.contains(f.map[i].node)) continue;
    if(start < 0) start = f.map[i].at;
    end = f.map[i].at + f.map[i].node.nodeValue.length;
  }
  return {start:start, end:end};
}
function blockAnchor(el, f){
  f = f || flat();
  var text = textOfBlock(el, f), b = blockTextBounds(el, f);
  return {tail:text.slice(Math.max(0, text.length-80)), attrs:attrSig(el),
    parent:el.parentElement ? el.parentElement.tagName + "." + classSig(el.parentElement) : "",
    before:b.start >= 0 ? f.text.slice(Math.max(0, b.start-CTX), b.start) : "",
    after:b.end >= 0 ? f.text.slice(b.end, b.end+CTX) : "",
    ratio:b.start >= 0 && f.text.length ? b.start / f.text.length : null,
    ord:elementOrder(el)};
}
function pathDistance(a, b){
  if(a == null || b == null) return 0;
  var aa = a === "" ? [] : a.split(">");
  var bb = b === "" ? [] : b.split(">");
  var n = Math.max(aa.length, bb.length), d = Math.abs(aa.length-bb.length) * 3;
  for(var i=0;i<n;i++) d += Math.abs(parseInt(aa[i] || 0, 10) - parseInt(bb[i] || 0, 10));
  return d;
}
function scoreBlock(el, c, f){
  var path = blockPath(el), fp = fpOf(el, f), cls = classSig(el);
  var oldCls = (c.cls || "").trim().split(/\s+/).filter(Boolean).sort().join(".");
  var a = c.anchor || {}, now = blockAnchor(el, f), score = 0, anchored = false;
  if(path === c.path){ score += 50; }
  else score -= Math.min(35, pathDistance(path, c.path) * 3);
  if(c.fp && fp === c.fp){ score += 120; anchored = true; }
  else if(c.fp && fpMatch(fp, c.fp)){ score += 75; anchored = true; }
  if(oldCls && cls === oldCls) score += 30;
  if(a.tail && now.tail === a.tail){ score += 70; anchored = true; }
  if(a.attrs && now.attrs === a.attrs){ score += 110; anchored = true; }
  if(a.parent && now.parent === a.parent) score += 20;
  if(a.before && now.before === a.before){ score += 45; anchored = true; }
  if(a.after && now.after === a.after){ score += 45; anchored = true; }
  if(typeof a.ord === "number" && now.ord >= 0) score -= Math.min(35, Math.abs(now.ord-a.ord));
  if(typeof a.ratio === "number" && typeof now.ratio === "number")
    score -= Math.min(30, Math.abs(now.ratio-a.ratio) * 100);
  return {el:el, score:score, anchored:anchored};
}
// 改訂後のHTMLでも同じ枠を見つけ直す。全候補を中身・周辺文脈・属性・元位置で採点する。
// 根拠が足りない候補や同点は、別の枠へ誤表示させず未照合にする。
function findBlock(c){
  if(!c.tag) return null;
  var f = flat(), list = c.tag === ROOT.tagName ? [ROOT] :
    Array.prototype.slice.call(ROOT.querySelectorAll(c.tag));
  var scored = [];
  for(var i=0;i<list.length;i++){
    if(isRvNode(list[i]) || isRvChrome(list[i])) continue;
    var s = scoreBlock(list[i], c, f);
    if(s.anchored) scored.push(s);
  }
  scored.sort(function(a, b){ return b.score - a.score; });
  if(!scored.length){
    var oldCls = (c.cls || "").trim().split(/\s+/).filter(Boolean).sort().join(".");
    var weak = list.filter(function(el){ return oldCls && classSig(el) === oldCls; });
    // 中身の手がかりが全滅した場合も、同クラスが1件だけなら別要素へは化けない。
    if(weak.length === 1) return weak[0];
    if(!c.fp && !oldCls && list.length === 1 && blockPath(list[0]) === c.path) return list[0];
    return null;
  }
  if(scored.length > 1 && scored[0].score === scored[1].score) return null;
  return scored[0].el;
}
function describe(el){
  var t = el.tagName.toLowerCase();
  var cls = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
  return cls ? t + "." + cls : t;
}
function blockLabel(o){
  var t = (o.tag || "").toLowerCase();
  if(o.cls) t += "." + o.cls.split(/\s+/)[0];
  return "〔枠〕" + t + (o.fp ? "「" + o.fp.slice(0, 40) + "…」" : "");
}
function candidateAt(x, y){
  var el = document.elementFromPoint(x, y);
  if(!el || isRvChrome(el)) return null;
  var inlineFallback = null;
  while(el && el !== document.body){
    if(ROOT.contains(el) && !isRvChrome(el) && !isRvNode(el)){
      var display = getComputedStyle(el).display;
      // display:contents 自身には枠が無い。最寄りの通常要素を優先し、
      // ブロック祖先が無い構造では実際に箱を持つinline要素を最後の候補にする。
      if(display !== "contents"){
        if(display !== "inline") return el;
        if(!inlineFallback && el.getClientRects().length) inlineFallback = el;
      }
    }
    el = el.parentElement;
  }
  return inlineFallback || (ROOT.contains(document.body) ? ROOT : null);
}
// セル・行・リスト項目は単体で指しても仕方がないので、表・リスト・図の全体まで上げる。
// ↓キーで戻れるように、上げた分は「初期の段数」として持つ（要素を差し替えない）
var PARTS = {TH:1,TD:1,TR:1,THEAD:1,TBODY:1,TFOOT:1,CAPTION:1,COLGROUP:1,COL:1,LI:1,DT:1,DD:1,FIGCAPTION:1};
function promoteLevels(el){
  var n = 0, cur = el;
  while(cur && PARTS[cur.tagName] && cur !== ROOT && cur.parentElement && ROOT.contains(cur.parentElement)){
    cur = cur.parentElement; n++;
  }
  return n;
}
function levelUp(el, n){
  while(n-- > 0 && el && el !== ROOT){
    var p = el.parentElement;
    while(p && p !== ROOT && ROOT.contains(p) && getComputedStyle(p).display === "contents")
      p = p.parentElement;
    if(!p || !ROOT.contains(p)) break;
    el = p;
  }
  return el;
}
function showHover(el){
  hoverEl = el;
  var h = document.getElementById("rvhover");
  if(!h) return;
  if(!el){ h.style.display = "none"; return; }
  var r = el.getBoundingClientRect();
  h.style.display = "block";
  h.style.left = (r.left + window.scrollX - 3) + "px";
  h.style.top = (r.top + window.scrollY - 3) + "px";
  h.style.width = r.width + "px";
  h.style.height = r.height + "px";
  h.firstChild.textContent = describe(el);
}
// ---------- 切り取り（写真のトリミングと同じ操作） ----------
function showCrop(r){
  var el = document.getElementById("rvcrop");
  if(!el) return;
  if(!r){ el.style.display = "none"; return; }
  el.style.display = "block";
  el.style.left = r.x + "px"; el.style.top = r.y + "px";
  el.style.width = r.w + "px"; el.style.height = r.h + "px";
  el.firstChild.textContent = Math.round(r.w) + " × " + Math.round(r.h);
}
// 切り取った矩形を丸ごと含む一番内側の要素。改訂後もここを起点に描き直す。
// elementFromPointは画面に映っている範囲しか答えないので、DOMを降りて探す
function containsRect(el, r){
  var b = el.getBoundingClientRect();
  if(!b.width && !b.height) return false;
  return b.left + window.scrollX <= r.x + 1 && b.top + window.scrollY <= r.y + 1 &&
         b.right + window.scrollX >= r.x + r.w - 1 && b.bottom + window.scrollY >= r.y + r.h - 1;
}
function baseFor(r){
  var best = ROOT, guard = 0;
  for(var el = ROOT; el && guard++ < 40; ){
    // 図の中まで降りると <rect> のような手がかりにならない名前になる。svgで止める
    if(String(el.tagName).toLowerCase() === "svg") break;
    var next = null;
    for(var c = el.firstElementChild; c; c = c.nextElementSibling){
      if(isRvNode(c) || isRvChrome(c)) continue;
      if(containsRect(c, r)){ next = c; break; }
    }
    if(!next) break;
    best = next; el = next;
  }
  return best;
}
// 矩形の中に何が写っているかを文字で拾う（AIが場所を特定するための手がかり）
function textIn(r){
  var pts = [], steps = 4, seen = [], out = "", f = flat();
  // 4x4の均等グリッド。中央＋四隅寄りの5点より、細い文字列や表のセルを拾いやすくする。
  for(var row=0;row<steps;row++) for(var col=0;col<steps;col++)
    pts.push([(col+.5)/steps, (row+.5)/steps]);
  for(var i=0;i<pts.length;i++){
    var x = r.x + r.w*pts[i][0] - window.scrollX;
    var y = r.y + r.h*pts[i][1] - window.scrollY;
    var stack = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [document.elementFromPoint(x, y)];
    var el = null;
    for(var j=0;j<stack.length;j++){
      if(stack[j] && !isRvChrome(stack[j]) && !isRvNode(stack[j]) && ROOT.contains(stack[j])){
        el = stack[j]; break;
      }
    }
    if(!el || seen.indexOf(el) !== -1) continue;
    seen.push(el);
    var t = textOfBlock(el, f);
    if(t && out.indexOf(t.slice(0, 20)) === -1) out += (out ? " / " : "") + t.slice(0, 60);
  }
  return out.slice(0, 90);
}
function cropLabel(o){
  var t = (o.tag || "").toLowerCase();
  if(o.cls) t += "." + o.cls.split(/\s+/)[0];
  return "〔切り取り〕" + Math.round(o.px) + "×" + Math.round(o.py) + " / " + t +
         (o.inner ? "「" + o.inner + "」" : "");
}
function startCropComment(r){
  if(pop.style.display === "block" && !tryClose()) return;
  var base = baseFor(r), b = base.getBoundingClientRect(), f = flat();
  var bx = b.left + window.scrollX, by = b.top + window.scrollY;
  editing = null;
  pending = {kind:"crop", heading:headingOf(base), path:blockPath(base), tag:base.tagName,
    cls: typeof base.className === "string" ? base.className.trim() : "", fp:fpOf(base, f),
    anchor:blockAnchor(base, f),
    inner: textIn(r), px: r.w, py: r.h,
    rect: {x:(r.x - bx) / (b.width || 1), y:(r.y - by) / (b.height || 1),
           w: r.w / (b.width || 1), h: r.h / (b.height || 1)}};
  openPop(r.x + Math.min(r.w/2, 220) - window.scrollX, r.y + r.h - window.scrollY + 8,
          cropLabel(pending), "", []);
}
// 保存済みの切り取りを、いまのレイアウトのどこに描くか
function cropBox(c){
  var base = findBlock(c);
  if(!base) return null;
  var b = base.getBoundingClientRect();
  return {left: b.left + window.scrollX + c.rect.x * b.width,
          top: b.top + window.scrollY + c.rect.y * b.height,
          width: c.rect.w * b.width, height: c.rect.h * b.height};
}

function enterPick(){
  if(picking) return;
  picking = true; closePop();
  document.body.classList.add("rvpicking");
  toast("ドラッグで切り取り。クリックだけなら枠ごと（↑↓で外側/内側・Escでやめる）");
}
function exitPick(){
  picking = false; pickBase = null; pickLevel = 0;
  dragging = false; dragFrom = null; altPick = false;
  document.body.classList.remove("rvpicking");
  showHover(null); showCrop(null);
}
function startBlockComment(el){
  if(pop.style.display === "block" && !tryClose()) return;
  var f = flat();
  editing = null;
  pending = {kind:"block", heading:headingOf(el), path:blockPath(el), tag:el.tagName,
    cls: typeof el.className === "string" ? el.className.trim() : "", fp:fpOf(el, f),
    anchor:blockAnchor(el, f)};
  var r = el.getBoundingClientRect();
  openPop(r.left + Math.min(r.width/2, 220), r.top + 26, blockLabel(pending), "", []);
}
// 枠線とバッジは本文のDOMに触らず上に重ねる（送付版でも消す作業が要らない）
function drawBlockBoxes(){
  var layer = document.getElementById("rvmarks");
  if(!layer) return;
  layer.innerHTML = "";
  blockItems.forEach(function(it){
    var g = it.box;
    if(!g && it.el){
      var r = it.el.getBoundingClientRect();
      g = {left: r.left + window.scrollX - 3, top: r.top + window.scrollY - 3,
           width: r.width + 2, height: r.height + 2};
    } else if(g && it.c.kind === "crop"){
      g = cropBox(it.c) || g;   // リサイズ後は今の位置で引き直す
    }
    if(!g) return;
    var box = document.createElement("div");
    box.className = "rvbox";
    box.style.left = g.left + "px";
    box.style.top = g.top + "px";
    box.style.width = g.width + "px";
    box.style.height = g.height + "px";
    var b = document.createElement("button");
    b.type = "button"; b.className = "rvbadge"; b.textContent = String(it.n);
    b.onclick = function(ev){
      ev.stopPropagation();
      if(pop.style.display === "block" && !tryClose()) return;
      editing = it.c.id; pending = null;
      openPop(g.left - window.scrollX + Math.min(g.width/2, 220),
              g.top - window.scrollY + 26, it.c.quote, it.c.note, it.c.images);
    };
    box.appendChild(b);
    layer.appendChild(box);
  });
}

// コメント欄へ文字を打つとブラウザ側の選択ハイライトが消える（openPopのコメント参照）。
// 広い範囲を選んだときに対象が見えなくなるので、行ごとの矩形を自前で重ねておく。
// 本文のDOMには触らない。保存・取消・削除では closePop() 経由で消える。
function drawPendingSel(range){
  pendingRange = range || null;
  var layer = document.getElementById("rvsel");
  if(!layer) return;
  layer.innerHTML = "";
  if(!pendingRange) return;
  var rects;
  try{ rects = pendingRange.getClientRects(); }catch(e){ pendingRange = null; return; }
  for(var i=0;i<rects.length;i++){
    var r = rects[i];
    if(r.width < 1 || r.height < 1) continue;   // 折り返しの継ぎ目に出る幅0の矩形は捨てる
    var box = document.createElement("div");
    box.className = "rvselbox";
    box.style.left = (r.left + window.scrollX - 1) + "px";
    box.style.top = (r.top + window.scrollY - 1) + "px";
    box.style.width = (r.width + 2) + "px";
    box.style.height = (r.height + 2) + "px";
    layer.appendChild(box);
  }
}
function clearPendingSel(){ drawPendingSel(null); }

function commentById(id){
  return store.comments.filter(function(c){ return c.id === id; })[0] || null;
}
// 既存コメントを開いているときだけ、本文と追記をスレッドとして出す。
// 入力欄は既定で「追記」。本文そのものを直したいときは本文行の「直す」で切り替える
// （入力欄を2つ置くとポップアップが縦に伸びて、狭い画面で保存ボタンが隠れるため）。
function renderThread(){
  var box = document.getElementById("rvthread");
  if(!box) return;
  box.innerHTML = "";
  var c = editing ? commentById(editing) : null;
  if(!c){ box.style.display = "none"; return; }
  box.style.display = "block";

  var main = document.createElement("div"); main.className = "rvline";
  var mainTxt = document.createElement("span"); mainTxt.className = "rvtxt"; mainTxt.textContent = c.note;
  var editBtn = document.createElement("button"); editBtn.type = "button";
  editBtn.textContent = editingBody ? "追記へ" : "直す";
  editBtn.title = editingBody ? "入力欄を追記に戻す" : "入力欄で本文を書き直す";
  editBtn.onclick = function(ev){
    ev.stopPropagation();
    editingBody = !editingBody;
    var ta = document.getElementById("rvnote");
    ta.value = editingBody ? c.note : "";
    ta.placeholder = editingBody ? "ここ、こう直す" : "追記を書く";
    renderThread(); ta.focus();
  };
  main.appendChild(mainTxt); main.appendChild(editBtn);
  box.appendChild(main);

  (c.replies || []).forEach(function(r, i){
    var row = document.createElement("div"); row.className = "rvline rvsub";
    var t = document.createElement("span"); t.className = "rvtxt"; t.textContent = r.text;
    var del = document.createElement("button"); del.type = "button";
    del.textContent = "×"; del.title = "この追記を消す";
    del.onclick = function(ev){
      ev.stopPropagation();
      touchComment(c.id);
      c.replies.splice(i, 1); save(); renderThread(); render();
    };
    row.appendChild(t); row.appendChild(del);
    box.appendChild(row);
  });
}
function openPop(x, y, quote, note, images){
  document.getElementById("rvquote").textContent = quote;
  var ta = document.getElementById("rvnote");
  // 新規は本文を書く欄、既存を開いたときは追記の欄（本文はスレッド側に出す）
  ta.value = editing ? "" : (note || "");
  ta.placeholder = editing ? "追記を書く" : "ここ、こう直す";
  renderThread();
  popGen++; popImgsPending = 0;
  popImgs = (images || []).map(function(im){ return {name:im.name, ext:"png", data:null, thumb:im.thumb}; });
  renderPopImgs();
  document.getElementById("rvdel").style.display = editing ? "" : "none";
  pop.style.display = "block";
  var w = pop.offsetWidth, left = Math.min(Math.max(8, x - w/2), window.innerWidth - w - 8);
  pop.style.left = left + "px";
  // 下に出すと画面からはみ出す位置（済みパネルの行・画面下端のマーク）では上へ返す
  var h = pop.offsetHeight, top = y + 10;
  if(top + h > window.innerHeight - 8) top = Math.max(8, y - h - 10);
  pop.style.top = (top + window.scrollY) + "px";
  // ここでフォーカスを移すと選択が解けてCmd+Cが効かなくなる（実測 Chromium 145）。
  // 文字キーを押した時点で初めてコメント欄へ入る（bindEventsのkeydown）
}
// ---------- ポップアップを動かす ----------
// 指摘したい箇所そのものにポップアップが重なると、周りの文脈が読めないまま書くことになる
// （引用文はポップアップ内に出るが、その前後を見ながら直したい）。引用文の帯を掴んで
// 動かせるようにする。掴めるのは引用文だけ＝入力欄の選択やボタンの操作を邪魔しない。
// 動かした位置は開いている間だけ有効で、閉じれば既定の配置へ戻る。次のコメントは別の場所に
// 出るので、前回動かした位置を覚えていると対象から離れた場所に出てしまう
var popDrag = null;
function clampPop(left, top){
  var w = pop.offsetWidth, h = pop.offsetHeight;
  // ポップアップが画面より高いときは下端の制限が上端を追い越すので、下限を8pxで止める
  var maxL = Math.max(8, window.innerWidth - w - 8);
  var maxT = Math.max(8, window.innerHeight - h - 8);
  return {left: Math.min(Math.max(8, left), maxL), top: Math.min(Math.max(8, top), maxT)};
}
function bindPopDrag(){
  var q = document.getElementById("rvquote");
  if(!q) return;
  q.title = "ドラッグでこの枠を動かせる（閉じると元の位置に戻る）";
  q.addEventListener("mousedown", function(ev){
    if(ev.button !== 0) return;
    var r = pop.getBoundingClientRect();
    popDrag = {dx: ev.clientX - r.left, dy: ev.clientY - r.top};
    pop.classList.add("rvmoving");
    ev.preventDefault();     // 掴んだまま本文やUIの選択が走らないように
  });
  document.addEventListener("mousemove", function(ev){
    if(!popDrag) return;
    var pos = clampPop(ev.clientX - popDrag.dx, ev.clientY - popDrag.dy);
    pop.style.left = pos.left + "px";
    pop.style.top = (pos.top + window.scrollY) + "px";
    ev.preventDefault();
  });
  document.addEventListener("mouseup", function(){
    if(!popDrag) return;
    pop.classList.remove("rvmoving");
    // 同じmouseupを見る他のハンドラ（選択の確定）が「移動中だった」と判定できるよう、
    // 実際に畳むのは1周あとにする。登録順に依存しないための遅延
    setTimeout(function(){ popDrag = null; }, 0);
  });
}

// 書きかけがあるか。Escapeとページ遷移で黙って消さないための判定。
function hasUnsavedDraft(){
  if(!pop || pop.style.display !== "block") return false;
  var note = document.getElementById("rvnote");
  if(note && note.value && note.value.trim()) return true;
  return popImgs.some(function(im){ return !im.name; });   // まだ保存していない添付
}
var escArmed = false;   // 1回目のEscで警告、2回目で破棄
function closePop(){
  escArmed = false;
  popDrag = null; if(pop) pop.classList.remove("rvmoving");
  clearPendingSel();
  popGen++; popImgsPending = 0;
  pop.style.display = "none"; editing = null; pending = null; popImgs = []; editingBody = false;
  var th = document.getElementById("rvthread"); if(th){ th.innerHTML = ""; th.style.display = "none"; }
  var box = document.getElementById("rvimgs"); if(box) box.innerHTML = "";
}
function tryClose(){
  if(hasUnsavedDraft() && !escArmed){
    escArmed = true;
    toast("書きかけがあります。もう一度操作すると破棄します");
    setTimeout(function(){ escArmed = false; }, 4000);
    return false;
  }
  closePop();
  return true;
}

function bindEvents(){
  document.addEventListener("mouseup", function(ev){
    // 枠を動かしている最中の離しは、本文の選択でも枠外クリックでもない。
    // ここへ渡すと選択の確定が走り、動かした位置が既定へ描き直される
    if(popDrag) return;
    if(pop.contains(ev.target)) return;
    if(isRvChrome(ev.target)) return;
    if(picking){
      var wasDrag = dragging, from = dragFrom, picked = hoverEl;
      exitPick();
      if(wasDrag && from){
        var r = {x: Math.min(from.x, ev.pageX), y: Math.min(from.y, ev.pageY),
                 w: Math.abs(ev.pageX - from.x), h: Math.abs(ev.pageY - from.y)};
        if(r.w > 8 && r.h > 8) startCropComment(r);
        return;
      }
      if(!picked){
        var c0 = candidateAt(ev.clientX, ev.clientY);
        if(c0) picked = levelUp(c0, promoteLevels(c0));
      }
      if(picked) startBlockComment(picked);
      return;
    }
    var m = ev.target.closest ? ev.target.closest("mark.rv") : null;
    if(m){
      var c = store.comments.filter(function(x){ return x.id === m.dataset.id; })[0];
      if(c){
        if(pop.style.display === "block" && !tryClose()) return;
        editing = c.id; pending = null;
        var r = m.getBoundingClientRect();
        openPop(r.left + r.width/2, r.bottom, c.quote, c.note, c.images); return;
      }
    }
    var sel = window.getSelection();
    if(!sel || sel.isCollapsed || sel.rangeCount === 0){ if(!editing) tryClose(); return; }
    var range = sel.getRangeAt(0);
    if(!ROOT.contains(range.commonAncestorContainer)) return;
    // 通常のブロック越えは従来通り切る。flex/gridの別アイテム越えはコンテナまで許す。
    var blk = blockOf(range.startContainer, range.endContainer);
    if(!blk.contains(range.endContainer)){
      range = range.cloneRange();
      try{ range.setEnd(blk, blk.childNodes.length); }catch(e){}
    }
    var quote = range.toString().replace(/\s+/g, " ").trim();
    // 1文字だけの選択も受ける。空白だけの微小ドラッグは正規化で空文字になるのでここで落ちる
    if(!quote) return;
    if(pop.style.display === "block" && !tryClose()) return;
    var f = flat();
    var raw = flatOffset(f, range.startContainer, range.startOffset);
    var before = raw >= 0 ? f.text.slice(Math.max(0, raw-CTX), raw) : "";
    var after  = raw >= 0 ? f.text.slice(raw+range.toString().length, raw+range.toString().length+CTX) : "";
    pending = {quote:range.toString(), before:before, after:after, pos:raw,
      heading:headingOf(range.startContainer)};
    editing = null;
    guideAdvance(1);
    var rect = range.getBoundingClientRect();
    drawPendingSel(range);
    openPop(rect.left + rect.width/2, rect.bottom, pending.quote, "", []);
  });

  document.addEventListener("mousedown", function(ev){
    if(ev.button !== 0 || isRvChrome(ev.target) || pop.contains(ev.target)) return;
    if(!picking){
      if(!ev.altKey) return;
      picking = true; altPick = true;
      document.body.classList.add("rvpicking");
    }
    dragFrom = {x: ev.pageX, y: ev.pageY};
    dragging = false;
    ev.preventDefault();
  });

  document.addEventListener("mousemove", function(ev){
    if(!picking) return;
    if(dragFrom){
      var dx = ev.pageX - dragFrom.x, dy = ev.pageY - dragFrom.y;
      if(!dragging && Math.abs(dx) + Math.abs(dy) < 6) return;
      dragging = true;
      showHover(null);
      showCrop({x: Math.min(dragFrom.x, ev.pageX), y: Math.min(dragFrom.y, ev.pageY),
                w: Math.abs(dx), h: Math.abs(dy)});
      return;
    }
    var cand = candidateAt(ev.clientX, ev.clientY);
    if(!cand){ showHover(null); return; }
    pickBase = cand; pickLevel = promoteLevels(cand);
    showHover(levelUp(pickBase, pickLevel));
  });

  document.getElementById("rvsave").onclick = function(){
    var note = document.getElementById("rvnote").value.trim();
    if(editing && editingBody && !note){ toast("本文が空です"); return; }
    if(!note && !popImgs.length){ toast("コメントが空です"); return; }
    var reopened = null;
    if(editing){
      touchComment(editing);
      var imgsE = flushImages(editing);
      store.comments.forEach(function(c){
        if(c.id !== editing) return;
        c.images = imgsE;
        if(editingBody){ c.note = note; }
        else if(note){
          if(!c.replies) c.replies = [];
          // 追記にもIDを振る。IDが無いと保存時の突き合わせが「作成時刻＋本文」しか見られず、
          // 作成時刻は分までしか無いので、同じ分に同じ文面を2回書くと後のほうが消える
          var reply = {id:newCommentId(), text:note, created:nowISO()};
          c.replies.push(reply); markReplySeen(reply);
        }
        // コピー文面は未済みのコメントしか拾わない。済みのまま書き換えるとAIへ届かず、
        // 書いたのに渡らない失敗になる。中身を変えたら未済みへ戻す（読むだけなら保存を押さない）
        if(c.status === "done"){
          c.status = "open";
          reopened = editingBody ? "書き直したので未済みに戻しました"
                                 : "追記したので未済みに戻しました";
        }
      });
    } else if(pending){
      var id = newCommentId();
      seenIds[id] = true;
      touchComment(id);
      var imgsN = flushImages(id);
      if(pending.kind === "crop"){
        store.comments.push({id:id, kind:"crop", heading:pending.heading, quote:cropLabel(pending),
          path:pending.path, tag:pending.tag, cls:pending.cls, fp:pending.fp,
          anchor:pending.anchor, rect:pending.rect, inner:pending.inner,
          note:note, images:imgsN, status:"open", created:nowISO()});
      } else if(pending.kind === "block"){
        store.comments.push({id:id, kind:"block", heading:pending.heading, quote:blockLabel(pending),
          path:pending.path, tag:pending.tag, cls:pending.cls, fp:pending.fp, anchor:pending.anchor,
          note:note, images:imgsN, status:"open", created:nowISO()});
      } else {
        store.comments.push({id:id, heading:pending.heading, quote:pending.quote,
          before:pending.before, after:pending.after, pos:pending.pos, note:note, images:imgsN,
          status:"open", created:nowISO()});
      }
    }
    var savedKind = pending && pending.kind;
    save(); closePop(); render(); window.getSelection().removeAllRanges();
    guideAdvance(2);
    if(savedKind === "block") guideAdvance(3);
    if(savedKind === "crop") guideAdvance(4);
    if(reopened) toast(reopened);
  };
  document.getElementById("rvdel").onclick = function(){
    touchComment(editing);
    deleteCommentImages(store.comments.filter(function(c){ return c.id === editing; }));
    store.comments = store.comments.filter(function(c){ return c.id !== editing; });
    save(); closePop(); render();
  };
  document.getElementById("rvcancel").onclick = tryClose;
  document.getElementById("rvguideskip").onclick = function(){ guideFinish("使い方は出さない。バーのボタンはhoverで説明が出る"); };
  document.getElementById("rvguidenext").onclick = function(){ guideAdvance(guideStep); };
  document.getElementById("rvclear").onclick = function(){
    if(!store.comments.length){ toast("コメントはありません"); return; }
    if(!confirm("コメント" + store.comments.length + "件を全部消します。いい？")) return;
    store.comments.forEach(function(c){ touchComment(c.id); });
    deleteCommentImages(store.comments);
    store.comments = []; store.appliedRevs = []; save(); render(); toast("消しました");
  };
  document.getElementById("rvcopy").onclick = function(){
    var out = copyText();
    if(!out){ toast("未済みコメントはありません"); return; }
    guideAdvance(5);
    navigator.clipboard.writeText(out).then(function(){
      toast("コピーしました。チャットに貼ってください");
    }, function(){
      // execCommand の戻り値を見ないと、禁止されている環境でも「コピーしました」と出る。
      // 読み手は古いクリップボードを貼り、コメントが渡ったと思い込む。
      var t = document.createElement("textarea");
      t.value = out;
      t.style.position = "fixed"; t.style.left = "-9999px";
      document.body.appendChild(t); t.select();
      var ok = false;
      try{ ok = document.execCommand("copy"); }catch(e){ ok = false; }
      t.remove();
      if(ok){ toast("コピーしました（フォールバック）"); return; }
      // どちらの経路も駄目なときは、内容を失わせずにファイルで渡す
      try{
        downloadBlob(new Blob([out], {type:"text/plain;charset=utf-8"}),
                     "rv-" + docSlug() + "-comments.txt");
        toast("コピーできないので、テキストで書き出しました");
      }catch(e2){
        toast("コピーできませんでした。バーの〈zip〉から保存してください");
      }
    });
  };
  document.getElementById("rvexport").onclick = exportReview;

  var dirBtn = document.getElementById("rvdir");
  if(dirBtn) dirBtn.onclick = function(){
    if(!dirPickerAvailable()){
      toast("このブラウザにはフォルダ選択の機能がありません。画像はダウンロードへ落ちます");
      console.info("[rv] window.showDirectoryPicker が無い。Chromium系以外、または" +
        "プライバシー設定で無効化されている。画像はダウンロード経由のままで支障はない");
      return;
    }
    // 許可を聞き直せるのはユーザーのクリック直後だけなので、選び直しも許可の復帰も
    // 全部ここで行う（保存の瞬間には一切聞かない＝作業を止めない）
    readDirHandle().then(function(existing){
      if(!existing || !existing.requestPermission) return null;
      return existing.requestPermission({mode:"readwrite"}).then(function(state){
        return state === "granted" ? existing : null;
      }, function(){ return null; });
    }).then(function(revived){
      if(revived){ setImageDir(revived); toast("保存先は「" + revived.name + "」のままです"); return; }
      return window.showDirectoryPicker({mode:"readwrite", startIn:"downloads"})
        .then(function(dir){
          return writeDirHandle(dir).then(function(){
            setImageDir(dir);
            toast("画像の保存先を「" + dir.name + "」にしました");
          });
        });
    }).catch(function(e){
      if(e && e.name === "AbortError") return;   // 選択をやめただけ
      console.warn("[rv] 保存先を設定できませんでした。", e);
      toast("保存先を設定できませんでした");
    });
  };
  document.getElementById("rvpick").onclick = function(){ picking ? exitPick() : enterPick(); };
  document.getElementById("rvdone").onclick = function(){
    var panel = document.getElementById("rvdonepanel");
    var opening = panel.style.display !== "block";
    if(opening){ renderDonePanel(); panel.style.display = "block"; }
    else{ panel.style.display = "none"; }
  };
  // 画像: ポップアップが開いている間のペーストを拾う
  document.addEventListener("paste", function(e){
    if(pop.style.display !== "block") return;
    var items = (e.clipboardData && e.clipboardData.items) || [];
    var got = false;
    for(var i=0;i<items.length;i++){
      if(items[i].kind === "file" && /^image\//.test(items[i].type)){
        addImage(items[i].getAsFile()); got = true;
      }
    }
    if(got) e.preventDefault();
  });
  // 画像: ポップアップへのドロップ
  pop.addEventListener("dragover", function(e){ e.preventDefault(); pop.classList.add("rvdrag"); });
  pop.addEventListener("dragleave", function(){ pop.classList.remove("rvdrag"); });
  pop.addEventListener("drop", function(e){
    e.preventDefault(); pop.classList.remove("rvdrag");
    var fs = (e.dataTransfer && e.dataTransfer.files) || [];
    for(var i=0;i<fs.length;i++) addImage(fs[i]);
  });

  document.addEventListener("keydown", function(e){
    // 選択直後はフォーカスを本文に残してある（Cmd+Cを効かせるため）。
    // 文字キーを押した時点でコメント欄へ移す。preventDefaultしないので、その1文字も入る
    var printable = (e.key.length === 1) || e.key === "Process" || e.keyCode === 229;
    if(pop.style.display === "block" && printable &&
       !e.metaKey && !e.ctrlKey && !e.altKey){
      var ae = document.activeElement;
      if(!ae || (ae.tagName !== "TEXTAREA" && ae.tagName !== "INPUT")){
        document.getElementById("rvnote").focus();
      }
    }
    if(picking && (e.key === "ArrowUp" || e.key === "ArrowDown")){
      e.preventDefault();
      if(!pickBase) return;
      pickLevel = Math.max(0, pickLevel + (e.key === "ArrowUp" ? 1 : -1));
      showHover(levelUp(pickBase, pickLevel));
      return;
    }
    if(e.key === "Escape" && picking){ exitPick(); return; }
    if(e.key === "Escape"){
      // 書きかけを1回の操作で消さない。押した本人が消したつもりでないことがある
      if(!tryClose()) return;
      var dp = document.getElementById("rvdonepanel");
      if(dp) dp.style.display = "none";
    }
    if((e.metaKey || e.ctrlKey) && e.key === "Enter" && pop.style.display === "block")
      document.getElementById("rvsave").click();
  });

  // 書きかけのまま別のページへ移ると、コメントは保存前なので消える。
  // 対象ページ本文のリンクを踏んだときが一番起きやすい。
  // 書きかけがあるときだけブラウザの確認を出す（無いときは何も足さない）。
  window.addEventListener("beforeunload", function(e){
    if(!hasUnsavedDraft()) return;
    e.preventDefault();
    e.returnValue = "";
    return "";
  });
}

// このブラウザで層を出すか。相手に送ったHTMLで層が出ないのは、ファイルではなく
// 見る側のブラウザにフラグが無いから（外す作業を要らなくするための設計）
// 見る側の判断は三値で持つ。"1"=出す / "0"=出さない / 記録なし=まだ決めていない。
// 「まだ決めていない」ときだけ DEFAULT_ON（作った人の指定）が効く。
// 以前は「出さない」を鍵の削除で表していたが、既定ONのページでは削除＝既定へ戻る
// ＝ #rv-off が効かなくなるため、明示的に "0" を書くようにした
var memFlag = null;      // localStorageが使えない環境での、その読み込み限りの判断
function storageOK(){
  try{ localStorage.setItem(ENABLE_KEY + ":t", "1"); localStorage.removeItem(ENABLE_KEY + ":t"); return true; }
  catch(e){ return false; }
}
function enabled(){
  if(memFlag !== null) return memFlag;
  var v = null;
  try{ v = localStorage.getItem(ENABLE_KEY); }catch(e){ v = null; }
  if(v === "1") return true;
  if(v === "0") return false;
  return DEFAULT_ON;
}
function setEnabled(on){
  memFlag = on;
  try{ localStorage.setItem(ENABLE_KEY, on ? "1" : "0"); }catch(e){}
}
// #rv が付いたURLをそのまま人へ渡すと相手側でも有効になってしまうので、読んだら消す
function dropMark(){
  try{
    var q = location.search.replace(/([?&])rv=[01](&|$)/, "$1").replace(/[?&]$/, "");
    // 消すのは rv の印だけ。ページ内アンカー（#section-3 等）は読み手が
    // その位置を見に来た手がかりなので残す。以前は hash を丸ごと捨てていて、
    // ?rv=1 と一緒にアンカーを渡されると行き先が消えていた。
    var h = (location.hash || "");
    if(h.toLowerCase() === "#rv" || h.toLowerCase() === "#rv-off") h = "";
    history.replaceState(history.state, "", location.pathname + q + h);
  }catch(e){}
}

function scheduleLayout(){
  if(layoutFrame) return;
  layoutFrame = requestAnimationFrame(function(){
    layoutFrame = 0;
    drawBlockBoxes();
    if(pendingRange) drawPendingSel(pendingRange);
    if(hoverEl) showHover(hoverEl);
  });
}
function refreshLayoutObserver(){
  if(!window.ResizeObserver) return;
  if(!layoutObserver) layoutObserver = new ResizeObserver(scheduleLayout);
  layoutObserver.disconnect();
  layoutObserver.observe(ROOT);
  blockItems.forEach(function(it){
    var el = it.el || findBlock(it.c);
    if(el && el !== ROOT) layoutObserver.observe(el);
  });
}
function onResize(){ scheduleLayout(); }

// URLの指示を読んで切り替える。切り替わったら true
// #rv / #rv-off のほか ?rv=1 / ?rv=0 も受ける（ハッシュはツール経由で落ちることがある）
function applyHash(){
  var h = (location.hash || "").toLowerCase(), on = null;
  if(h === "#rv") on = true;
  else if(h === "#rv-off") on = false;
  else {
    var m = /[?&]rv=([01])(?:&|$)/.exec(location.search);
    if(m) on = (m[1] === "1");
  }
  if(on === null) return false;
  var changed = (on !== enabled());
  setEnabled(on);
  // localStorageが使えないとフラグを覚えられない。その場合だけURLの印を残す
  // （残さないと読み込み直すたびに消える。相手側は印なしで開くので出ない）
  if(storageOK()) dropMark();
  else if(on) console.warn("[rv] localStorageが使えないので有効化を覚えられない。URLの印は残す");
  return changed;
}

function init(){
  applyHash();
  // 開いているページのURL末尾に後から #rv を足す使い方だと、同一ページ内の移動になって
  // スクリプトが走り直さない。切り替わったら読み込み直す
  window.addEventListener("hashchange", function(){ if(applyHash()) location.reload(); });
  if(!enabled()){
    console.info("[rv] v" + RV_VERSION + " / レビュー層はこのブラウザではOFF。URL末尾に #rv を付けて開くと出る（止めるのは #rv-off）" +
      (DEFAULT_ON ? " ／ このページは既定ONの指定を持つが、このブラウザで #rv-off が選ばれている" : "") +
      (storageOK() ? "" : " ／ この場所ではlocalStorageが使えないので、開くたびに #rv が要る"));
    return;
  }
  // 本文の走査範囲。セクションごとに .wrap を繰り返すページ（今のHTML成果物がそう）で
  // 最初の1つだけを掴むと、2つ目以降のセクションが範囲外になり、選択してもコメント欄が開かない
  // （mouseupの ROOT.contains() で弾かれる）。注釈UI自身の除外は textNodes / isRvChrome /
  // isRvNode が別に持っているので、ここは body でよい
  ROOT = document.body;
  var collisions = rvCollisions();
  if(collisions.length){
    console.warn("[rv] レビュー注釈レイヤーを起動できません。このページの要素と名前が衝突しています: " +
      collisions.join(", ") + "。衝突している要素のid/classを変更してから、ページを開き直してください。");
    showCollisionBanner(collisions);
    return;
  }
  if(document.querySelector("iframe"))
    console.info("[rv] iframe内の選択・クリックは親ページのレビュー層では取得できません。iframe要素自体への枠コメントは可能です");
  injectCSS();
  buildDOM();
  pop = document.getElementById("rvpop");
  load();
  applyResolved();
  bindEvents();
  bindPopDrag();
  // scrollは要素上ではbubbleしないためcaptureで拾う。内側スクロールも同じ1本で追従する。
  document.addEventListener("scroll", scheduleLayout, true);
  window.addEventListener("scroll", scheduleLayout, {passive:true});
  // 遅延画像など、window.load後に完了するリソースでも枠を引き直す。
  document.addEventListener("load", scheduleLayout, true);
  window.addEventListener("resize", onResize);
  window.addEventListener("load", onResize);
  // 前回選んだフォルダの許可が生きていれば引き継ぐ。切れていたらダウンロードへ戻すだけで、
  // ここでは聞き直さない（読み込みのたびに許可ダイアログが出るのを避ける）
  if(dirPickerAvailable()) dirIfAllowed().then(setImageDir);
  console.info("[rv] レビュー注釈レイヤー v" + RV_VERSION + " / 画像の保存先フォルダ: " +
    (dirPickerAvailable() ? "選べる" : "このブラウザでは使えない（ダウンロードへ落ちる）"));
  // 初めて開いた人にだけ手順を出す。2回目以降・スキップ済みなら何も足さない
  if(!guideSeen()) guideStart();
  render();
}

if(document.readyState === "loading"){
  document.addEventListener("DOMContentLoaded", init);
}else{
  init();
}
})();
