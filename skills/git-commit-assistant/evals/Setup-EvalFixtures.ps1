[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Workspace
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$toolkit = Join-Path $PSScriptRoot '..\scripts\CommitToolkit.ps1'
$hostExecutable = if ($PSVersionTable.PSEdition -eq 'Core') { Join-Path $PSHOME 'pwsh.exe' } else { Join-Path $PSHOME 'powershell.exe' }

function Run-Git {
    param([string]$Repo, [string[]]$Arguments)
    & git.exe --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=NUL -C $Repo @Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Git failed: $($Arguments -join ' ')" }
}

function Write-Text {
    param([string]$Path, [string]$Text)
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($Path)) | Out-Null
    [System.IO.File]::WriteAllText($Path, $Text, $utf8)
}

function Invoke-ToolkitJson {
    param([string]$Repo, [string]$Action, [string[]]$ExtraArguments = @())
    $output = & $hostExecutable -NoProfile -ExecutionPolicy Bypass -File $toolkit -Action $Action -Repository $Repo @ExtraArguments
    if ($LASTEXITCODE -ne 0) { throw "Fixture toolkit action failed: $Action $($output -join '')" }
    return (($output -join [Environment]::NewLine) | ConvertFrom-Json)
}

function New-Repo {
    param([string]$Path)
    [System.IO.Directory]::CreateDirectory($Path) | Out-Null
    Run-Git $Path @('init', '-q')
    Run-Git $Path @('config', 'user.name', 'Eval User')
    Run-Git $Path @('config', 'user.email', 'eval@example.invalid')
    Run-Git $Path @('config', 'core.autocrlf', 'false')
}

function Commit-All {
    param([string]$Repo, [string]$Message)
    Run-Git $Repo @('add', '--all')
    Run-Git $Repo @('commit', '-q', '-m', $Message)
}

function New-UnityFixture {
    param([string]$Repo)
    New-Repo $Repo
    Write-Text (Join-Path $Repo '.git-commit-assistant.json') "{`n  `"xmlElementOnlyPaths`": [`"Assets/Data/*.xml`"]`n}`n"
    $cs = @('class Player {', '    int Health = 100;') + @(1..12 | ForEach-Object { "    int Pad$_ = $_;" }) + @('    void Heal() {', '        Health++;', '    }', '}')
    Write-Text (Join-Path $Repo 'Assets\Scripts\Player.cs') (($cs -join "`r`n") + "`r`n")
    Write-Text (Join-Path $Repo 'Assets\Lua\player.lua') "local speed = 5`nreturn speed`n"
    Write-Text (Join-Path $Repo 'Assets\Data\config.xml') "<config>`n  <speed>5</speed>`n</config>`n"
    Write-Text (Join-Path $Repo 'README.md') "# Demo`n"
    Commit-All $Repo 'feat(game): add player data'
    Write-Text (Join-Path $Repo 'README.md') "# Demo`n`nInitial notes.`n"
    Commit-All $Repo 'docs: add project notes'
    $changed = [System.Collections.Generic.List[string]]::new()
    foreach ($line in $cs) { $changed.Add($line) }
    $changed[1] = '    int Health = 120;'
    $changed.Insert(14, '')
    Write-Text (Join-Path $Repo 'Assets\Scripts\Player.cs') (($changed -join "`r`n") + "`r`n")
    Write-Text (Join-Path $Repo 'Assets\Lua\player.lua') "local speed = 7`n`nreturn speed`n"
    Write-Text (Join-Path $Repo 'Assets\Data\config.xml') "<config>`n`n  <speed>7</speed>`n</config>`n"
    Write-Text (Join-Path $Repo 'README.md') "# Demo`n`nInitial notes.`n`nControls updated.`n"
}

function New-NoiseFixture {
    param([string]$Repo)
    New-Repo $Repo
    Write-Text (Join-Path $Repo 'Game.cs') "class Game {`r`n    int Score = 1;`r`n    void Run() {`r`n        Score++;`r`n    }`r`n}`r`n"
    Write-Text (Join-Path $Repo 'settings.json') "{`n  `"volume`": 5`n}`n"
    Write-Text (Join-Path $Repo 'README.md') "# Game`n`nKeep this paragraph.`n"
    Commit-All $Repo 'fix: establish game defaults'
    Write-Text (Join-Path $Repo 'Game.cs') "class Game {`n    int Score = 2;`n    void Run() {`n`n        Score++;`n    }`n}`n"
    Write-Text (Join-Path $Repo 'settings.json') "{`n`n  `"volume`": 5`n}`n"
    Write-Text (Join-Path $Repo 'README.md') "# Game  `n`nKeep this paragraph.`n"
}

