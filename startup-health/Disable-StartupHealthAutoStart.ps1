[CmdletBinding(SupportsShouldProcess = $true)]
param([string]$StateRoot)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'StartupHealth.psm1') -Force
if ([string]::IsNullOrWhiteSpace($StateRoot)) {
    $localData = [Environment]::GetFolderPath('LocalApplicationData')
    if ([string]::IsNullOrWhiteSpace($localData)) { $localData = $env:LOCALAPPDATA }
    $StateRoot = Get-SHStateRoot $localData
}
$mutex = Enter-SHMutex -WaitMilliseconds 10000
if (-not $mutex.Acquired) { throw 'Another startup-health runner or control command owns the mutex.' }
try {
    $manifest = Read-SHStateJson (Join-Path $StateRoot 'install-manifest.json')
    if ($null -eq $manifest -or -not [bool]$manifest.installed) { throw 'Startup health is not installed.' }
    if ($PSCmdlet.ShouldProcess((Join-Path $StateRoot 'mode.json'), 'Disable gateway auto-start and retain health checks')) {
        Write-SHAtomicJson (Join-Path $StateRoot 'mode.json') ([ordered]@{ schemaVersion = 1; autoStart = 'warn-only'; generation = [string]$manifest.generation; disabledAt = [DateTimeOffset]::UtcNow.ToString('O') })
    }
    [ordered]@{ enabled = $false; checksInstalled = $true; generation = [string]$manifest.generation } | ConvertTo-Json -Compress
} finally { Exit-SHMutex $mutex }
