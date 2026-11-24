# Copyright (c) 2026 Backhacandy. Licensed under AGPL-3.0-or-later.
# aith-open: 프로그램·파일·폴더·주소를 허브와 분리된 프로세스로 연다.
# 에이전트가 그냥 실행하면(Start-Process, start, &) 턴이 끝날 때 허브가 프로세스 트리를 정리하면서 함께 꺼진다.
# WMI(Win32_Process.Create)로 만들면 부모가 WmiPrvSE라 트리·작업 객체 밖에서 계속 실행된다.
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)

$ErrorActionPreference = "Stop"
if (-not $Rest -or $Rest.Count -eq 0) {
    Write-Output "사용법: aith-open <프로그램 | 파일 | 폴더 | 주소> [인자...]"
    exit 1
}

function Q([string]$s) {
    if ($s -match '[\s"]') { return '"' + ($s -replace '"', '\"') + '"' }
    return $s
}

$target = $Rest[0]
$tail = @($Rest | Select-Object -Skip 1)
$cwd = (Get-Location).Path
$exe = $null
$cl = $null

if (Test-Path -LiteralPath $target -PathType Leaf) {
    $full = (Resolve-Path -LiteralPath $target).Path
    if ($full -match '\.(exe|com)$') { $exe = $full }
    elseif ($full -match '\.(bat|cmd)$') { $cl = 'cmd.exe /c ' + (Q $full) + ' ' + (($tail | ForEach-Object { Q $_ }) -join ' ') }
    else { $cl = 'explorer.exe ' + (Q $full) }
}
elseif (Test-Path -LiteralPath $target -PathType Container) {
    $cl = 'explorer.exe ' + (Q (Resolve-Path -LiteralPath $target).Path)
}
elseif ($target -match '^[a-zA-Z][a-zA-Z0-9+.-]*://') {
    $cl = 'explorer.exe ' + (Q $target)
}
else {
    $cmd = Get-Command $target -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd -and $cmd.Source) { $exe = $cmd.Source }
    else {
        Write-Output "찾을 수 없어요: $target (전체 경로를 주세요)"
        exit 1
    }
}

# 콘솔 프로그램(PE Subsystem 3)인가 — WMI로 띄운 콘솔은 보이는 cmd 창이 생겨 켜졌다 꺼졌다 한다
function IsConsoleExe([string]$path) {
    try {
        $fs = [IO.File]::OpenRead($path)
        try {
            $br = New-Object IO.BinaryReader($fs)
            $fs.Position = 0x3C; $pe = $br.ReadInt32()
            $fs.Position = $pe + 0x5C  # PE 서명(4) + COFF 헤더(20) + 선택 헤더 안 Subsystem(68)
            return $br.ReadUInt16() -eq 3
        } finally { $fs.Close() }
    } catch { return $false }
}

$hide = $false
if ($exe) {
    $cl = ((@($exe) + $tail) | ForEach-Object { Q $_ }) -join ' '
    $hide = IsConsoleExe $exe
}
elseif ($cl -like 'cmd.exe *') { $hide = $true }

$wa = @{ CommandLine = $cl.Trim(); CurrentDirectory = $cwd }
# 창 없이: 서버·테스트 스크립트처럼 콘솔로 도는 것만. GUI(Unity·브라우저·탐색기)는 그대로 보이게
if ($hide) { $wa.ProcessStartupInformation = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 } }
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments $wa
if ($r.ReturnValue -ne 0) {
    Write-Output "실행 실패(코드 $($r.ReturnValue)): $cl"
    exit 1
}
$how = if ($hide) { '창 없이, 허브와 분리됨' } else { '허브와 분리됨' }
Write-Output "실행함 (pid $($r.ProcessId), $how): $cl"
