# 参加する

個人で管理しているものなので、レビューは早くない。それでも歓迎する。

## 先に知っておいてほしいこと

- **`rv-layer.js` は1ファイルのまま**にしている。ビルド工程を持たないのが導入の条件
  （`<script src>` を1行足すだけ）なので、モジュール分割やバンドラの導入は入れられない
- **外部への依存を足さない**。CDN・外部フォント・外部画像・npmの実行時依存はゼロを保つ
- **ES5相当の構文**で書く。古いブラウザでも本文へのコメントだけは動く状態を保ちたい
- 対象ページのマークアップとスタイルに触らない。予約している名前は
  [`prompts/generate-html.md`](prompts/generate-html.md) にある

## バグ報告

再現するHTMLを添えてほしい。`tests/fixtures/` にある形が参考になる。
セキュリティに関わるものは [SECURITY.md](SECURITY.md) の手順で（公開issueにしない）。

## プルリクエスト

1. 何を直すのかを先にissueで書いてほしい。作ってから方向が違うと分かるのは互いに損
2. `npm install` と `npx playwright install chromium` の後に `npm test` を通し、結果をPRに書く
3. 自動テストを補うため、[`tests/manual-checklist.md`](tests/manual-checklist.md) の関係する項目を
   実機で通し、**どの項目を確認したか**をPRに書く
4. 「黙って壊れる」経路（エラーを出さずにデータが失われる・取り違えられる）を直すものは
   優先して見る。その場合、修正前に壊れることを再現した手順も書いてほしい
5. `rv-layer.js` を変えたら、ファイル冒頭の版数コメント、`RV_VERSION`、`package.json` の
   `version`、`CHANGELOG.md` 先頭の4箇所を更新する

## 仕様を変える提案

`window.__rvResolved` の規約（[`specs/resolved-contract.md`](specs/resolved-contract.md)）と
書き出しzipの構成（[`specs/review-package.md`](specs/review-package.md)）は、
AI側の実装が読む契約なので、変えると既に書き出されたzipや埋め込み済みのタグが合わなくなる。
変える提案は、既存のものがどうなるかまで書いてほしい。

## ライセンス

MIT。PRを送ることで、同じライセンスで配布されることに同意したものとする。
