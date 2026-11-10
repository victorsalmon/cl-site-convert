#Requires -Version 7.0
<#
.SYNOPSIS
    Verifies the Rust toolchain matches rust-toolchain.toml.

.DESCRIPTION
    Fails closed with an actionable message. The pinned channel and wasm target
    are declared in rust-toolchain.toml, which rustup honours automatically, so
    this script is a verification step — not an installer.

    Exit codes: 0 = toolchain usable, 1 = missing or mismatched.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$toolchainFile = Join-Path $repoRoot 'rust-toolchain.toml'

$problems = [System.Collections.Generic.List[string]]::new()

if (-not (Test-Path $toolchainFile)) {
    $problems.Add('rust-toolchain.toml is missing; the toolchain is unpinned.')
}
else {
    $toml = Get-Content $toolchainFile -Raw
    $channel = if ($toml -match 'channel\s*=\s*"([^"]+)"') { $Matches[1] } else { $null }
    $targets = @()
    if ($toml -match 'targets\s*=\s*\[([^\]]*)\]') {
        $targets = [regex]::Matches($Matches[1], '"([^"]+)"') | ForEach-Object { $_.Groups[1].Value }
    }
}

foreach ($exe in 'cargo', 'rustc', 'rustup') {
    if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) {
        $problems.Add("$exe is not on PATH. Install rustup from https://rustup.rs then re-open the shell.")
    }
}

if ($problems.Count -eq 0) {
    $installed = (& rustc --version) -replace '^rustc\s+', ''
    if ($channel -and ($installed -notlike "$channel*")) {
        $problems.Add("rustc is $installed but rust-toolchain.toml pins $channel. Run: rustup toolchain install $channel")
    }

    $haveTargets = @(& rustup target list --installed 2>$null)
    foreach ($t in $targets) {
        if ($haveTargets -notcontains $t) {
            $problems.Add("target '$t' is not installed. Run: rustup target add $t")
        }
    }
}

if ($problems.Count -gt 0) {
    Write-Host 'TOOLCHAIN: FAIL' -ForegroundColor Red
    $problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}

Write-Host ("TOOLCHAIN: OK  rustc={0}  targets={1}" -f ((& rustc --version) -replace '^rustc\s+', ''), ($targets -join ',')) -ForegroundColor Green
exit 0
