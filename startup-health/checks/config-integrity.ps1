[CmdletBinding()]
param([ValidateSet('Check')][string]$Action = 'Check', [Parameter(Mandatory = $true)][string]$ContextPath)

$ErrorActionPreference = 'Stop'
$context = Get-Content -Raw -LiteralPath $ContextPath | ConvertFrom-Json
$configuration = $context.configuration
if (-not [bool]$configuration.validatorAvailable) { $status = 'warn'; $reason = 'validator-unavailable'; $guidance = 'review-client-configuration' }
elseif ([int]$configuration.ownedHookCount -gt 1) { $status = 'warn'; $reason = 'owned-hook-duplicate'; $guidance = 'review-client-configuration' }
elseif (-not [bool]$configuration.valid) { $status = 'warn'; $reason = 'configuration-invalid'; $guidance = 'review-client-configuration' }
else { $status = 'ok'; $reason = 'configuration-valid'; $guidance = $null }
[ordered]@{
    schemaVersion = 1; id = 'config-integrity'; surface = [string]$context.surface; status = $status; reasonCode = $reason
    guidanceId = $guidance; startEligibility = 'not-needed'; dependencyReady = ($status -eq 'ok')
    facts = [ordered]@{ validatorAvailable = [bool]$configuration.validatorAvailable; ownedHookCount = [int]$configuration.ownedHookCount }
} | ConvertTo-Json -Compress
