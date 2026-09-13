# apps/

GASプロジェクトのソース置き場。現時点では空。

取り込み手順は [`../docs/gas-backup-runbook.md`](../docs/gas-backup-runbook.md) を参照。
clasp と Google の対話ログインが必要なため、ローカルPCでの実行が前提。

## mse-shodan-bunseki/

`mse_商談分析_2026` 付随GAS（scriptId `1XXk_FClsvJgJs0gRQCX50h82sLf7HNORTD2thrC_XdQxnb3BOdvR_g5p`）。

| ファイル | 状態 |
|---|---|
| `コード.gs` | **未取得**。コンテナバインドのためDrive経由では取れない。`clasp pull` が必要 |
| `tanto_d2.gs` | 新規。担当_XX を案C（D2単軸）に直す独立スクリプト。コード.gs を編集せずに動く |

`tanto_d2.gs` の仕様と検証値は [`../docs/mse-shodan-kijun-fix.md`](../docs/mse-shodan-kijun-fix.md)。