function New-ResumeFixture {
    param([string]$Repo)
    New-Repo $Repo
    Write-Text (Join-Path $Repo 'one.txt') "one`n"
    Write-Text (Join-Path $Repo 'two.txt') "two`n"
    Commit-All $Repo 'feat: add files'
    Write-Text (Join-Path $Repo 'one.txt') "one changed`n"
    Write-Text (Join-Path $Repo 'two.txt') "two changed`n"
    $analysis = Invoke-ToolkitJson -Repo $Repo -Action Analyze
    if (-not $analysis.ok) { throw 'Fixture Analyze failed.' }
    $planInput = Join-Path ([System.IO.Path]::GetTempPath()) ('git-commit-assistant-eval-plan-' + [Guid]::NewGuid().ToString('N') + '.json')
    $plan = [pscustomobject]@{
        schemaVersion = 1
        baseHead = $analysis.summary.head
        groups = @(
            [pscustomobject]@{ id = 'one'; intent = 'update one'; paths = @('one.txt'); message = 'fix: update one'; dependencies = @(); validation = 'none' },
            [pscustomobject]@{ id = 'two'; intent = 'update two'; paths = @('two.txt'); message = 'fix: update two'; dependencies = @(); validation = 'none' }
        )
    }
    [System.IO.File]::WriteAllText($planInput, ($plan | ConvertTo-Json -Depth 10), $utf8)
    $save = Invoke-ToolkitJson -Repo $Repo -Action SavePlan -ExtraArguments @('-PlanPath', $planInput)
    [System.IO.File]::Delete($planInput)
    if (-not $save.ok) { throw 'Fixture SavePlan failed.' }
    $stateDir = Join-Path ((& git.exe -C $Repo rev-parse --absolute-git-dir).Trim()) 'git-commit-assistant'
    $planPath = Join-Path $stateDir 'plan.json'
    $statePath = Join-Path $stateDir 'state.json'
    $savedPlan = [System.IO.File]::ReadAllText($planPath, $utf8) | ConvertFrom-Json
    $savedState = [System.IO.File]::ReadAllText($statePath, $utf8) | ConvertFrom-Json
    $savedPlan.groups[0].state = 'pending-confirmation'
    $savedState.status = 'pending-confirmation'
    $savedState.pendingLaunch = [pscustomobject]@{
        launchId = 'eval'
        groupId = 'one'
        expectedParent = $analysis.summary.head
        processId = 2147483647
        processStartUtc = '2000-01-01T00:00:00.0000000Z'
        messagePath = ''
    }
    [System.IO.File]::WriteAllText($planPath, ($savedPlan | ConvertTo-Json -Depth 20 -Compress), $utf8)
    [System.IO.File]::WriteAllText($statePath, ($savedState | ConvertTo-Json -Depth 20 -Compress), $utf8)
}

[System.IO.Directory]::CreateDirectory($Workspace) | Out-Null
$specs = @(
    [pscustomobject]@{ Directory = 'eval-1-unity'; Builder = 'unity' },
    [pscustomobject]@{ Directory = 'eval-2-noise'; Builder = 'noise' },
    [pscustomobject]@{ Directory = 'eval-3-resume'; Builder = 'resume' }
)
foreach ($spec in $specs) {
    $evalRoot = Join-Path $Workspace $spec.Directory
    foreach ($configuration in @('with_skill', 'without_skill')) {
        $runRoot = Join-Path $evalRoot $configuration
        [System.IO.Directory]::CreateDirectory((Join-Path $runRoot 'outputs')) | Out-Null
        $repo = Join-Path $runRoot 'repo'
        switch ($spec.Builder) {
            'unity' { New-UnityFixture $repo }
            'noise' { New-NoiseFixture $repo }
            'resume' { New-ResumeFixture $repo }
        }
    }
}
