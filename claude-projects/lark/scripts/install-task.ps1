#requires -Version 5.1
param(
    [string]$NodePath,
    [string]$LarkCliPath,
    [string]$ClaudePath,
    [string]$FfmpegPath,
    [string]$SvnPath,
    [switch]$DiscoveryOnly
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'install-support.ps1')

$projectRoot = Split-Path -Parent $PSScriptRoot
$taskName = 'LarkClaudeGateway'
$executables = Get-InstalledExecutables ([ordered]@{
    Node = $NodePath; LarkCli = $LarkCliPath; Claude = $ClaudePath; Ffmpeg = $FfmpegPath; Svn = $SvnPath
})

if ($DiscoveryOnly) {
    [pscustomobject]@{ projectRoot = $projectRoot; executables = $executables } | ConvertTo-Json -Depth 5
    exit 0
}

$installLock = Enter-InstallationLock $projectRoot
try {
Restore-InstallationTransaction $projectRoot $taskName
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -ne $existingTask -and [string]$existingTask.State -eq 'Running') { throw 'Gateway task is running. Stop it before installation.' }
$pidPath = Join-Path $projectRoot 'run\gateway.pid'
if (Test-Path -LiteralPath $pidPath) {
    $gatewayPid = [int](Get-Content -Raw -LiteralPath $pidPath)
    if ($null -ne (Get-Process -Id $gatewayPid -ErrorAction SilentlyContinue)) { throw 'Gateway process is running. Stop it before installation.' }
}

$generation = [Guid]::NewGuid().ToString('N')
$gateway = [ordered]@{ installationGeneration = $generation; executables = $executables }
$projectsPath = Join-Path $projectRoot 'config\projects.local.json'
$projects = Read-JsonObject $projectsPath ([ordered]@{ excludedRoots = @(); projects = @() })
$settingsPath = Join-Path $projectRoot '.claude\settings.local.json'
$statePath = Join-Path $projectRoot '.claude\install-state.local.json'
$claude = New-ClaudeSettingsContent $settingsPath $statePath $executables $generation
$entry = (Resolve-Path -LiteralPath (Join-Path $projectRoot 'src\gateway.mjs')).Path
$arguments = ('"{0}" --installation-generation {1}' -f $entry, $generation)
$proposedTask = [ordered]@{ execute = $executables.node; arguments = $arguments; workingDirectory = $projectRoot; entryPoint = $entry; user = $env:USERNAME }
$contents = [ordered]@{
    gateway = ConvertTo-JsonText $gateway
    projects = ConvertTo-JsonText $projects
    settings = ConvertTo-JsonText $claude.settings
    state = ConvertTo-JsonText $claude.state
}
$manifest = New-InstallationTransaction $projectRoot $taskName $generation $contents $proposedTask

try {
    foreach ($target in @($manifest.targets)) {
        $destination = switch ([string]$target.id) {
            'gateway' { Join-Path $projectRoot 'config\gateway.local.json' }
            'projects' { Join-Path $projectRoot 'config\projects.local.json' }
            'settings' { Join-Path $projectRoot '.claude\settings.local.json' }
            'state' { Join-Path $projectRoot '.claude\install-state.local.json' }
        }
        Move-Item -LiteralPath ([string]$target.proposal) -Destination $destination -Force
    }
    $action = New-ScheduledTaskAction -Execute $executables.node -Argument $arguments -WorkingDirectory $projectRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $taskSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $taskSettings -User $env:USERNAME -RunLevel Limited -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
    $healthPath = Join-Path $projectRoot 'run\health.json'
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    $healthy = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 500
        if (-not (Test-Path -LiteralPath $healthPath -PathType Leaf)) { continue }
        try { $health = Get-Content -Raw -LiteralPath $healthPath | ConvertFrom-Json } catch { continue }
        if ([string]$health.installationGeneration -ne $generation -or [string]$health.nodeExecutable -ine $executables.node -or [string]$health.gatewayEntry -ine $entry) { continue }
        $process = Get-Process -Id ([int]$health.pid) -ErrorAction SilentlyContinue
        if ($null -eq $process -or $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne [string]$health.procStart -or $health.listenerReady -ne $true) { continue }
        $identityPath = Join-Path $projectRoot 'run\install-transaction\process-identity.json'
        $identityTemp = $identityPath + '.tmp'
        Write-TextFile $identityTemp (ConvertTo-JsonText ([ordered]@{
            schemaVersion = 1; generation = $generation; pid = [int]$health.pid; procStart = [string]$health.procStart
            nodeExecutable = $executables.node; gatewayEntry = $entry
        }))
        Move-Item -LiteralPath $identityTemp -Destination $identityPath -Force
        $healthy = $true
        break
    }
    if (-not $healthy) { throw 'Gateway did not publish generation-bound healthy state within 45 seconds.' }
    Remove-Item -LiteralPath (Join-Path $projectRoot 'run\install-transaction') -Recurse -Force
    Write-Output "Scheduled task installed and verified: $taskName"
} catch {
    $failure = $_
    try { Restore-InstallationTransaction $projectRoot $taskName } catch { throw "$($failure.Exception.Message) Recovery also failed: $($_.Exception.Message)" }
    throw $failure
}
} finally {
    $installLock.Dispose()
}
