# GASソースをGit管理下に置く手順（ローカル実行）

## なぜこの作業が必要か

GASプロジェクト9件のソースコードは現在 **Drive上にしか存在しない**。
誤って削除・上書きしても復旧手段がない。特に `帳票アプリ` は見積書・注文書・検収書・
納品書・請書・但書のPDF生成を担っており、失うと業務が止まる。

## なぜこのリポジトリのセッションから実行できないか

- GASのソースはDrive APIでは取得できない（Apps Script API専用のスコープが必要）。
  実際に `帳票アプリ` のDLを試行 → `Internal error` で取得不可を確認済み
- clasp が未インストールで、Googleアカウントの対話ログインもリモート環境では通らない

したがって **井上さんのローカルPCで一度だけ** 以下を実行する必要がある。所要10〜15分。

## 手順

### 1. 事前準備（初回のみ）

```bash
npm install -g @google/clasp
clasp login          # ブラウザが開く。inoue.kosuke@makeshop.co.jp でログイン
```

Apps Script APIを有効化しておく（未設定なら clasp が案内する）：
https://script.google.com/home/usersettings → 「Google Apps Script API」をオン

### 2. リポジトリを取得

```bash
git clone https://github.com/inouekosuke-del/msesalesinoue.git
cd msesalesinoue
git checkout claude/lucid-edison-kexbgj
```

### 3. 各プロジェクトを clone する

`registry/apps.yaml` の `id` をそのまま使う。

`shodan_bunseki_gas`（mse_商談分析_2026 付随GAS）は田村さん所有だが、
**井上さんは朝バッチの実行アカウント＝編集権限を持っている**ため clone は通るはず。
権限エラーが出たときだけ田村さんに依頼する。

```bash
mkdir -p apps && cd apps

clasp clone 1KMAAiIH13i2Hiq8Kuz8O_liIlmSeBjXgvvg2UhYSGVhPYmvkyP0IqehP --rootDir ./chohyo-app
clasp clone 1lpIoY59ECGV5Lkt0UzAIS2LZkjKdJ4RwfRqOWrYGImCm85Bq-aGd6ppy --rootDir ./sales-report
clasp clone 1Qo-OD4EDPuXJDUXcWuE4pOAtoXr3J9WbzSpLSJXZZu_8bpjzhRC4vWTK --rootDir ./gyoseki-bunseki-mse
clasp clone 1j2vtr_YoRgBb_CcHOAG1NrFn_aWxzgU0zLyeQVvBpBEq0R_2Af81ohiD --rootDir ./cxo

# 用途不明の3件。中身を見て、命名して残すか削除するかを判断する
clasp clone 1zYdN2L4vL7hjz4mSb2aEL0qdbgCo03R47eRVGCDtT_nQks5dCUB1HG9k --rootDir ./untitled-1
clasp clone 1DyhOxdq3E2ifriasZk1iNRdcsbcT1kujYNL45TzpBAeU_fcaMBzgv6RY --rootDir ./untitled-2
clasp clone 15CoiQFI9HHxK5WZJv6ejMrPAK1hmBI0C37UiKsYvPFlGXOnHjyrmwdIb --rootDir ./untitled-3

# 田村さん所有だが編集権限があるので通るはず。最優先（改修待ちのため）
clasp clone 1XXk_FClsvJgJs0gRQCX50h82sLf7HNORTD2thrC_XdQxnb3BOdvR_g5p --rootDir ./mse-shodan-bunseki
```

> これ1件だけ先に取り込みたい場合は
> [`mse-shodan-kijun-fix.md` の「手順0」](mse-shodan-kijun-fix.md#手順0先に1回だけ井上さんのローカルpcソースをgitに入れる) を参照。

### 4. 認証情報が混入していないか確認してからコミット

`.clasp.json` にはスクリプトIDのみでトークンは入らないが、
コード中にAPIキーやSalesforceの認証情報がベタ書きされていないか必ず確認する。

```bash
cd ..
grep -rniE "(password|secret|api[_-]?key|token|Bearer )" apps/ | grep -v node_modules
```

該当があれば、その値を PropertiesService に移してからコミットすること。

```bash
git add apps/
git commit -m "GASプロジェクトのソースをGit管理下に取り込み"
git push -u origin claude/lucid-edison-kexbgj
```

### 5. 取り込み後

`registry/apps.yaml` の各エントリの `source_backed_up` を `true` に更新する。
用途不明の3件は、中身を見て `role` を埋めるか、Driveから削除して台帳からも消す。

## 以後の運用

GASを改修したら `clasp pull` して差分をコミットする。
Driveの版履歴と違い、Gitなら「いつ・なぜ変えたか」がコミットメッセージに残る。
