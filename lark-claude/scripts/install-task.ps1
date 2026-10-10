$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Config = Get-Content -Raw (Join-Path $ProjectRoot 'config\gateway.json') | ConvertFrom-Json
$Node = $Config.executables.node
$Entry = Join-Path $ProjectRoot 'src\gateway.mjs'
$TaskName = 'LarkClaudeGateway'
$Action = New-ScheduledTaskAction -Execute $Node -Argument ('"{0}"' -f $Entry) -WorkingDirectory $ProjectRoot
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -User $env:USERNAME -RunLevel Limited -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Output "Scheduled task installed and started: $TaskName"
