$ErrorActionPreference = 'Stop'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('agent-config-watch-test-' + [Guid]::NewGuid().ToString('N'))
$fixtureRoot = Join-Path $testRoot 'agents\config-sync'
[IO.Directory]::CreateDirectory((Join-Path $fixtureRoot 'tools')) | Out-Null
foreach ($name in @('Enable-AgentConfigWatch.ps1', 'Disable-AgentConfigWatch.ps1', 'Run-AgentConfigWatch.vbs')) {
    [IO.File]::Copy((Join-Path (Split-Path -Parent $PSScriptRoot) $name), (Join-Path $fixtureRoot $name))
}
[IO.File]::Copy((Join-Path (Split-Path -Parent $PSScriptRoot) 'tools\file-io.ps1'), (Join-Path $fixtureRoot 'tools\file-io.ps1'))
$global:ConfigSyncFakeNode = Join-Path $testRoot 'FakeNode.ps1'
[IO.File]::WriteAllText($global:ConfigSyncFakeNode, 'param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Unused); $global:LASTEXITCODE = 0')
$global:ConfigSyncTestTask = $null
$global:ConfigSyncRegisters = 0
$global:ConfigSyncStarts = 0
$global:ConfigSyncStops = 0
$global:ConfigSyncDisables = 0
function Assert([bool]$Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Get-Command { param($Name,$CommandType,$ErrorAction) if ($Name -ne 'node') { throw 'Unexpected command lookup' }; [pscustomobject]@{ Source = $global:ConfigSyncFakeNode }; [pscustomobject]@{ Source = 'must-not-use-second-runtime' } }
function Get-ScheduledTask { param($TaskName,$ErrorAction) $global:ConfigSyncTestTask }
function New-ScheduledTaskAction { param($Execute,$Argument,$WorkingDirectory) [pscustomobject]@{ Execute=$Execute; Arguments=$Argument; WorkingDirectory=$WorkingDirectory } }
function New-ScheduledTaskTrigger { param([switch]$AtLogOn,$User) [pscustomobject]@{ User=$User } }
function New-ScheduledTaskPrincipal { param($UserId,$LogonType,$RunLevel) [pscustomobject]@{ UserId=$UserId; LogonType=$LogonType; RunLevel=$RunLevel } }
function New-ScheduledTaskSettingsSet { param($MultipleInstances,$ExecutionTimeLimit,$RestartCount,$RestartInterval,[switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries) [pscustomobject]@{ MultipleInstances=$MultipleInstances; ExecutionTimeLimit=$ExecutionTimeLimit } }
function Register-ScheduledTask { param($TaskName,$Action,$Trigger,$Principal,$Settings,$Description,[switch]$Force)
    $global:ConfigSyncRegisters++
    $global:ConfigSyncTestTask=[pscustomobject]@{ TaskName=$TaskName; Actions=@($Action); Principal=$Principal; Settings=$Settings; Description=$Description; State='Ready' }
}
function Start-ScheduledTask { param($TaskName) $global:ConfigSyncStarts++; $global:ConfigSyncTestTask.State='Running' }
function Stop-ScheduledTask { param($TaskName) $global:ConfigSyncStops++; $global:ConfigSyncTestTask.State='Ready' }
function Disable-ScheduledTask { param($TaskName) $global:ConfigSyncDisables++ }
try {
    & (Join-Path $fixtureRoot 'Enable-AgentConfigWatch.ps1') -WhatIf
    Assert ($global:ConfigSyncRegisters -eq 0) 'WhatIf must not register'
    & (Join-Path $fixtureRoot 'Enable-AgentConfigWatch.ps1') -NoStart | Out-Null
    Assert ($global:ConfigSyncRegisters -eq 1 -and $global:ConfigSyncStarts -eq 0) 'NoStart must register without launching'
    Assert ($global:ConfigSyncTestTask.Principal.RunLevel -eq 'Limited') 'Task must not request elevation'
    Assert ($global:ConfigSyncTestTask.Actions[0].Execute -match 'wscript.exe$') 'Task must use hidden launcher'
    & (Join-Path $fixtureRoot 'Enable-AgentConfigWatch.ps1') | Out-Null
    Assert ($global:ConfigSyncRegisters -eq 2 -and $global:ConfigSyncStarts -eq 1) 'Repeated enable must update owned task'
    & (Join-Path $fixtureRoot 'Disable-AgentConfigWatch.ps1') -WhatIf
    Assert ($global:ConfigSyncDisables -eq 0) 'Disable WhatIf must not disable task'
    & (Join-Path $fixtureRoot 'Disable-AgentConfigWatch.ps1') | Out-Null
    $stopFile = Join-Path $testRoot 'agents\local\config-sync\watch.stop'
    Assert ((Test-Path -LiteralPath $stopFile) -and $global:ConfigSyncDisables -eq 1) 'Disable must leave persistent stop signal'
    & (Join-Path $fixtureRoot 'Enable-AgentConfigWatch.ps1') -NoStart | Out-Null
    Assert (-not (Test-Path -LiteralPath $stopFile)) 'Explicit enable clears stop signal'
    $before = $global:ConfigSyncRegisters
    $global:ConfigSyncTestTask.Description = 'unrelated-task'
    $rejected = $false
    try { & (Join-Path $fixtureRoot 'Enable-AgentConfigWatch.ps1') | Out-Null } catch { $rejected = $true }
    Assert ($rejected -and $global:ConfigSyncRegisters -eq $before) 'Must not replace unrelated task'
    $rejected = $false
    try { & (Join-Path $fixtureRoot 'Disable-AgentConfigWatch.ps1') | Out-Null } catch { $rejected = $true }
    Assert $rejected 'Must not disable unrelated task'
    Write-Output 'PASS: 10 watcher task lifecycle assertions; all scheduler calls mocked.'
} finally {
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notlike 'agent-config-watch-test-*') { throw 'Unsafe test cleanup path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
    Remove-Variable -Name ConfigSyncFakeNode,ConfigSyncTestTask,ConfigSyncRegisters,ConfigSyncStarts,ConfigSyncStops,ConfigSyncDisables -Scope Global -ErrorAction SilentlyContinue
}
