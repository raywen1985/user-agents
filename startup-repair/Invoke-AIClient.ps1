[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('claude', 'codex')]
    [string]$Client,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ClientArguments
)

$ErrorActionPreference = 'Stop'
$statePath = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ai-integration-repair\install.json'
$repairScript = Join-Path $PSScriptRoot 'Repair-AIIntegrations.ps1'

try {
    $repairOutput = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $repairScript 2>&1
    if ($LASTEXITCODE -ne 0) {
        [Console]::Error.WriteLine('[AI Startup] Integration repair reported a warning; client startup will continue.')
        if ($repairOutput) { [Console]::Error.WriteLine(($repairOutput -join [Environment]::NewLine)) }
    }
} catch {
    [Console]::Error.WriteLine("[AI Startup] Integration repair failed: $($_.Exception.Message). Client startup will continue.")
}

try {
    $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    $command = [string]$state.clients.$Client.command
    if ([string]::IsNullOrWhiteSpace($command) -or -not (Test-Path -LiteralPath $command -PathType Leaf)) {
        throw "Recorded $Client command is unavailable. Re-run Install-AIIntegrationRepair.ps1."
    }
    & $command @ClientArguments
    exit $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine("[AI Startup] Cannot launch ${Client}: $($_.Exception.Message)")
    exit 1
}
