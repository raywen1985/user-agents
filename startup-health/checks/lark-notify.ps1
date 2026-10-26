[CmdletBinding()]
param([ValidateSet('Check')][string]$Action = 'Check', [Parameter(Mandatory = $true)][string]$ContextPath)

$ErrorActionPreference = 'Stop'
$context = Get-Content -Raw -LiteralPath $ContextPath | ConvertFrom-Json
$root = [string]$context.paths.repositoryRoot
$required = @(
    (Join-Path (Join-Path $root 'hooks') 'lark-notify.ps1'),
    (Join-Path (Join-Path $root 'hooks') 'Invoke-CodexNotifyBridge.ps1'),
    (Join-Path (Join-Path $root 'hooks') 'Initialize-LarkNotify.ps1')
)
$missing = @($required | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) })
$notify = $context.larkNotify
if ($missing.Count -or -not [bool]$notify.larkCliPresent) { $status = 'warn'; $reason = 'notification-component-missing' }
elseif (-not [bool]$notify.hookHealthy -or -not [bool]$notify.bridgeHealthy) { $status = 'warn'; $reason = 'notification-hook-missing' }
elseif (-not [bool]$notify.taskPresent) { $status = 'warn'; $reason = 'bootstrap-task-missing' }
elseif (-not [bool]$notify.taskEnabled) { $status = 'warn'; $reason = 'bootstrap-task-disabled' }
elseif ([string]$notify.taskState -notin @('Running', 'Queued') -and [int64]$notify.lastTaskResult -ne 0) { $status = 'warn'; $reason = 'bootstrap-last-run-failed' }
else { $status = 'ok'; $reason = 'notification-ready' }
[ordered]@{
    schemaVersion = 1; id = 'lark-notify'; surface = [string]$context.surface; status = $status; reasonCode = $reason
    guidanceId = if ($status -eq 'ok') { $null } else { 'run-notification-installer' }
    startEligibility = 'not-needed'; dependencyReady = ($status -eq 'ok')
    facts = [ordered]@{ missingComponentCount = $missing.Count; taskPresent = [bool]$notify.taskPresent; taskEnabled = [bool]$notify.taskEnabled; taskActive = ([string]$notify.taskState -in @('Running', 'Queued')) }
} | ConvertTo-Json -Compress
