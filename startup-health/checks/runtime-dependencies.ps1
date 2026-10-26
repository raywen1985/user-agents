[CmdletBinding()]
param([ValidateSet('Check')][string]$Action = 'Check', [Parameter(Mandatory = $true)][string]$ContextPath)

$ErrorActionPreference = 'Stop'
$context = Get-Content -Raw -LiteralPath $ContextPath | ConvertFrom-Json
$missing = 0; $unverified = 0
foreach ($dependency in @($context.runtimeDependencies)) {
    if (-not [bool]$dependency.required) { continue }
    if ([string]::IsNullOrWhiteSpace([string]$dependency.path) -or -not (Test-Path -LiteralPath ([string]$dependency.path) -PathType Leaf)) { $missing++; continue }
    if ($null -ne $dependency.PSObject.Properties['probeReady'] -and -not [bool]$dependency.probeReady) { $unverified++ }
}
$status = if ($missing -gt 0 -or $unverified -gt 0) { 'warn' } else { 'ok' }
$reason = if ($missing -gt 0) { 'dependency-missing' } elseif ($unverified -gt 0) { 'dependency-version-unavailable' } else { 'dependencies-ready' }
$guidance = if ($status -eq 'ok') { $null } else { 'review-runtime-installation' }
[ordered]@{
    schemaVersion = 1; id = 'runtime-dependencies'; surface = 'global'; status = $status; reasonCode = $reason
    guidanceId = $guidance; startEligibility = 'not-needed'; dependencyReady = ($status -eq 'ok')
    facts = [ordered]@{ requiredCount = @($context.runtimeDependencies | Where-Object required).Count; missingCount = $missing; unverifiedCount = $unverified }
} | ConvertTo-Json -Compress
