# msesalesinoue — AIオフィス資産の管理リポジトリ

MSEチームのAIオフィス（Claudeスキル・GASアプリ・Googleスプレッドシート）が
**どこに何があり、何が何を参照しているか** を管理するための単一情報源。

## なぜこれが必要か

2026-09-10 時点の棚卸しで、以下が判明した：

- 資産（スキル28件・GAS9件・スプレッドシート多数）が**ひとつもバージョン管理下にない**
- マイドライブ直下に**250件超**が平置きされ、うち「無題のスプレッドシート」だけで15件以上
- 参照先の1つ（【井上】個人チェックシート2026）は**3ヶ月更新されていない**が、誰も気づいていなかった
- 一方で**スキルのID参照は概ねできていた**。特に `alert-overdue-mse` はSFレポートIDを月別8ヶ月分、
  SlackメンバーIDまで保持しており、これが全スキルの手本になる。問題は参照方式ではなく、
  **その情報が各スキルの中に閉じていて横断で見えないこと**だった

詳細 → [`docs/audit-2026-09-10.md`](docs/audit-2026-09-10.md)

## 構成

| パス | 内容 |
|---|---|
| [`registry/data-sources.yaml`](registry/data-sources.yaml) | データソース台帳（17件）。すべての参照はここの `key` を経由する |
| [`registry/skills.yaml`](registry/skills.yaml) | スキル台帳（28件）。各スキルが何を読むか、参照方式が安全か |
| [`registry/apps.yaml`](registry/apps.yaml) | アプリ／GAS台帳（9件） |
| [`docs/gas-backup-runbook.md`](docs/gas-backup-runbook.md) | GASソースをGit管理下に置く手順（ローカル実行） |
| [`apps/`](apps/) | GASソースの置き場。取り込み待ち |
| [`docs/naming-and-placement.md`](docs/naming-and-placement.md) | フォルダ体系・命名規則・新規作成時の手順 |
| [`docs/audit-2026-09-10.md`](docs/audit-2026-09-10.md) | 棚卸しの生データと所見 |
| [`docs/chorei-board-audit-2026-09-11.md`](docs/chorei-board-audit-2026-09-11.md) | 朝礼ボードの集計不具合の調査。実データ検算つき |

## 使い方

**データを参照するとき** — ファイル名で探さない。`registry/data-sources.yaml` から `key` を引き、
その `id` を使う。台帳に無ければ、まず台帳に登録する。

**新しく作るとき** — [`docs/naming-and-placement.md`](docs/naming-and-placement.md) の手順に従う。

**壊れたとき** — `registry/skills.yaml` の `reads` から逆引きすれば、
どのデータソースの変更が原因かが1分で分かる。

## 未着手の課題

台帳を作っただけでは直らないもの。優先順：

0. **朝礼ボードの集計が実態と合っていない** — 案件テーブルにパイプラインの2割しか入っておらず、
   担当者マスタ未登録の3名（吉牟田・小菅・重松）の数字が全部落ちている。
   調査結果と修正順 → [`docs/chorei-board-audit-2026-09-11.md`](docs/chorei-board-audit-2026-09-11.md)。
   コードを直すには朝礼ボードのGASソースが要る（同ドキュメント末尾の手順、5分）
1. **GASソースの Git 取り込み** — 現状バックアップ皆無で、消えたら復旧不能。
   Drive API では取得できずリモートから実行できないため、
   [`docs/gas-backup-runbook.md`](docs/gas-backup-runbook.md) をローカルで実行する（10〜15分）。
   朝礼ボードはコンテナバインド型のため `apps.yaml` にIDが無く、別途取得が必要
2. **SFレポートID 2027-01〜04 の追加** — `alert-overdue-mse` が持つ月別表は2026-12までしかない。
   2026年内に埋めないと年明けに期日超過アラートが動かない
3. **`mse-weekly-kpi-recovery` に業績レポートのIDを持たせる** — 唯一残ったID欠落
4. **check-sf-sheet-consistency 系3スキルのデータソース表を台帳参照に一本化** — いま3重複
5. **マイドライブ直下250件の分類** — 重複判定と削除は所有者判断が必要
6. **【井上】個人チェックシート2026 の鮮度確認** — 突合の入力として妥当か
7. **用途不明GAS3件の判断** — 「無題のプロジェクト」。命名するか削除するか
8. **calendar-add-v2 / makeshop-design-guidelines の廃止判断** — 後継と併存している
