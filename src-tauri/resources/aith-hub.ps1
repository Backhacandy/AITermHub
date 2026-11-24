# Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
# aith-hub: 폰(원격 Claude 세션)에서 허브에 요청한다. 허브가 켜져 있어야 한다.
#   aith-hub status            허브 탭·자동 진행·한도·폰 연결 상태
#   aith-hub pair <<'EOF'      지금 폴더의 팀 탭(여러 에이전트)에 지시 → 끝나면 결과
#   ...                        지시는 인자 또는 stdin
# 요청은 app_data/rc/inbox에 파일로 쓰고, 허브가 outbox에 답을 쓴다(포트를 열지 않음).
param([Parameter(Position = 0)][string]$Cmd = "", [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)

$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

$root = Join-Path (Split-Path $PSScriptRoot -Parent) "rc"

function Invoke-Hub([string]$kind, [string]$text, [int]$waitMinutes) {
    $inbox = Join-Path $root "inbox"
    $outbox = Join-Path $root "outbox"
    New-Item -ItemType Directory -Force -Path $inbox, $outbox | Out-Null
    $id = [guid]::NewGuid().ToString("N")
    $req = @{ id = $id; kind = $kind; cwd = (Get-Location).Path; text = $text } | ConvertTo-Json -Compress
    $tmp = Join-Path $inbox "$id.tmp"
    [IO.File]::WriteAllText($tmp, $req, $utf8)
    Move-Item -LiteralPath $tmp -Destination (Join-Path $inbox "$id.json")

    $ackFile = Join-Path $outbox "$id.ack"
    $txtFile = Join-Path $outbox "$id.txt"
    $end = (Get-Date).AddSeconds(15)
    while (-not (Test-Path -LiteralPath $ackFile)) {
        if ((Get-Date) -gt $end) {
            Remove-Item -LiteralPath (Join-Path $inbox "$id.json") -ErrorAction SilentlyContinue
            return @{ ok = $false; reason = "off" }
        }
        Start-Sleep -Milliseconds 400
    }
    $ack = [IO.File]::ReadAllText($ackFile, $utf8).Trim()
    Remove-Item -LiteralPath $ackFile -ErrorAction SilentlyContinue
    if ($ack -ne "ok") { return @{ ok = $false; reason = $ack } }

    $end = (Get-Date).AddMinutes($waitMinutes)
    while (-not (Test-Path -LiteralPath $txtFile)) {
        if ((Get-Date) -gt $end) { return @{ ok = $true; text = "허브가 아직 작업 중이에요(대기 시간 초과). 끝나면 PC·폰 알림이 와요. 나중에 @상태로 확인하세요." } }
        Start-Sleep -Seconds 1
    }
    $out = [IO.File]::ReadAllText($txtFile, $utf8)
    Remove-Item -LiteralPath $txtFile -ErrorAction SilentlyContinue
    return @{ ok = $true; text = $out }
}

$text = if ($Rest -and $Rest.Count -gt 0) { $Rest -join ' ' } elseif ($Cmd -ne "status" -and [Console]::IsInputRedirected) { [Console]::In.ReadToEnd() } else { "" }
$text = $text.Trim()

switch ($Cmd) {
    "status" { $r = Invoke-Hub "status" "" 1 }
    "pair" {
        if (-not $text) { Write-Output "사용법: aith-hub pair <지시>"; exit 1 }
        $r = Invoke-Hub "pair" $text 180
    }
    "codex" {
        # aith-codex가 먼저 허브의 Codex 탭으로 보내 볼 때 쓴다(탭이 없으면 none:no-tab)
        $r = Invoke-Hub "codex" $text 180
        if (-not $r.ok) { Write-Output "NONE:$($r.reason)"; exit 3 }
    }
    default {
        Write-Output "사용법: aith-hub status | aith-hub pair <지시>"
        exit 1
    }
}

if (-not $r.ok) {
    if ($r.reason -eq "off") { Write-Output "[허브] PC의 AITermHub가 꺼져 있거나 응답이 없어요." }
    else { Write-Output "[허브] 요청을 처리할 수 없어요: $($r.reason)" }
    exit 2
}
Write-Output $r.text
