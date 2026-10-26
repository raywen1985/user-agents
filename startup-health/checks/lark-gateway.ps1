[CmdletBinding()]
param([ValidateSet('Check')][string]$Action = 'Check', [Parameter(Mandatory = $true)][string]$ContextPath)

$ErrorActionPreference = 'Stop'
$context = Get-Content -Raw -LiteralPath $ContextPath | ConvertFrom-Json
$root = [string]$context.paths.repositoryRoot
Import-Module (Join-Path (Join-Path $root 'startup-health') 'StartupHealth.psm1') -Force
$gateway = $context.larkGateway
$status = 'warn'; $reason = 'gateway-health-invalid'; $guidance = 'run-gateway-installer'; $eligibility = 'unsupported'; $healthy = $false

if (-not [bool]$gateway.taskPresent) {
    $reason = 'gateway-task-missing'
} elseif (-not [bool]$gateway.taskEnabled -or [string]$gateway.taskState -eq 'Disabled') {
    $reason = 'gateway-task-disabled'; $guidance = 'run-gateway-installer'
} elseif (-not [bool]$gateway.taskDefinitionMatches) {
    $reason = 'policy-task-definition-drift'; $guidance = 'reinstall-health-policy'
} else {
    $health = $null; $healthFailure = 'gateway-health-invalid'
    for ($attempt = 0; $attempt -lt 2 -and $null -eq $health; $attempt++) {
        try {
            $item = Get-Item -LiteralPath ([string]$gateway.healthPath) -ErrorAction Stop
            if ($item.Length -gt 65536) { throw 'health file too large' }
            $health = Get-Content -Raw -LiteralPath $item.FullName | ConvertFrom-Json
        } catch {
            if ($attempt -eq 0) { Start-Sleep -Milliseconds 100 }
        }
    }
    if ($null -ne $health) {
        try {
            $now = if ($null -ne $context.PSObject.Properties['now']) { [DateTimeOffset]::Parse([string]$context.now) } else { [DateTimeOffset]::UtcNow }
            $updated = [DateTimeOffset]::Parse([string]$health.updatedAt)
            if ($updated -lt $now.AddSeconds(-45) -or $updated -gt $now.AddSeconds(15)) { $healthFailure = 'gateway-health-stale' }
            elseif (-not [bool]$health.listenerReady -or [bool]$health.stopping) { $healthFailure = 'gateway-health-invalid' }
            elseif ([int]$health.pid -le 0 -or [string]::IsNullOrWhiteSpace([string]$health.processStartedAt)) { $healthFailure = 'gateway-health-invalid' }
            else {
                $process = Get-SHProcessIdentity ([int]$health.pid) ([string]$context.paths.nativeAssemblyPath)
                $expectedStart = [DateTimeOffset]::Parse([string]$health.processStartedAt)
                $actualStart = ConvertFrom-SHFileTime ([string]$process.ProcessStartFileTime)
                $delta = [Math]::Abs(($actualStart - $expectedStart).TotalSeconds)
                if ([string]$process.ExecutablePath -ine [string]$gateway.expectedNodePath -or $delta -gt 5) { $healthFailure = 'gateway-health-invalid' }
                elseif ($null -ne $health.PSObject.Properties['gatewayEntry'] -and [string]$health.gatewayEntry -ine [string]$gateway.expectedGatewayEntry) { $healthFailure = 'gateway-health-invalid' }
                else { $healthy = $true }
            }
        } catch { $healthy = $false; $healthFailure = 'gateway-health-invalid' }
    }
    switch ([string]$gateway.taskState) {
        { $_ -in @('Running', 'Queued') } {
            if ($healthy) { $status = 'ok'; $reason = 'listener-ready'; $guidance = $null; $eligibility = 'not-needed' }
            else { $reason = $healthFailure; $eligibility = 'unsupported' }
            break
        }
        'Ready' {
            if ($healthy) { $status = 'ok'; $reason = 'live-gateway-external-to-task'; $guidance = $null; $eligibility = 'not-needed' }
            else { $reason = 'gateway-not-running'; $guidance = $null; $eligibility = 'eligible' }
            break
        }
        default { $reason = 'gateway-health-invalid'; $eligibility = 'unsupported' }
    }
}
[ordered]@{
    schemaVersion = 1; id = 'lark-gateway'; surface = 'global'; status = $status; reasonCode = $reason
    guidanceId = $guidance; startEligibility = $eligibility; dependencyReady = [bool]$gateway.dependenciesReady
    facts = [ordered]@{ taskPresent = [bool]$gateway.taskPresent; taskEnabled = [bool]$gateway.taskEnabled; taskState = [string]$gateway.taskState; healthy = $healthy; taskDefinitionMatches = [bool]$gateway.taskDefinitionMatches }
} | ConvertTo-Json -Compress
