[CmdletBinding()]
param([switch]$SkipScheduledTask, [switch]$SkipDesktopShortcut)

$ErrorActionPreference = 'Stop'
$profileRoot = [Environment]::GetFolderPath('UserProfile')
$localRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ai-integration-repair'
$statePath = Join-Path $localRoot 'install.json'
$wrapperRoot = Join-Path $PSScriptRoot 'bin'
$repairScript = Join-Path $PSScriptRoot 'Repair-AIIntegrations.ps1'

function Resolve-RealCommand {
    param([string]$Name)
    $candidates = @(Get-Command $Name -All -ErrorAction SilentlyContinue | Where-Object {
        -not [string]::IsNullOrWhiteSpace([string]$_.Source) -and
        -not ([IO.Path]::GetFullPath([string]$_.Source).StartsWith([IO.Path]::GetFullPath($wrapperRoot), [StringComparison]::OrdinalIgnoreCase))
    })
    if ($candidates.Count -eq 0) { throw "No real $Name command was found outside the wrapper directory." }
    $preferred = if ($Name -eq 'codex') {
        @($candidates | Where-Object { [IO.Path]::GetExtension([string]$_.Source) -in @('.ps1', '.cmd', '.exe') }) | Select-Object -First 1
    } else {
        $candidates | Select-Object -First 1
    }
    $path = [IO.Path]::GetFullPath([string]$preferred.Source)
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Resolved $Name command does not exist: $path" }
    return $path
}

function Write-AtomicJson {
    param([string]$Path, [object]$Value)
    [IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
    $temporary = $Path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    $backup = $Path + '.' + [guid]::NewGuid().ToString('N') + '.replace-backup'
    try {
        [IO.File]::WriteAllText($temporary, (($Value | ConvertTo-Json -Depth 10) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
        if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary, $Path, $backup, $true) }
        else { [IO.File]::Move($temporary, $Path) }
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
        if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
    }
}

function Install-RepairTask {
    $taskName = 'AIIntegrationRepair'
    $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $launcher = Join-Path $PSScriptRoot 'Run-AIIntegrationRepair.vbs'
    if (-not (Test-Path -LiteralPath $wscript -PathType Leaf)) { throw "Windows Script Host is missing: $wscript" }
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw "Hidden repair launcher is missing: $launcher" }
    $arguments = '//B //Nologo "{0}"' -f $launcher
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $logon = New-ScheduledTaskTrigger -AtLogOn -User $sid
    $periodic = New-ScheduledTaskTrigger -Daily -At ([DateTime]::Now.AddMinutes(10))
    $periodic.Repetition = New-CimInstance -ClientOnly -Namespace 'root/Microsoft/Windows/TaskScheduler' -ClassName 'MSFT_TaskRepetitionPattern' -Property @{
        Interval = 'PT10M'; Duration = 'P1D'; StopAtDurationEnd = $false
    }
    $action = New-ScheduledTaskAction -Execute $wscript -Argument $arguments -WorkingDirectory $PSScriptRoot
    $principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 3) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($logon, $periodic) -Principal $principal -Settings $settings -Force | Out-Null
}

function Install-CodexDesktopShortcut {
    $app = @(Get-StartApps | Where-Object { $_.Name -eq 'Codex' -or $_.AppID -match '(?i)OpenAI\.Codex' } | Select-Object -First 1)
    if ($app.Count -eq 0) { return $null }
    $desktop = [Environment]::GetFolderPath('Desktop')
    if ([string]::IsNullOrWhiteSpace($desktop)) { return [string]$app[0].AppID }
    $shortcutPath = Join-Path $desktop 'Codex (with self-check).lnk'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $shortcut.Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path $PSScriptRoot 'Invoke-CodexDesktop.ps1')
    $shortcut.WorkingDirectory = $PSScriptRoot
    $shortcut.Description = 'Run integration repair, then start Codex desktop.'
    $shortcut.Save()
    return [string]$app[0].AppID
}

$claudeCommand = Resolve-RealCommand 'claude'
$codexCommand = Resolve-RealCommand 'codex'
$desktopAppId = if ($SkipDesktopShortcut) { '' } else { Install-CodexDesktopShortcut }
$state = [ordered]@{
    schemaVersion = 1
    installedAt = [DateTimeOffset]::Now.ToString('o')
    clients = [ordered]@{
        claude = [ordered]@{ command = $claudeCommand }
        codex = [ordered]@{ command = $codexCommand }
    }
    codexDesktop = [ordered]@{ appUserModelId = $desktopAppId }
}
Write-AtomicJson $statePath $state

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$parts = @($userPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and -not [string]::Equals($_.TrimEnd('\'), $wrapperRoot.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) })
$newUserPath = (@($wrapperRoot) + $parts) -join ';'
if (-not [string]::Equals($userPath, $newUserPath, [StringComparison]::OrdinalIgnoreCase)) {
    [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
}
$env:Path = (@($wrapperRoot) + @($env:Path -split ';' | Where-Object { -not [string]::Equals($_.TrimEnd('\'), $wrapperRoot.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) })) -join ';'

if (-not $SkipScheduledTask) { Install-RepairTask }

$repairOutput = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $repairScript 2>&1
$repairExit = $LASTEXITCODE
[pscustomobject]@{
    Installed = $true
    ClaudeCommand = $claudeCommand
    CodexCommand = $codexCommand
    WrapperDirectory = $wrapperRoot
    ScheduledTask = -not $SkipScheduledTask
    DesktopShortcut = -not [string]::IsNullOrWhiteSpace($desktopAppId)
    InitialRepairExitCode = $repairExit
    InitialRepair = ($repairOutput -join [Environment]::NewLine)
} | Format-List
if ($repairExit -ne 0) { exit $repairExit }
