<#
.SYNOPSIS
  帳票アプリがGoogle Driveに出力したPDFを、社内ファイルサーバーの共有フォルダへコピーする。

.DESCRIPTION
  GASはGoogleのクラウド上で動くため、\\gmoms-files01\... のようなSMB共有へ直接書き込めない。
  そこで Google ドライブ デスクトップ でマウントしたDriveフォルダを起点に、
  このスクリプト（Windowsタスクスケジューラで定期実行）が共有フォルダへ片方向コピーする。

  片方向・追加のみ。コピー先のファイルは決して削除・上書きしない（/MIR や /PURGE は使わない）。

.EXAMPLE
  .\sync-chohyo-to-fileserver.ps1 -WhatIf
  .\sync-chohyo-to-fileserver.ps1
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    # Driveデスクトップ上の「MSE帳票」フォルダ。ドライブ文字は環境で変わるので要確認。
    [string]$Source = 'G:\マイドライブ\MSE帳票',

    [string]$Destination = '\\gmoms-files01\personal\usr7000753\publish\顧客別',

    [string]$LogDir = "$env:LOCALAPPDATA\mse-chohyo-sync"
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Source)) {
    throw "コピー元が見つかりません: $Source `nGoogle ドライブ デスクトップが起動しているか、パスが正しいか確認してください。"
}

if (-not (Test-Path -LiteralPath $Destination)) {
    throw "コピー先に到達できません: $Destination `nVPN接続とファイルサーバーへのアクセス権を確認してください。"
}

if (-not (Test-Path -LiteralPath $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}
$log = Join-Path $LogDir ("sync_{0}.log" -f (Get-Date -Format 'yyyyMM'))

# /E   空フォルダも含めてサブフォルダごとコピー
# /XO  コピー先の方が新しければ触らない（上書き事故の防止）
# /XX  コピー先にしかないファイルは対象外＝消さない
# /FFT ファイルサーバーとの2秒未満のタイムスタンプ差を無視
$robocopyArgs = @(
    $Source, $Destination, '*.pdf',
    '/E', '/XO', '/XX', '/FFT',
    '/R:2', '/W:5',
    '/NP', '/NFL', '/NDL',
    "/LOG+:$log", '/TEE'
)

if ($PSCmdlet.ShouldProcess($Destination, "robocopy from $Source")) {
    & robocopy.exe @robocopyArgs
    $code = $LASTEXITCODE

    # robocopyは 0-7 が正常（8以上が失敗）。PowerShell的には0を返す必要がある。
    if ($code -ge 8) {
        Write-Error "robocopy が失敗しました (exit $code)。ログ: $log"
        exit 1
    }
    Write-Host "同期完了 (robocopy exit $code)。ログ: $log"
    exit 0
}
