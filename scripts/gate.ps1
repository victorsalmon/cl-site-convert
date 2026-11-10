<#
.SYNOPSIS
    The repository gate: lint, typecheck, test, cargo test.

.DESCRIPTION
    Fail-closed. Every step must genuinely pass for the gate to exit 0.

    The Rust step is the one exception, and only while this machine has no Rust
    toolchain (bead B0.6). A missing toolchain is reported as a loud, named
    SKIP-with-waiver: visible in the output and in the summary, never a silent
    pass and never a green tick. Pass -RequireCargo (CI with a toolchain, or
    once B0.6 lands) to make the waiver an error.

.PARAMETER RequireCargo
    Turn the "cargo missing" waiver into a hard failure.

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

    & $Exe @Arguments
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
    Invoke-NativeStep -Name 'test' -Exe 'pnpm' -Arguments @('run', 'test') | Out-Null

    # --- Rust -----------------------------------------------------------------
    $cargo = Get-Command 'cargo' -ErrorAction SilentlyContinue
    if ($null -eq $cargo) {
        $waiver = 'cargo test (waiver: Rust toolchain not installed on this machine - bead B0.6)'
        Write-Host ''
        Write-Host '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!' -ForegroundColor Yellow
        Write-Host '!! SKIPPED WITH WAIVER: cargo test' -ForegroundColor Yellow
        Write-Host '!! The Rust workspace and crates/islands-core were NOT compiled.' -ForegroundColor Yellow
        Write-Host '!! Reason: `cargo` is not on PATH (Rust toolchain unprovisioned, B0.6).' -ForegroundColor Yellow
        Write-Host '!! This step is NOT a pass. Re-run with -RequireCargo to enforce.' -ForegroundColor Yellow
        Write-Host '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!' -ForegroundColor Yellow
        Write-Host ''

        if ($RequireCargo) {
            $failures.Add($waiver)
        }
        else {
            $skips.Add($waiver)
        }
    }
    else {
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
