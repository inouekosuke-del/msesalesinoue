# MSE朝礼ボード ｜ まとめビュー高速化モジュール

`SummaryFast.gs` は **既存コードに手を入れずに追加できる** 1ファイル。
「朝礼・終礼のまとめ」が「読み込み中...」のまま出ない件に対する実装。

## なぜ速くなるか

| | 改修前（推定） | このモジュール |
|---|---|---|
| 案件明細の読み込み | 全件×全列を都度 `getDataRange()` ≒ 9万セル | 必要3列だけ1回 ≒ 1.4万セル |
| dealId の引き当て | ループ内で都度検索（O(n×m)） | 1パスで索引化（O(n+m)） |
| 報告シートの読み込み | 全行 | 日付列だけ先読み → 一致行のみ本読み |
| 2回目以降 | 毎回同じ処理 | `CacheService` で 10分ヒット |
| カレンダー | メンバーごとに呼ぶ（1回0.5〜2秒） | **呼ばない** |

## 前提を置かない作り

タブ名もソースも手元に無い状態で書いているため、次の方針にしてある。

- **シートはヘッダー行の並びで特定**する（`CB_SHEET_SIG`）。タブ名が違っても動く。
  一度特定したらスクリプトプロパティに覚え、2回目以降は全タブ走査をしない
- **列は必ずヘッダー名から引く**。列順が変わっても壊れない
- 判定できないときは黙って0件にせず、どのシートを特定できなかったかを例外に出す

## 入れ方

1. Apps Scriptエディタで新規スクリプトファイル `SummaryFast` を作り、`SummaryFast.gs` を丸ごと貼る
2. `CB_benchSummary()` を実行。実行ログに `cold=◯◯ms / warm=◯◯ms(cached=true)` が出れば配線OK
   - ここで「シートを特定できません」が出たら、そのシートのヘッダー行を教えてもらえれば `CB_SHEET_SIG` を直す
3. まとめビューのフロントの呼び出し先を差し替える

```javascript
google.script.run
  .withSuccessHandler(renderSummary)
  .withFailureHandler(function(e){                    // 今は失敗しても「読み込み中...」のまま
    document.getElementById('summaryBody').textContent = '読み込みエラー: ' + e.message;
  })
  .CB_getSummaryFast({ kind: kindSelect.value, team: teamSelect.value, date: dateInput.value });
```

4. 朝礼・終礼の**保存処理の最後**に1行足す（キャッシュが古いままになるのを防ぐ）

```javascript
CB_invalidateSummary({ date: rec.date, kind: rec.kind });
```

## 返ってくる形

```
{ ok, date, kind, team, cached, elapsedMs,
  blocks: [ { memberId, name, slackId, postedAt, juchuFc, keijoFc, goal, plan, help,
              itemCount, items: [ { company, title, juchuDate, amount,
                                    probFrom, probTo, acts, note } ] } ],
  missing: [ { memberId, name, slackId } ] }      // alert=TRUE なのに未提出の人
}
```

`blocks` はメンバー台帳の並び順。`missing` は未提出アラートにそのまま使える。

## 検証済みのこと / まだのこと

**検証済み** — 実データ（MSE朝礼ボード_データ のエクスポート）を流したスタブで、
シート4種の自動特定、日付での絞り込み、チーム絞り込み（MSE＝mse+admin／サクセス＝success）、
`dealId` → 商談名・受注日 の引き当て（5/5一致）、キャッシュのヒット、
提出ゼロの日に未提出者が出ること、まで確認した。

**未検証** — 実際のGAS上での所要時間。`CB_benchSummary()` の数字が正。
案件明細4,720行での挙動も実機確認が要る（手元のエクスポートは先頭132行で切れている）。

## これでも直らない場合に見るところ

まとめが依然遅いなら、遅いのは集計ではなくフロント側かカレンダーである可能性が高い。
`CB_benchSummary()` の `cold` が1秒未満なのに画面が遅いなら、既存の呼び出しが
まだ古い関数を向いているか、`google.script.run` を直列で何本も叩いている。

朝礼がSlackに流れない件は**別問題**（`docs/incident-2026-09-15-chorei-post.md`）。
一次点検用に `CB_listTriggers()` を同梱してあるので、実行ログでAM系トリガーの生死を見てほしい。
