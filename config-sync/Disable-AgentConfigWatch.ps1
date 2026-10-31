[CmdletBinding(SupportsShouldProcess)]
param()
$ErrorActionPreference = 'Stop'
$taskName = 'AgentConfigSync'
$stateRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'local\config-sync'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$launcher = Join-Path $PSScriptRoot 'Run-AgentConfigWatch.vbs'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($task -and ($task.Description -cne 'AgentsConfigSync/v1' -or $task.Principal.UserId -ne $sid -or @($task.Actions).Count -ne 1 -or
    $task.Actions[0].Execute -ine (Join-Path $env:SystemRoot 'System32\wscript.exe') -or
    $task.Actions[0].Arguments -cne ('//B //Nologo "{0}"' -f $launcher))) { throw 'A different task owns this task name.' }
if (-not $PSCmdlet.ShouldProcess('Current-user AgentConfigSync watcher', 'Disable')) { return }
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'tools\file-io.ps1') -Operation SecureDirectory -Target $stateRoot
if ($LASTEXITCODE -ne 0) { throw 'Cannot protect local state.' }
[IO.File]::WriteAllText((Join-Path $stateRoot 'watch.stop'), 'disabled')
if ($task) {
    Disable-ScheduledTask -TaskName $taskName | Out-Null
    Stop-ScheduledTask -TaskName $taskName
}
Write-Output 'AgentConfigSync disabled; settings, sources, state and backups retained.'
