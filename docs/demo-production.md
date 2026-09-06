# デモ動画・字幕・スクリーンショットの更新

READMEで公開しているデモ素材を撮り直すための開発者向け手順。
撮影対象は [`demo-page.html`](demo-page.html) で、Akaire本体の利用にこの手順は不要。

## 準備

リポジトリのルートで依存パッケージとChromiumを用意し、ローカルサーバーを起動する。

```sh
npm install
npx playwright install chromium
python3 -m http.server 8765
```

以下のコマンドは、別のターミナルからリポジトリのルートで実行する。

## 動画と字幕

短いデモを録画する。

```sh
node tools/record-demo.mjs ./out
```

全機能版は末尾に `full` を付ける。

```sh
node tools/record-demo.mjs ./out full
```

録画されたWebMは `out/` に出る。字幕はモードに応じて `docs/demo.srt` / `docs/demo.vtt`、
または `docs/demo-full.srt` / `docs/demo-full.vtt` に書き出される。

WebMをREADME用のMP4へ変換する例:

```sh
ffmpeg -i out/<録画ファイル>.webm -vf "scale=1280:800,fps=24" -c:v libx264 \
  -pix_fmt yuv420p -crf 26 -movflags +faststart -an docs/demo.mp4
```

全機能版は出力先を `docs/demo-full.mp4` にする。通常、字幕は映像へ焼き付けない。
映像上部の帯へ字幕を焼き付けた状態で録画するときだけ `RV_BURN_CAP=1` を付ける。

```sh
RV_BURN_CAP=1 node tools/record-demo.mjs ./out
```

## READMEの先頭画像

UIや配色を変えたときは、次のコマンドで `docs/screenshot.png` を更新する。

```sh
node tools/shoot-screenshot.mjs
```

更新後はREADMEを表示し、動画、字幕、画像のリンクと代替テキストが実物に合っていることを確認する。

## 修正確認の画面

`npm run test:mvp` は実サンプルの赤入れ・修正確認・別ブラウザへの持ち越しを検証し、
`/tmp/akaire-mvp-improvements.png` に確認画面を出す。表示を確認してから
`docs/revision-review.png` へコピーすると、READMEの修正確認画面を更新できる。
