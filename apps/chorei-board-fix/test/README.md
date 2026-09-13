# ローカル回帰テスト

GASのスタブを噛ませて、`ChoreiFix.gs` / `ChoreiAgg.gs` を Node で実行する。
本番のスプレッドシートに触る前に手元で確認するためのもの。

## データの用意

案件データは会社名・金額を含むのでGitには入れていない。実行前に自分で書き出す。

**必ず xlsx でエクスポートすること。**
Google Drive の `read_file_content` のような「自然文表現」は
大きなシートを黙って先頭だけに切り詰める（案件シートは4,720行中129行しか返らなかった）。
件数を数える検証には使えない。

```bash
# MSE朝礼ボード_データ を ファイル > ダウンロード > Microsoft Excel (.xlsx) で保存し、
# board.xlsx として test/ に置いてから
cd apps/chorei-board-fix/test
pip install openpyxl
python3 export.py        # 各シートを sheets/<シート名>.csv に書き出す
for f in ChoreiFix ChoreiAgg ChoreiPick ChoreiOrder; do cp ../$f.gs $f.js; done
node harness.js
```

`harness.js` はCSV上の `YYYY-MM-DD HH:MM:SS` を **Dateオブジェクトに戻してから**
スクリプトに渡す。実際のGASの `getValues()` と同じ挙動にするため。
月キーが日付セルになっている問題は、これをやらないと再現しない。

## 確認すること

- `修復_ドライラン()` の直後に「ドライラン中の書き込み: 0」
- 月キーの修復が **`setNumberFormat('@')` 2回 + `setValues` 2回**で済んでいること
  （セル単位だと9,440回になり、GASの実行時間を使い切る）
- 回帰テストの「再実行で残る書き換え: 0」（冪等）
- 集計の「担当不明: 0 / 未分類の進捗: {}」

2026-09-13 のデータでの実測値:

| | 修復前 | 修復後 |
|---|---:|---:|
| 日付セルになっている月キー | 9,440 | 0 |
| 案件の `ownerId` 空 | 134行 / ￥119,059,295 | 0 |
| 日次履歴の `memberId` 空 | 213行 | 0 |
| 集計で担当を特定できない案件 | 6件 | 0 |
| `STAGE_CATEGORY` に無い進捗 | 納品済 3件 | 0 |
