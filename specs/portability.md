# レビューを持ち越す

`<script src="rv-layer.js" data-rv-doc-id="proposal-unique-id"></script>` の任意属性で文書IDを固定できる。英数字で始まる英数字・`.`・`_`・`-`の1〜128文字。有効なIDがない場合は従来のpathname保存。同じ文書の改訂でIDを維持し、別文書へ流用しない。

保存キーは `rv:doc-id:<ID>`。読込優先順はIDキー→現在pathnameキー→旧ファイル名キー。移行元は削除しない。pathnameからの移行成功後は `rv-layer:path-owner:<pathname>` に文書IDを記録し、同じパスを後で別IDへ差し替えても再移行しない。旧ファイル名キーから安定IDへ直接移行する場合も同じ所有権を記録する。移行先のコメントと同時に `migratedFromPath` を保存し、所有権索引の書込に失敗してもこの由来から所有者を復元して二重移行を防ぐ。移行先の保存成功前に旧キーをclaimしない。ID共有は同一ブラウザ・同一オリジンの範囲であり、別環境はファイル移行が必要。`file:` の保存範囲はブラウザ実装に依存する。

バーの「持ち出す」は全コメント、済み／戻した状態、追記、アンカー、appliedRevs、IndexedDB内の全原寸画像をJSON単一ファイルへ保存する。ファイル名は `rv-<slug>-review.json`。HTML自体は含まない。原寸が欠落していれば中止し、サムネイルで黙って代用しない。AI用の「zip」は従来どおり未済み指示＋HTML＋画像であり、移行用JSONとは別。

「読み込む」は元パスと現在の対象ページを明示して確認する。保存先にコメントまたは過去のimportがあれば拒否する（同じファイルの再importも拒否し、戻した状態を巻き戻さない）。両側に非空文書IDがあり異なる場合も拒否。IDなしは確認後に現在のパスへ保存する。古いHTMLの既に適用済みrevは再適用しない。新しいrevは復元されたappliedRevsを基準に適用する。

上限はJSONファイル全体50 MiB（base64分を含む）。入力のformat/schema/構造/フィールド型/コメントID重複/追記ID重複/rev重複/画像名重複/原寸欠落を検証する。未対応schemaと破損ファイルは保存前に拒否する。未知の追加フィールドは保持する。

形式（schema 1）:

```json
{"format":"akaire-review","schema":1,"source":{"path":"/old.html","docId":"proposal-unique-id"},"store":{"docId":"proposal-unique-id","title":"提案","updated":null,"comments":[],"appliedRevs":[]},"images":[ ]}
```

`images`の要素は`{name: コメント画像名, data: 原寸のimage/* base64 data URI}`。コメント構造は現行保存構造をそのまま保持する。

`migratedFromPath` は各ブラウザ内の移行所有権の記録であり、持ち出し対象から除外する。
読み込みファイルに含まれていても移さず、読み込み先に既存の移行情報がある場合だけそれを維持する。

復元にはIndexedDBが必要。画像は新しい一意名で書き込み、transaction完了の成功を確認してからlocalStorageを書き込む。非同期の画像保存中に対象データが変化すれば中止する。途中失敗では新しい画像だけを削除し、既存レビューを上書きしない。IDBとlocalStorageは非atomicのため、ブラウザ終了等で未参照画像が残る可能性はある。成功表示は全保存後のみ。複数タブの同時操作には排他ロックを持たないため、復元中は他タブで編集しない。
