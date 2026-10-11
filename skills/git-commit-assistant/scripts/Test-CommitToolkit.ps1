[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$script:Toolkit = Join-Path $PSScriptRoot 'CommitToolkit.ps1'
$script:HostExecutable = if ($PSVersionTable.PSEdition -eq 'Core') {
    Join-Path $PSHOME 'pwsh.exe'
}
else {
    Join-Path $PSHOME 'powershell.exe'
}
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:Passed = 0
$script:Failed = 0

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}

function Assert-Equal {
    param([object]$Expected, [object]$Actual, [string]$Message)
    if ($Expected -cne $Actual) {
        throw "ASSERTION FAILED: $Message. Expected '$Expected', got '$Actual'."
    }
}

function Invoke-TestGit {
    param([string]$Repo, [string[]]$Arguments, [switch]$AllowFailure)
    $all = @('--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=NUL', '-C', $Repo) + $Arguments
    $output = & git.exe @all 2>&1
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0 -and -not $AllowFailure) {
        throw "Test Git failed ($exitCode): $($output -join [Environment]::NewLine)"
    }
    return [pscustomobject]@{ ExitCode = $exitCode; Output = @($output) }
}

function New-TestRepository {
    param([string]$Name)
    $root = Join-Path ([System.IO.Path]::GetTempPath()) ('git-commit-assistant-' + $Name + '-' + [Guid]::NewGuid().ToString('N'))
    [System.IO.Directory]::CreateDirectory($root) | Out-Null
    $null = Invoke-TestGit -Repo $root -Arguments @('init', '-q')
    $null = Invoke-TestGit -Repo $root -Arguments @('config', 'user.name', 'Toolkit Test')
    $null = Invoke-TestGit -Repo $root -Arguments @('config', 'user.email', 'toolkit@example.invalid')
    $null = Invoke-TestGit -Repo $root -Arguments @('config', 'core.autocrlf', 'false')
    return $root
}

function Remove-TestRepository {
    param([string]$Path)
    $full = [System.IO.Path]::GetFullPath($Path)
    $prefix = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) 'git-commit-assistant-'))
    if (-not $full.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove a path outside the test prefix: $full"
    }
    if (-not [System.IO.Directory]::Exists($full)) { return }
    foreach ($file in [System.IO.Directory]::GetFiles($full, '*', [System.IO.SearchOption]::AllDirectories)) {
        [System.IO.File]::SetAttributes($file, [System.IO.FileAttributes]::Normal)
    }
    [System.IO.Directory]::Delete($full, $true)
}

function Write-Utf8 {
    param([string]$Path, [string]$Text)
    $directory = [System.IO.Path]::GetDirectoryName($Path)
    [System.IO.Directory]::CreateDirectory($directory) | Out-Null
    [System.IO.File]::WriteAllText($Path, $Text, $script:Utf8NoBom)
}

function Invoke-Toolkit {
    param(
        [string]$Repo,
        [string]$Action,
        [hashtable]$Parameters = @{},
        [switch]$ExpectFailure
    )
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script:Toolkit, '-Action', $Action, '-Repository', $Repo)
    foreach ($entry in $Parameters.GetEnumerator()) {
        if ($entry.Value -is [bool]) {
            if ($entry.Value) { $arguments += ('-' + $entry.Key) }
        }
        elseif ($entry.Value -is [array]) {
            $arguments += ('-' + $entry.Key)
            $arguments += @($entry.Value)
        }
        else {
            $arguments += ('-' + $entry.Key)
            $arguments += [string]$entry.Value
        }
    }
    $stderrPath = Join-Path ([System.IO.Path]::GetTempPath()) ('git-commit-assistant-stderr-' + [Guid]::NewGuid().ToString('N') + '.txt')
    try {
        $stdout = & $script:HostExecutable @arguments 2> $stderrPath
        $exitCode = $LASTEXITCODE
        if (-not $ExpectFailure -and $exitCode -ne 0) {
            $stderr = if ([System.IO.File]::Exists($stderrPath)) { [System.IO.File]::ReadAllText($stderrPath) } else { '' }
            throw "Toolkit action $Action failed ($exitCode): $($stdout -join '') $stderr"
        }
        if ($ExpectFailure -and $exitCode -eq 0) {
            throw "Toolkit action $Action unexpectedly succeeded."
        }
        $jsonText = ($stdout -join [Environment]::NewLine).Trim()
        Assert-True (-not [string]::IsNullOrEmpty($jsonText)) "Toolkit action $Action returned no JSON"
        return ($jsonText | ConvertFrom-Json)
    }
    finally {
        if ([System.IO.File]::Exists($stderrPath)) { [System.IO.File]::Delete($stderrPath) }
    }
}

