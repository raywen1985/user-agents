$ErrorActionPreference = 'Stop'
$failures = New-Object Collections.Generic.List[string]
$passed = 0
function Assert-Repair([bool]$Condition, [string]$Message) {
    if ($Condition) { $script:passed++; return }
    $failures.Add($Message)
}

$profileRoot = [Environment]::GetFolderPath('UserProfile')
$localRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ai-integration-repair'
$statePath = Join-Path $localRoot 'install.json'
$wrapperRoot = Join-Path $PSScriptRoot 'bin'

foreach ($file in @('Repair-AIIntegrations.ps1', 'Invoke-AIClient.ps1', 'Invoke-CodexDesktop.ps1', 'Install-AIIntegrationRepair.ps1')) {
    $tokens = $null; $errors = $null
    [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $file), [ref]$tokens, [ref]$errors)
    Assert-Repair (@($errors).Count -eq 0) "$file parses without syntax errors"
}
foreach ($wrapper in @('claude.cmd', 'codex.cmd')) {
    $text = Get-Content -Raw -LiteralPath (Join-Path $wrapperRoot $wrapper)
    Assert-Repair ($text -match '%USERPROFILE%') "$wrapper uses a portable user-profile path"
    Assert-Repair ($text -notmatch '(?i)[A-Z]:\\Users\\') "$wrapper contains no machine-specific user path"
}
$launcherText = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'Run-AIIntegrationRepair.vbs')
Assert-Repair ($launcherText -match 'shell\.Run\(command, 0, True\)') 'scheduled repair launcher uses a hidden window'
Assert-Repair ($launcherText -notmatch '(?i)[A-Z]:\\Users\\') 'scheduled repair launcher contains no machine-specific user path'
Assert-Repair (Test-Path -LiteralPath $statePath -PathType Leaf) 'machine-local install state exists'
if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    foreach ($client in @('claude', 'codex')) {
        $command = [string]$state.clients.$client.command
        Assert-Repair (-not [string]::IsNullOrWhiteSpace($command) -and (Test-Path -LiteralPath $command -PathType Leaf)) "real $client command exists"
        Assert-Repair (-not $command.StartsWith($wrapperRoot, [StringComparison]::OrdinalIgnoreCase)) "real $client command is not recursive"
    }
}
$resolvedClaude = Get-Command claude -ErrorAction SilentlyContinue | Select-Object -First 1
$resolvedCodex = Get-Command codex -ErrorAction SilentlyContinue | Select-Object -First 1
Assert-Repair ($null -ne $resolvedClaude -and [string]$resolvedClaude.Source -like "$wrapperRoot\*") 'claude resolves to startup wrapper in this process'
Assert-Repair ($null -ne $resolvedCodex -and [string]$resolvedCodex.Source -like "$wrapperRoot\*") 'codex resolves to startup wrapper in this process'

$task = Get-ScheduledTask -TaskName 'AIIntegrationRepair' -ErrorAction SilentlyContinue
Assert-Repair ($null -ne $task) 'scheduled repair task exists'
if ($null -ne $task) {
    Assert-Repair ([IO.Path]::GetFileName([string]$task.Actions[0].Execute) -ieq 'wscript.exe') 'scheduled repair task uses Windows Script Host'
    Assert-Repair ([string]$task.Actions[0].Arguments -match '(?i)//B\s+//Nologo.*Run-AIIntegrationRepair\.vbs') 'scheduled repair task uses the background launcher'
}

$repairResultText = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Repair-AIIntegrations.ps1')
Assert-Repair ($LASTEXITCODE -eq 0) 'repair exits successfully'
if ($repairResultText) {
    $repairResult = ($repairResultText -join [Environment]::NewLine) | ConvertFrom-Json
    Assert-Repair ($repairResult.Healthy -eq $true) 'repair reports healthy'
}

if ($failures.Count -gt 0) {
    $failures | ForEach-Object { [Console]::Error.WriteLine("FAIL: $_") }
    exit 1
}
[pscustomobject]@{ Passed = $passed; Repair = 'healthy'; Wrappers = 'portable'; State = 'machine-local' } | Format-List
