[CmdletBinding()]
param(
    [string]$TaskName = "LarkNotifyBootstrap",
    [switch]$NoStart
)

$ErrorActionPreference = "Stop"

function New-LarkNotifyBootstrapTaskDefinition
{
    param(
        [string]$BootstrapScript = (Join-Path $PSScriptRoot "Initialize-LarkNotify.ps1"),
        [string]$LauncherScript = (Join-Path $PSScriptRoot "Run-LarkNotifyBootstrap.vbs"),
        [string]$UserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    )

    if (-not (Test-Path -LiteralPath $BootstrapScript -PathType Leaf))
    {
        throw "Bootstrap script not found: $BootstrapScript"
    }
    if (-not (Test-Path -LiteralPath $LauncherScript -PathType Leaf))
    {
        throw "Bootstrap launcher not found: $LauncherScript"
    }
    $wscript = Join-Path $env:SystemRoot "System32\wscript.exe"
    if (-not (Test-Path -LiteralPath $wscript -PathType Leaf))
    {
        throw "Windows Script Host not found: $wscript"
    }
    $arguments = '//B //Nologo "{0}"' -f $LauncherScript
    $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $UserSid
    $periodicTrigger = New-ScheduledTaskTrigger -Daily -At ([DateTime]::Today)
    $periodicTrigger.Repetition = New-CimInstance `
        -ClientOnly `
        -Namespace "root/Microsoft/Windows/TaskScheduler" `
        -ClassName "MSFT_TaskRepetitionPattern" `
        -Property @{
            Interval = "PT10M"
            Duration = "P1D"
            StopAtDurationEnd = $false
        }
    return [pscustomobject]@{
        Action = New-ScheduledTaskAction -Execute $wscript -Argument $arguments -WorkingDirectory (Split-Path -Parent $BootstrapScript)
        Trigger = @($logonTrigger, $periodicTrigger)
        Principal = New-ScheduledTaskPrincipal -UserId $UserSid -LogonType Interactive -RunLevel Limited
        Settings = New-ScheduledTaskSettingsSet `
            -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
            -RestartCount 5 `
            -RestartInterval (New-TimeSpan -Minutes 1) `
            -MultipleInstances IgnoreNew `
            -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries
    }
}

function Install-LarkNotifyBootstrapTask
{
    param([string]$TaskName = "LarkNotifyBootstrap", [switch]$NoStart)

    $definition = New-LarkNotifyBootstrapTaskDefinition
    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $definition.Action `
        -Trigger $definition.Trigger `
        -Principal $definition.Principal `
        -Settings $definition.Settings `
        -Force | Out-Null

    if ($NoStart) { return Get-ScheduledTask -TaskName $TaskName }

    $before = Get-ScheduledTaskInfo -TaskName $TaskName
    Start-ScheduledTask -TaskName $TaskName
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    do
    {
        Start-Sleep -Milliseconds 250
        $task = Get-ScheduledTask -TaskName $TaskName
        $info = Get-ScheduledTaskInfo -TaskName $TaskName
        $isNewRun = $info.LastRunTime -gt $before.LastRunTime
        if ($isNewRun -and $task.State -ne "Running")
        {
            if ([int64]$info.LastTaskResult -ne 0)
            {
                throw "Bootstrap task failed with result $($info.LastTaskResult)."
            }
            return $task
        }
    }
    while ([DateTime]::UtcNow -lt $deadline)
    throw "Bootstrap task did not complete a new run within 45 seconds."
}

if ($MyInvocation.InvocationName -ne '.')
{
    $task = Install-LarkNotifyBootstrapTask -TaskName $TaskName -NoStart:$NoStart
    Write-Output "Scheduled task installed: $($task.TaskName) state=$($task.State)"
}