function Get-IndexHash {
    param([string]$Repo)
    $path = (Invoke-TestGit -Repo $Repo -Arguments @('rev-parse', '--git-path', 'index')).Output[0]
    if (-not [System.IO.Path]::IsPathRooted($path)) { $path = Join-Path $Repo $path }
    if (-not [System.IO.File]::Exists($path)) { return $null }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::OpenRead($path)
        try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '') }
        finally { $stream.Dispose() }
    }
    finally { $sha.Dispose() }
}

function Commit-All {
    param([string]$Repo, [string]$Message)
    $null = Invoke-TestGit -Repo $Repo -Arguments @('add', '--all')
    $null = Invoke-TestGit -Repo $Repo -Arguments @('commit', '-q', '-m', $Message)
}

function Invoke-TestCase {
    param([string]$Name, [scriptblock]$Body)
    try {
        & $Body
        $script:Passed++
        Write-Host "PASS $Name"
    }
    catch {
        $script:Failed++
        Write-Host "FAIL $Name"
        Write-Host $_.Exception.ToString()
    }
}

$savedEnvironment = @{}
foreach ($name in @('GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_ATTR_NOSYSTEM', 'GIT_TERMINAL_PROMPT')) {
    $savedEnvironment[$name] = [System.Environment]::GetEnvironmentVariable($name, 'Process')
}
[System.Environment]::SetEnvironmentVariable('GIT_CONFIG_NOSYSTEM', '1', 'Process')
[System.Environment]::SetEnvironmentVariable('GIT_CONFIG_GLOBAL', 'NUL', 'Process')
[System.Environment]::SetEnvironmentVariable('GIT_CONFIG_SYSTEM', 'NUL', 'Process')
[System.Environment]::SetEnvironmentVariable('GIT_ATTR_NOSYSTEM', '1', 'Process')
[System.Environment]::SetEnvironmentVariable('GIT_TERMINAL_PROMPT', '0', 'Process')

