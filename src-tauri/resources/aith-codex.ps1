# Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
# aith-codex: 지금 폴더의 Codex에게 지시를 보내고, 끝나면 답변과 바뀐 파일만 짧게 출력한다.
# 폰(Claude 원격 제어)에서 "@co ..."로 보낸 지시를 Claude가 이 명령으로 넘긴다.
# 이 폴더의 마지막 Codex 대화(허브 Codex 탭과 같은 대화)에 이어서 보내고, 없으면 새 대화로 시작한다.
# 지시는 인자 또는 stdin(여러 줄이면 stdin 권장):  aith-codex <<'EOF' ... EOF
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)

$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

$prompt = if ($Rest -and $Rest.Count -gt 0) { $Rest -join ' ' } else { [Console]::In.ReadToEnd() }
$prompt = $prompt.Trim()
if (-not $prompt) {
    Write-Output "사용법: aith-codex <지시>   (또는 stdin으로 지시)"
    exit 1
}

# 허브에 이 폴더의 Codex 탭이 열려 있으면 그 탭으로 보낸다
# (같은 대화를 두 곳에서 동시에 건드리지 않고, PC 허브 화면에도 진행이 보이게). 탭이 없거나 허브가 꺼져 있으면 직접 실행.
$hub = Join-Path $PSScriptRoot "aith-hub.ps1"
if ((Test-Path -LiteralPath $hub) -and -not $env:AITH_CODEX_DIRECT) {
    $out = & $hub codex $prompt
    $code = $LASTEXITCODE
    if ($code -ne 2 -and $code -ne 3) {
        $out | ForEach-Object { Write-Output $_ }
        exit $code
    }
}

# 권한: 허브가 원격 제어를 띄울 때 AITH_FULL=1(전체 권한 설정)을 넘긴다
$perm = if ($env:AITH_FULL -eq "1") { "--dangerously-bypass-approvals-and-sandbox" } else { "-c sandbox_mode=workspace-write -c approval_policy=never" }

function Run-Codex([bool]$resume) {
    $sub = if ($resume) { "exec resume --last" } else { "exec" }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "cmd.exe"
    $psi.Arguments = "/d /c codex $sub --json --skip-git-repo-check $perm -"
    $psi.WorkingDirectory = (Get-Location).Path
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = $utf8
    $psi.StandardErrorEncoding = $utf8
    $psi.CreateNoWindow = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $errTask = $p.StandardError.ReadToEndAsync()
    $p.StandardInput.Write($prompt)
    $p.StandardInput.Close()

    $r = @{ started = $false; answer = ""; files = [ordered]@{}; cmds = 0; failed = @(); errors = @() }
    while ($null -ne ($line = $p.StandardOutput.ReadLine())) {
        if (-not $line.StartsWith("{")) { continue }
        try { $ev = $line | ConvertFrom-Json } catch { continue }
        switch ($ev.type) {
            "thread.started" { $r.started = $true }
            "turn.failed" { if ($ev.error.message) { $r.errors += $ev.error.message } }
            "error" { if ($ev.message) { $r.errors += $ev.message } }
            "item.completed" {
                $it = $ev.item
                switch ($it.type) {
                    "agent_message" { $r.answer = $it.text }
                    "command_execution" {
                        $r.cmds += 1
                        if ($it.exit_code -and $it.exit_code -ne 0) { $r.failed += $it.command }
                    }
                    "file_change" { foreach ($c in $it.changes) { $r.files[$c.path] = $c.kind } }
                }
            }
        }
    }
    $p.WaitForExit()
    $r.code = $p.ExitCode
    $r.stderr = $errTask.Result
    return $r
}

$r = Run-Codex $true
# 이 폴더에 이어갈 Codex 대화가 없으면 새로 시작
if (-not $r.started -and $r.code -ne 0) { $r = Run-Codex $false }

$cwd = (Get-Location).Path.TrimEnd('\') + '\'
Write-Output "[Codex 답변]"
Write-Output ($(if ($r.answer) { $r.answer } else { "(답변 없음)" }))
if ($r.files.Count -gt 0) {
    Write-Output ""
    Write-Output "[바뀐 파일]"
    foreach ($k in $r.files.Keys) {
        $rel = if ($k.StartsWith($cwd, [StringComparison]::OrdinalIgnoreCase)) { $k.Substring($cwd.Length) } else { $k }
        Write-Output ("- " + $r.files[$k] + " " + $rel)
    }
}
if ($r.cmds -gt 0) {
    Write-Output ""
    Write-Output ("[실행한 명령] " + $r.cmds + "개" + $(if ($r.failed.Count) { ", 실패 " + $r.failed.Count + "개" } else { "" }))
}
if ($r.errors.Count -gt 0) {
    Write-Output ""
    Write-Output "[오류]"
    $r.errors | Select-Object -Unique | ForEach-Object { Write-Output ("- " + $_) }
    if (($r.errors -join ' ') -match 'usage limit|rate limit|quota|한도') {
        Write-Output "- Codex 한도가 소진된 것 같아요. PC의 허브 계정 패널에서 다른 Codex 계정으로 전환하세요."
    }
    exit 1
}
if (-not $r.started) {
    Write-Output ""
    Write-Output "[오류] Codex를 실행하지 못했어요."
    if ($r.stderr) { Write-Output ($r.stderr.Trim() -split "`n" | Select-Object -Last 5) }
    exit 1
}
exit $r.code
