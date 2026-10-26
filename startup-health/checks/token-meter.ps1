[CmdletBinding()]
param([ValidateSet('Check')][string]$Action = 'Check', [Parameter(Mandatory = $true)][string]$ContextPath)

$ErrorActionPreference = 'Stop'
$context = Get-Content -Raw -LiteralPath $ContextPath | ConvertFrom-Json
$root = [string]$context.paths.repositoryRoot
$modulePath = Join-Path (Join-Path $root 'startup-health') 'StartupHealth.psm1'
Import-Module $modulePath -Force
$tokenRoot = Join-Path $root 'token-meter'
$required = @('TokenMeter.psm1', 'ClaudeTurnHook.ps1', 'CodexTurnHook.ps1', 'ClaudeStatusLine.ps1', 'model-prices.json')
$missing = @($required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $tokenRoot $_) -PathType Leaf) })
$manifestValid = [bool]$context.tokenMeter.manifestValid
$hookHealthy = [bool]$context.tokenMeter.hookHealthy
$statusLineHealthy = [bool]$context.tokenMeter.statusLineHealthy
$dataRoot = [string]$context.tokenMeter.dataRoot
$access = $false
if (Test-Path -LiteralPath $dataRoot -PathType Container) {
    try { $access = Test-SHDirectoryAccess $dataRoot ([string]$context.paths.nativeAssemblyPath) } catch { $access = $false }
}
if ($missing.Count) { $status = 'warn'; $reason = 'token-meter-component-missing' }
elseif (-not $hookHealthy -or -not $statusLineHealthy) { $status = 'warn'; $reason = 'token-meter-hook-missing' }
elseif (-not $access) { $status = 'warn'; $reason = 'token-meter-data-denied' }
elseif (-not $manifestValid) { $status = 'warn'; $reason = 'token-meter-manifest-invalid' }
else { $status = 'ok'; $reason = 'token-meter-ready' }
[ordered]@{
    schemaVersion = 1; id = 'token-meter'; surface = [string]$context.surface; status = $status; reasonCode = $reason
    guidanceId = if ($status -eq 'ok') { $null } else { 'run-token-meter-installer' }
    startEligibility = 'not-needed'; dependencyReady = ($status -eq 'ok')
    facts = [ordered]@{ missingComponentCount = $missing.Count; hookHealthy = $hookHealthy; statusLineHealthy = $statusLineHealthy; dataAccess = $access; manifestValid = $manifestValid }
} | ConvertTo-Json -Compress