try {
    Invoke-TestCase 'analyze is compact and preserves index' {
        $repo = New-TestRepository 'analyze'
        try {
            Write-Utf8 (Join-Path $repo 'sample.cs') "class Sample {`r`n    int Value = 1;`r`n}`r`n"
            Commit-All $repo 'feat: add sample'
            Write-Utf8 (Join-Path $repo 'sample.cs') "class Sample {`r`n    int Value = 2;`r`n}`r`n"
            $before = Get-IndexHash $repo
            $result = Invoke-Toolkit -Repo $repo -Action Analyze
            Assert-True $result.ok 'Analyze should succeed'
            Assert-Equal 1 $result.summary.fileCount 'Analyze should report one file'
            Assert-Equal $before (Get-IndexHash $repo) 'Analyze must not change index bytes'
            Assert-True ($result.summary.recentSubjects -contains 'feat: add sample') 'Recent message style should be captured'
        }
        finally { Remove-TestRepository $repo }
    }

    Invoke-TestCase 'normalization restores EOL-only change exactly' {
        $repo = New-TestRepository 'eol'
        try {
            $path = Join-Path $repo 'line.cs'
            $base = "class Line {`r`n    int X = 1;`r`n}`r`n"
            Write-Utf8 $path $base
            Commit-All $repo 'feat: add line'
            Write-Utf8 $path ($base.Replace("`r`n", "`n"))
            $before = Get-IndexHash $repo
            $result = Invoke-Toolkit -Repo $repo -Action Normalize
            Assert-True $result.ok 'Normalize should succeed'
            Assert-Equal 1 $result.summary.changedCount 'EOL-only file should change'
            Assert-Equal $base ([System.IO.File]::ReadAllText($path, $script:Utf8NoBom)) 'Exact base line endings should be restored'
            Assert-Equal $before (Get-IndexHash $repo) 'Normalize must not change index bytes'
        }
        finally { Remove-TestRepository $repo }
    }

    Invoke-TestCase 'recovery restores only the exact interrupted write' {
        $repo = New-TestRepository 'recovery-conflict'
        try {
            $path = Join-Path $repo 'recovery.txt'
            Write-Utf8 $path "base`n"
            Commit-All $repo 'feat: add recovery file'
            $null = Invoke-Toolkit -Repo $repo -Action Analyze

            $gitDir = (Invoke-TestGit -Repo $repo -Arguments @('rev-parse', '--absolute-git-dir')).Output[0]
            $stateDir = Join-Path $gitDir 'git-commit-assistant'
            $backupDir = Join-Path $stateDir 'backup'
            [System.IO.Directory]::CreateDirectory($backupDir) | Out-Null
            $backupPath = Join-Path $backupDir 'recovery.bak'
            Write-Utf8 $backupPath "base`n"
            Write-Utf8 $path "normalized`n"
            $journal = [pscustomobject]@{
                schemaVersion = 1
                status = 'pending'
                targetPath = $path
                backupPath = $backupPath
                originalSha256 = (Get-FileHash -LiteralPath $backupPath -Algorithm SHA256).Hash.ToLowerInvariant()
                expectedSha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
            }
            $journalPath = Join-Path $stateDir 'normalization-journal.json'
            [System.IO.File]::WriteAllText($journalPath, ($journal | ConvertTo-Json -Compress), $script:Utf8NoBom)

            $restored = Invoke-Toolkit -Repo $repo -Action Analyze
            Assert-True $restored.ok 'Analyze should recover an exact interrupted write'
            Assert-Equal "base`n" ([System.IO.File]::ReadAllText($path, $script:Utf8NoBom)) 'Recovery should restore the proven original bytes'
            Assert-True (-not [System.IO.File]::Exists($journalPath)) 'Successful recovery should clear the journal'

            Write-Utf8 $path "normalized`n"
            [System.IO.File]::WriteAllText($journalPath, ($journal | ConvertTo-Json -Compress), $script:Utf8NoBom)
            Write-Utf8 $path "later user edit`n"
            $result = Invoke-Toolkit -Repo $repo -Action Status -ExpectFailure
            Assert-Equal 'RECOVERY_CONFLICT' $result.errors[0].code 'Recovery should stop on third-party drift'
            Assert-Equal "later user edit`n" ([System.IO.File]::ReadAllText($path, $script:Utf8NoBom)) 'Recovery must preserve the later edit'
            Assert-True ([System.IO.File]::Exists($journalPath)) 'Conflicted recovery journal should remain for manual review'
        }
        finally { Remove-TestRepository $repo }
    }

    Invoke-TestCase 'CSharp blank hunk is removed while semantic edit remains' {
        $repo = New-TestRepository 'csharp'
        try {
            $path = Join-Path $repo 'logic.cs'
            $baseLines = @('class Logic {', '    int Value = 1;') + @(1..15 | ForEach-Object { "    int Pad$_ = $_;" }) + @('    void Run() {', '        Value++;', '    }', '}')
            Write-Utf8 $path (($baseLines -join "`r`n") + "`r`n")
            Commit-All $repo 'feat: add logic'
            $current = [System.Collections.Generic.List[string]]::new()
            foreach ($line in $baseLines) { $current.Add($line) }
            $current[1] = '    int Value = 2;'
            $current.Insert(18, '')
            Write-Utf8 $path (($current -join "`r`n") + "`r`n")
            $result = Invoke-Toolkit -Repo $repo -Action Normalize
            Assert-True $result.ok 'Normalize should succeed'
            $text = [System.IO.File]::ReadAllText($path, $script:Utf8NoBom)
            Assert-True ($text.Contains('int Value = 2;')) 'Semantic edit should remain'
            Assert-True (-not $text.Contains("`r`n`r`n    void Run")) 'Independent blank hunk should be removed'
        }
        finally { Remove-TestRepository $repo }
    }

    Invoke-TestCase 'CSharp raw string region is not normalized' {
        $repo = New-TestRepository 'raw'
        try {
            $path = Join-Path $repo 'raw.cs'
            $base = (@('class Raw {', '    string Text = """', 'alpha', 'beta', '""";', '}') -join "`r`n") + "`r`n"
            Write-Utf8 $path $base
            Commit-All $repo 'feat: add raw string'
            $current = $base.Replace("alpha`r`nbeta", "alpha`r`n`r`nbeta")
            Write-Utf8 $path $current
            $result = Invoke-Toolkit -Repo $repo -Action Normalize
            Assert-True $result.ok 'Normalize should complete with a skip'
            Assert-Equal $current ([System.IO.File]::ReadAllText($path, $script:Utf8NoBom)) 'Raw string whitespace must remain byte-equivalent'
        }
        finally { Remove-TestRepository $repo }
    }

    Invoke-TestCase 'Lua blank hunk is removed outside sensitive regions' {
        $repo = New-TestRepository 'lua'
        try {
            $path = Join-Path $repo 'logic.lua'
            $baseLines = @('local value = 1') + @(1..12 | ForEach-Object { "local pad$_ = $_" }) + @('return value')
            Write-Utf8 $path (($baseLines -join "`n") + "`n")
            Commit-All $repo 'feat: add Lua logic'
            $current = [System.Collections.Generic.List[string]]::new()
            foreach ($line in $baseLines) { $current.Add($line) }
            $current[0] = 'local value = 2'
            $current.Insert(13, '')
            Write-Utf8 $path (($current -join "`n") + "`n")
            $result = Invoke-Toolkit -Repo $repo -Action Normalize
            Assert-True $result.ok 'Lua normalization should succeed'
            $text = [System.IO.File]::ReadAllText($path, $script:Utf8NoBom)
            Assert-True $text.Contains('local value = 2') 'Lua semantic edit should remain'
            Assert-True (-not $text.Contains("`n`nreturn value")) 'Safe Lua blank hunk should be removed'
        }
        finally { Remove-TestRepository $repo }
    }

    Invoke-TestCase 'save plan and dry-run produce exact TortoiseGit arguments' {
        $repo = New-TestRepository 'plan'
        try {
            $path = Join-Path $repo 'feature.cs'
            Write-Utf8 $path "class Feature {`r`n    int Value = 1;`r`n}`r`n"
            Commit-All $repo 'feat: add feature'
            Write-Utf8 $path "class Feature {`r`n    int Value = 2;`r`n}`r`n"
            $analysis = Invoke-Toolkit -Repo $repo -Action Analyze
            $planPath = Join-Path ([System.IO.Path]::GetTempPath()) ('git-commit-assistant-plan-input-' + [Guid]::NewGuid().ToString('N') + '.json')
            $plan = [pscustomobject]@{
                schemaVersion = 1
                baseHead = $analysis.summary.head
                groups = @([pscustomobject]@{
                    id = 'feature'
                    intent = 'update feature value'
                    paths = @('feature.cs')
                    message = 'feat: update feature value'
                    dependencies = @()
                    validation = 'none'
                })
            }
            [System.IO.File]::WriteAllText($planPath, ($plan | ConvertTo-Json -Depth 10), $script:Utf8NoBom)
            $save = Invoke-Toolkit -Repo $repo -Action SavePlan -Parameters @{ PlanPath = $planPath }
            Assert-True $save.ok 'SavePlan should succeed'
            [System.IO.File]::Delete($planPath)
            $open = Invoke-Toolkit -Repo $repo -Action OpenNext -Parameters @{ Validation = 'none'; DryRun = $true }
            Assert-True $open.ok 'OpenNext dry-run should succeed'
            Assert-Equal '/command:commit' $open.summary.arguments[0] 'First TortoiseGit argument should be logical and unquoted'
            Assert-True ([string]$open.summary.arguments[1]).StartsWith('/path:') 'Path argument should be exact'
            Assert-True ([string]$open.summary.arguments[1]).Contains($path) 'Path argument should contain the selected absolute file'
            Assert-Equal 1 ((Invoke-TestGit -Repo $repo -Arguments @('rev-list', '--count', 'HEAD')).Output[0]) 'Toolkit must not create a commit'
        }
        finally { Remove-TestRepository $repo }
    }

    Invoke-TestCase 'staged changes block normalization' {
        $repo = New-TestRepository 'staged'
        try {
            $path = Join-Path $repo 'staged.lua'
            Write-Utf8 $path "return 1`n"
            Commit-All $repo 'feat: add Lua'
            Write-Utf8 $path "return 2`n"
            $null = Invoke-TestGit -Repo $repo -Arguments @('add', 'staged.lua')
            $before = Get-IndexHash $repo
            $result = Invoke-Toolkit -Repo $repo -Action Normalize -ExpectFailure
            Assert-Equal 'INDEX_NOT_CLEAN' $result.errors[0].code 'Staged changes should stop normalization'
            Assert-Equal $before (Get-IndexHash $repo) 'Rejected normalization must preserve index bytes'
        }
        finally { Remove-TestRepository $repo }
    }

    Invoke-TestCase 'validation none cannot bypass secret scanning' {
        $repo = New-TestRepository 'secret'
        try {
            $path = Join-Path $repo 'settings.json'
            Write-Utf8 $path "{`n  `"enabled`": true`n}`n"
            Commit-All $repo 'feat: add settings'
            Write-Utf8 $path "{`n  `"enabled`": true,`n  `"api_key`": `"supersecretvalue`"`n}`n"
            $analysis = Invoke-Toolkit -Repo $repo -Action Analyze
            $planPath = Join-Path ([System.IO.Path]::GetTempPath()) ('git-commit-assistant-secret-plan-' + [Guid]::NewGuid().ToString('N') + '.json')
            $plan = [pscustomobject]@{
                schemaVersion = 1
                baseHead = $analysis.summary.head
                groups = @([pscustomobject]@{
                    id = 'settings'
                    intent = 'update settings'
                    paths = @('settings.json')
                    message = 'feat: update settings'
                    dependencies = @()
                    validation = 'none'
                })
            }
            [System.IO.File]::WriteAllText($planPath, ($plan | ConvertTo-Json -Depth 10), $script:Utf8NoBom)
            $null = Invoke-Toolkit -Repo $repo -Action SavePlan -Parameters @{ PlanPath = $planPath }
            [System.IO.File]::Delete($planPath)
            $blocked = Invoke-Toolkit -Repo $repo -Action OpenNext -Parameters @{ Validation = 'none'; DryRun = $true } -ExpectFailure
            Assert-Equal 'SECRET_REVIEW_REQUIRED' $blocked.errors[0].code 'Mandatory secret scanning must remain active'
            Assert-True ($null -eq $blocked.errors[0].details[0].PSObject.Properties['value']) 'Secret value must not be returned'
        }
        finally { Remove-TestRepository $repo }
    }

    Invoke-TestCase 'resume accepts only the exact planned commit' {
        $repo = New-TestRepository 'resume'
        try {
            $path = Join-Path $repo 'resume.txt'
            Write-Utf8 $path "before`n"
            Commit-All $repo 'feat: add resume file'
            Write-Utf8 $path "after`n"
            $analysis = Invoke-Toolkit -Repo $repo -Action Analyze
            $planInput = Join-Path ([System.IO.Path]::GetTempPath()) ('git-commit-assistant-resume-plan-' + [Guid]::NewGuid().ToString('N') + '.json')
            $input = [pscustomobject]@{
                schemaVersion = 1
                baseHead = $analysis.summary.head
                groups = @([pscustomobject]@{
                    id = 'resume'
                    intent = 'update resume file'
                    paths = @('resume.txt')
                    message = 'feat: update resume file'
                    dependencies = @()
                    validation = 'none'
                })
            }
            [System.IO.File]::WriteAllText($planInput, ($input | ConvertTo-Json -Depth 10), $script:Utf8NoBom)
            $save = Invoke-Toolkit -Repo $repo -Action SavePlan -Parameters @{ PlanPath = $planInput }
            [System.IO.File]::Delete($planInput)
            $planPath = $save.summary.planPath
            $statePath = Join-Path ([System.IO.Path]::GetDirectoryName($planPath)) 'state.json'
            $plan = [System.IO.File]::ReadAllText($planPath, $script:Utf8NoBom) | ConvertFrom-Json
            $state = [System.IO.File]::ReadAllText($statePath, $script:Utf8NoBom) | ConvertFrom-Json
            $plan.groups[0].state = 'pending-confirmation'
            $state.status = 'pending-confirmation'
            $state.pendingLaunch = [pscustomobject]@{
                launchId = 'test'
                groupId = 'resume'
                expectedParent = $analysis.summary.head
                processId = 2147483647
                processStartUtc = '2000-01-01T00:00:00.0000000Z'
                messagePath = ''
            }
            [System.IO.File]::WriteAllText($planPath, ($plan | ConvertTo-Json -Depth 20 -Compress), $script:Utf8NoBom)
            [System.IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Depth 20 -Compress), $script:Utf8NoBom)
            Commit-All $repo 'feat: update resume file'
            $result = Invoke-Toolkit -Repo $repo -Action OpenNext -Parameters @{ Validation = 'none'; DryRun = $true }
            Assert-True $result.ok 'Exact planned commit should be accepted'
            Assert-True $result.summary.complete 'Single-group plan should complete'
            Assert-Equal 1 $result.summary.commits.Count 'Completed commit should be recorded'
        }
        finally { Remove-TestRepository $repo }
    }

    Invoke-TestCase 'configured fsmonitor is never executed' {
        $repo = New-TestRepository 'fsmonitor'
        try {
            $sentinel = Join-Path $repo 'fsmonitor-ran.txt'
            $hook = Join-Path $repo 'evil-fsmonitor.cmd'
            Write-Utf8 $hook ((('@echo executed>"{0}"' -f $sentinel)) + "`r`n@exit /b 0`r`n")
            $null = Invoke-TestGit -Repo $repo -Arguments @('config', 'core.fsmonitor', $hook)
            Write-Utf8 (Join-Path $repo 'a.txt') "base`n"
            Commit-All $repo 'feat: add file'
            Write-Utf8 (Join-Path $repo 'a.txt') "changed`n"
            $result = Invoke-Toolkit -Repo $repo -Action Analyze
            Assert-True $result.ok 'Analyze should succeed with fsmonitor configured'
            Assert-True (-not [System.IO.File]::Exists($sentinel)) 'fsmonitor sentinel must not execute'
        }
        finally { Remove-TestRepository $repo }
    }
}
finally {
    foreach ($entry in $savedEnvironment.GetEnumerator()) {
        [System.Environment]::SetEnvironmentVariable([string]$entry.Key, $entry.Value, 'Process')
    }
}

Write-Host "RESULT passed=$($script:Passed) failed=$($script:Failed)"
if ($script:Failed -gt 0) { exit 1 }
