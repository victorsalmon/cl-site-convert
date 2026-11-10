<#
.SYNOPSIS
    The repository gate: lint, typecheck, validate:ir, validate:capabilities,
    validate:seo, validate:plugins, validate:wasm-size, test, check-toolchain,
    cargo fmt, cargo clippy, cargo test.

.DESCRIPTION
    Fail-closed. Every step must genuinely pass for the gate to exit 0.

    The Rust toolchain is a documented, provisionable prerequisite (rust-toolchain.toml
    pins the channel and wasm target). A missing toolchain is therefore a FAIL with
    remediation, never a silent skip — see cl-common ADR 0012.

.PARAMETER RequireCargo
    Deprecated no-op. Cargo is always required; kept so existing invocations do not
    break.

.EXAMPLE
    pnpm gate

.EXAMPLE
    pnpm gate -- -RequireCargo
#>
[CmdletBinding()]
param(
    [switch]$RequireCargo
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

# rustup installs to %USERPROFILE%\.cargo\bin. If that directory exists but is not
# on PATH — a Windows User PATH never refreshed after rustup, which was the state of
# this machine on 2026-11-11 — the toolchain is provisioned but undiscoverable.
# Resolve it HERE, before any step runs: validate:wasm-size shells out to cargo, so
# discovering the toolchain later in the Rust section is too late.
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if ($null -eq (Get-Command 'cargo' -ErrorAction SilentlyContinue) -and (Test-Path (Join-Path $cargoBin 'cargo.exe'))) {
    $env:PATH = "$cargoBin;$env:PATH"
    Write-Host "note: cargo is not on PATH; using rustup's install location $cargoBin" -ForegroundColor Yellow
}

$failures = [System.Collections.Generic.List[string]]::new()
$skips = [System.Collections.Generic.List[string]]::new()

function Write-Header {
    param([string]$Text)
    Write-Host ''
    Write-Host "==> $Text" -ForegroundColor Cyan
}

function Invoke-NativeStep {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Exe,
        [string[]]$Arguments = @()
    )

    Write-Header $Name
    Write-Host "    $Exe $($Arguments -join ' ')" -ForegroundColor DarkGray

    # Stream the step's own output through Write-Host. Piping the native command
    # directly into this function's return value would make it part of the
    # function's output stream, which every call site discards with `| Out-Null`
    # — that silently hid the evidence (the wasm size table, eslint findings)
    # the gate exists to print. `2>&1` keeps stdout and stderr in order.
    & $Exe @Arguments 2>&1 | ForEach-Object { Write-Host "    $_" }
    $code = $LASTEXITCODE

    if ($code -ne 0) {
        Write-Host "    FAIL $Name (exit $code)" -ForegroundColor Red
        $script:failures.Add("$Name (exit $code)")
        return $false
    }

    Write-Host "    OK   $Name" -ForegroundColor Green
    return $true
}

try {
    foreach ($tool in @('pnpm')) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
            Write-Host "FATAL: '$tool' is not on PATH; the gate cannot run." -ForegroundColor Red
            exit 1
        }
    }

    Invoke-NativeStep -Name 'lint' -Exe 'pnpm' -Arguments @('run', 'lint') | Out-Null
    Invoke-NativeStep -Name 'typecheck' -Exe 'pnpm' -Arguments @('run', 'typecheck') | Out-Null
    Invoke-NativeStep -Name 'validate:ir' -Exe 'pnpm' -Arguments @('run', 'validate:ir') | Out-Null
    Invoke-NativeStep -Name 'validate:capabilities' -Exe 'pnpm' -Arguments @('run', 'validate:capabilities') | Out-Null
    Invoke-NativeStep -Name 'validate:seo' -Exe 'pnpm' -Arguments @('run', 'validate:seo') | Out-Null
    Invoke-NativeStep -Name 'validate:plugins' -Exe 'pnpm' -Arguments @('run', 'validate:plugins') | Out-Null

    # The Wasm size budget is measured, never asserted: this step compiles every
    # island crate for wasm32-unknown-unknown and fails when a bundle exceeds the
    # brotli budget. It builds its own artifacts, so a stale `target/` cannot make
    # it pass. Exit 2 (cannot-evaluate) is a failure here, not a pass (ADR 0012).
    Invoke-NativeStep -Name 'validate:wasm-size' -Exe 'pnpm' -Arguments @('run', 'validate:wasm-size') | Out-Null

    Invoke-NativeStep -Name 'test' -Exe 'pnpm' -Arguments @('run', 'test') | Out-Null

    # --- Rust -----------------------------------------------------------------
    # The toolchain is a documented, provisionable prerequisite: rust-toolchain.toml
    # pins the exact channel and wasm target, and rustup installs both automatically.
    # A missing toolchain is therefore a FAIL with remediation, never a silent skip
    # (cl-common ADR 0012: a gate that cannot pass is a defect).
    #
    # The toolchain PATH is resolved at the top of this script, before any step.
    $cargo = Get-Command 'cargo' -ErrorAction SilentlyContinue
    if ($null -eq $cargo) {
        $failures.Add('toolchain: cargo is not on PATH. Install rustup from https://rustup.rs then re-open the shell.')
    }
    else {
        Invoke-NativeStep -Name 'check-toolchain' -Exe 'pwsh' -Arguments @('-NoProfile', '-File', 'scripts/check-toolchain.ps1') | Out-Null
        Invoke-NativeStep -Name 'cargo fmt' -Exe 'cargo' -Arguments @('fmt', '--all', '--check') | Out-Null
        Invoke-NativeStep -Name 'cargo clippy' -Exe 'cargo' -Arguments @('clippy', '--all-targets', '--', '-D', 'warnings') | Out-Null
        Invoke-NativeStep -Name 'cargo test' -Exe 'cargo' -Arguments @('test', '--workspace') | Out-Null
    }

    # --- Summary --------------------------------------------------------------
    Write-Host ''
    Write-Host '---------------- gate summary ----------------' -ForegroundColor Cyan
    if ($skips.Count -gt 0) {
        foreach ($skip in $skips) {
            Write-Host "SKIPPED (waiver): $skip" -ForegroundColor Yellow
        }
    }
    if ($failures.Count -gt 0) {
        foreach ($failure in $failures) {
            Write-Host "FAILED: $failure" -ForegroundColor Red
        }
        Write-Host 'GATE: FAIL' -ForegroundColor Red
        exit 1
    }

    if ($skips.Count -gt 0) {
        Write-Host 'GATE: PASS (with waived steps - see above)' -ForegroundColor Yellow
    }
    else {
        Write-Host 'GATE: PASS' -ForegroundColor Green
    }
    exit 0
}
finally {
    Pop-Location
}
