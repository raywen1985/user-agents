[CmdletBinding()]
param([ValidateSet('Check')][string]$Action = 'Check', [Parameter(Mandatory = $true)][string]$ContextPath)

$ErrorActionPreference = 'Stop'
$context = Get-Content -Raw -LiteralPath $ContextPath | ConvertFrom-Json
$chrome = $context.chromeDevtools
$packagePresent = (Test-Path -LiteralPath ([string]$chrome.packagePath) -PathType Container) -and (Test-Path -LiteralPath ([string]$chrome.entryScript) -PathType Leaf)
if (-not $packagePresent -or -not [bool]$chrome.lockConsistent) { $status = 'warn'; $reason = 'chrome-devtools-package-missing' }
elseif (-not [bool]$chrome.configured) { $status = 'warn'; $reason = 'chrome-devtools-config-missing' }
elseif (-not [bool]$chrome.enabled -or [bool]$chrome.required -or -not [bool]$chrome.commandMatches -or -not [bool]$chrome.argumentsMatch -or -not [bool]$chrome.autoConnect) { $status = 'warn'; $reason = 'chrome-devtools-config-drift' }
elseif (-not [bool]$chrome.chromePresent) { $status = 'warn'; $reason = 'chrome-unavailable' }
elseif (-not [bool]$chrome.remoteDebuggingAvailable) { $status = 'warn'; $reason = 'remote-debugging-unavailable' }
else { $status = 'ok'; $reason = 'chrome-devtools-ready' }
[ordered]@{
    schemaVersion = 1; id = 'chrome-devtools-mcp'; surface = [string]$context.surface; status = $status; reasonCode = $reason
    guidanceId = if ($status -eq 'ok') { $null } else { 'review-chrome-devtools-setup' }
    startEligibility = 'not-needed'; dependencyReady = ($status -eq 'ok')
    facts = [ordered]@{ packagePresent = $packagePresent; configured = [bool]$chrome.configured; chromePresent = [bool]$chrome.chromePresent; remoteDebuggingAvailable = [bool]$chrome.remoteDebuggingAvailable }
} | ConvertTo-Json -Compress
