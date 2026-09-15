# 帳票PDFをファイルサーバーへ自動保存する

## なぜ直接保存できないか

帳票アプリ（GAS）は **Googleのクラウド上で実行される**。社内LANの外にいるため、
`\\gmoms-files01\personal\usr7000753\publish\顧客別` のようなSMB共有には到達できない。
GAS側をどう改修しても不可能で、UNCパスを扱うAPI自体が存在しない。

そこで **Drive に出力 → 井上さんのPCが共有フォルダへコピー** の2段構えにする。

```
帳票アプリ(GAS) ──> Drive「MSE帳票」 ──> [PC] Driveデスクトップ ──> \\gmoms-files01\...\顧客別
      (既存)          (既存・出力先)        (ここを新設)
```

コピーは **片方向・追加のみ**。共有フォルダ側のファイルを消したり古い版で上書きしたりはしない
（`robocopy /MIR` は使わない）。

## セットアップ（井上さんのPCで一度だけ・15分）

### 1. Google ドライブ デスクトップ を入れる

https://www.google.com/drive/download/ から導入し、`inoue.kosuke@makeshop.co.jp` でログイン。
マイドライブが `G:` としてマウントされる（ドライブ文字は環境による）。

エクスプローラで **「MSE帳票」フォルダを右クリック →「オフラインで使用可能にする」**。
これをやらないとファイルの実体がPCに落ちず、コピーが空振りする。

### 2. スクリプトを配置してパスを確認

`scripts/sync-chohyo-to-fileserver.ps1` を任意の場所（例 `C:\tools\`）に置く。
先頭の `$Source` が実際のフォルダと一致しているか確認する。既定値は `G:\マイドライブ\MSE帳票`。

### 3. 空打ちして確認

```powershell
cd C:\tools
.\sync-chohyo-to-fileserver.ps1 -WhatIf   # 何もコピーせず、到達性だけ確認
.\sync-chohyo-to-fileserver.ps1           # 実行
```

エラーが出たら、コピー元（Driveデスクトップ起動中か）とコピー先（VPN・アクセス権）を確認する。

### 4. タスクスケジューラに登録（15分ごと）

管理者権限のPowerShellで：

```powershell
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
             -Argument '-NoProfile -ExecutionPolicy Bypass -File "C:\tools\sync-chohyo-to-fileserver.ps1"'
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
             -RepetitionInterval (New-TimeSpan -Minutes 15)
Register-ScheduledTask -TaskName 'MSE帳票 → ファイルサーバー同期' `
             -Action $action -Trigger $trigger -Description 'Drive「MSE帳票」の新規PDFを共有フォルダへコピー'
```

ログは `%LOCALAPPDATA%\mse-chohyo-sync\sync_YYYYMM.log` に月別で溜まる。

## 制約

- **PCの電源が入っていて、VPNが繋がっている間だけ動く。** 外出中に発行した帳票は、
  次にPCがオンラインになったときにまとめてコピーされる。
- コピー先は井上さんの個人領域（`personal\usr7000753`）配下。チーム全員が書き込む共有領域が
  必要なら、情シスに部門共有フォルダを申請したほうがよい。
- 帳票アプリ側の出力先が変わったら `$Source` も直す必要がある。
