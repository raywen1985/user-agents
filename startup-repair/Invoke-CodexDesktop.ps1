$ErrorActionPreference = 'Stop'
$statePath = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ai-integration-repair\install.json'
$repairScript = Join-Path $PSScriptRoot 'Repair-AIIntegrations.ps1'

try {
    $repairOutput = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $repairScript 2>&1
    if ($LASTEXITCODE -ne 0) {
        [Console]::Error.WriteLine('[AI Startup] Integration repair reported a warning; Codex will still start.')
        if ($repairOutput) { [Console]::Error.WriteLine(($repairOutput -join [Environment]::NewLine)) }
    }
} catch {
    [Console]::Error.WriteLine("[AI Startup] Integration repair failed: $($_.Exception.Message). Codex will still start.")
}

$state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
$appId = [string]$state.codexDesktop.appUserModelId
if ([string]::IsNullOrWhiteSpace($appId)) { throw 'Codex desktop AppUserModelId is unavailable. Re-run Install-AIIntegrationRepair.ps1.' }
Start-Process explorer.exe -ArgumentList ('shell:AppsFolder\' + $appId)
