[CmdletBinding(SupportsShouldProcess)]
param([switch]$NoStart)
$ErrorActionPreference = 'Stop'
$taskName = 'AgentConfigSync'
$owner = 'AgentsConfigSync/v1'
$stateRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'local\config-sync'
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
& $node (Join-Path $PSScriptRoot 'tools\cli.mjs') check
if ($LASTEXITCODE -ne 0) { throw 'Initialize or resolve configuration sync before enabling its watcher.' }
$launcher = Join-Path $PSScriptRoot 'Run-AgentConfigWatch.vbs'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$arguments = '//B //Nologo "{0}"' -f $launcher
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    if ($existing.Description -cne $owner -or $existing.Principal.UserId -ne $sid -or @($existing.Actions).Count -ne 1 -or
        $existing.Actions[0].Execute -ine $wscript -or $existing.Actions[0].Arguments -cne $arguments) { throw 'A different task owns this task name.' }
}
if (-not $PSCmdlet.ShouldProcess('Current-user AgentConfigSync login task', 'Enable')) { return }
if ($existing) {
    Stop-ScheduledTask -TaskName $taskName
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ((Get-ScheduledTask -TaskName $taskName).State -eq 'Running') {
        if ([DateTime]::UtcNow -gt $deadline) { throw 'Previous watcher did not stop.' }
        Start-Sleep -Milliseconds 200
    }
}
$stopFile = Join-Path $stateRoot 'watch.stop'
if (Test-Path -LiteralPath $stopFile) { Remove-Item -LiteralPath $stopFile }
$action = New-ScheduledTaskAction -Execute $wscript -Argument $arguments -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $sid
$principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $owner -Force | Out-Null
if (-not $NoStart) { Start-ScheduledTask -TaskName $taskName }
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName,State
