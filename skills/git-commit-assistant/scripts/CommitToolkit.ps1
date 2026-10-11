[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Analyze', 'Normalize', 'SavePlan', 'OpenNext', 'Status', 'Clear')]
    [string]$Action,

    [Parameter(Mandatory = $true)]
    [string]$Repository,

    [string]$OutputPath,
    [string[]]$Extensions,
    [string]$PlanPath,

    [ValidateSet('light', 'auto', 'full', 'none')]
    [string]$Validation,

    [string]$ValidationApprovalId,
    [switch]$ConfirmCancelled,
    [switch]$DryRun
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$script:SchemaVersion = 1
$script:MaxTextBytes = 4MB
$script:MaxNormalizeLines = 20000
$script:MaxCommandLineUnits = 30000
$script:DefaultExtensions = @(
    '.cs', '.lua', '.xml', '.json', '.jsonc', '.md', '.yml', '.yaml', '.toml',
    '.ps1', '.cmd', '.sh', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.css', '.scss',
    '.shader', '.cginc', '.hlsl', '.txt'
)
$script:Utf8Strict = New-Object System.Text.UTF8Encoding($false, $true)
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:Utf8Bom = New-Object System.Text.UTF8Encoding($true)

function Throw-ToolkitError {
    param([string]$Code, [string]$Message, [object]$Details = $null)
    $exception = New-Object System.InvalidOperationException($Message)
    $exception.Data['ToolkitCode'] = $Code
    if ($null -ne $Details) {
        $exception.Data['ToolkitDetails'] = $Details
    }
    throw $exception
}

function ConvertTo-JsonText {
    param([object]$Value)
    return ($Value | ConvertTo-Json -Depth 20 -Compress)
}

function Write-AtomicText {
    param(
        [string]$Path,
        [string]$Text,
        [System.Text.Encoding]$Encoding = $script:Utf8NoBom
    )

    $directory = [System.IO.Path]::GetDirectoryName($Path)
    if (-not [string]::IsNullOrEmpty($directory)) {
        [System.IO.Directory]::CreateDirectory($directory) | Out-Null
    }

    $tempPath = Join-Path $directory ('.tmp-' + [Guid]::NewGuid().ToString('N'))
    try {
        [System.IO.File]::WriteAllText($tempPath, $Text, $Encoding)
        if ([System.IO.File]::Exists($Path)) {
            $backupPath = Join-Path $directory ('.replace-' + [Guid]::NewGuid().ToString('N'))
            try {
                [System.IO.File]::Replace($tempPath, $Path, $backupPath, $true)
                if ([System.IO.File]::Exists($backupPath)) {
                    [System.IO.File]::Delete($backupPath)
                }
            }
            finally {
                if ([System.IO.File]::Exists($backupPath)) {
                    [System.IO.File]::Delete($backupPath)
                }
            }
        }
        else {
            [System.IO.File]::Move($tempPath, $Path)
        }
    }
    finally {
        if ([System.IO.File]::Exists($tempPath)) {
            [System.IO.File]::Delete($tempPath)
        }
    }
}

function Write-AtomicJson {
    param([string]$Path, [object]$Value)
    Write-AtomicText -Path $Path -Text (ConvertTo-JsonText $Value) -Encoding $script:Utf8NoBom
}

function Get-FileSha256 {
    param([string]$Path)
    if (-not [System.IO.File]::Exists($Path)) {
        return $null
    }
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
        }
        finally {
            $sha.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
}

function Get-BytesSha256 {
    param([byte[]]$Bytes)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }
}

function ConvertTo-WindowsCommandLineArgument {
    param([AllowEmptyString()][string]$Argument)

    if ($Argument.Length -gt 0 -and $Argument -notmatch '[\s"]') {
        return $Argument
    }

    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('"')
    $slashes = 0
    foreach ($character in $Argument.ToCharArray()) {
        if ($character -eq '\') {
            $slashes++
            continue
        }
        if ($character -eq '"') {
            [void]$builder.Append(('\' * (($slashes * 2) + 1)))
            [void]$builder.Append('"')
            $slashes = 0
            continue
        }
        if ($slashes -gt 0) {
            [void]$builder.Append(('\' * $slashes))
            $slashes = 0
        }
        [void]$builder.Append($character)
    }
    if ($slashes -gt 0) {
        [void]$builder.Append(('\' * ($slashes * 2)))
    }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function ConvertTo-WindowsCommandLine {
    param([string[]]$Arguments)
    return (($Arguments | ForEach-Object { ConvertTo-WindowsCommandLineArgument ([string]$_) }) -join ' ')
}

function Invoke-NativeBytes {
    param(
        [string]$FileName,
        [string[]]$Arguments,
        [string]$WorkingDirectory,
        [byte[]]$InputBytes,
        [int]$TimeoutMilliseconds = 120000,
        [hashtable]$Environment = @{}
    )

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $FileName
    $startInfo.Arguments = ConvertTo-WindowsCommandLine $Arguments
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.RedirectStandardInput = $null -ne $InputBytes

    foreach ($name in @('GIT_EXTERNAL_DIFF', 'GIT_DIFF_OPTS', 'GIT_OPTIONAL_LOCKS', 'GIT_TRACE', 'GIT_TRACE2', 'GIT_TRACE_FSMONITOR')) {
        if ($startInfo.EnvironmentVariables.ContainsKey($name)) {
            $startInfo.EnvironmentVariables.Remove($name)
        }
    }
    $startInfo.EnvironmentVariables['GIT_OPTIONAL_LOCKS'] = '0'
    $startInfo.EnvironmentVariables['GIT_TERMINAL_PROMPT'] = '0'
    foreach ($entry in $Environment.GetEnumerator()) {
        if ($null -eq $entry.Value) {
            if ($startInfo.EnvironmentVariables.ContainsKey([string]$entry.Key)) {
                $startInfo.EnvironmentVariables.Remove([string]$entry.Key)
            }
        }
        else {
            $startInfo.EnvironmentVariables[[string]$entry.Key] = [string]$entry.Value
        }
    }

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    $stdout = New-Object System.IO.MemoryStream
    try {
        if (-not $process.Start()) {
            Throw-ToolkitError 'PROCESS_START_FAILED' "Failed to start $FileName."
        }
        $stdoutTask = $process.StandardOutput.BaseStream.CopyToAsync($stdout)
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if ($null -ne $InputBytes) {
            $process.StandardInput.BaseStream.Write($InputBytes, 0, $InputBytes.Length)
            $process.StandardInput.BaseStream.Flush()
            $process.StandardInput.Close()
        }
        if (-not $process.WaitForExit($TimeoutMilliseconds)) {
            try { $process.Kill() } catch {}
            Throw-ToolkitError 'PROCESS_TIMEOUT' "$FileName exceeded the configured timeout."
        }
        [System.Threading.Tasks.Task]::WaitAll(@($stdoutTask, $stderrTask))
        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            StdoutBytes = $stdout.ToArray()
            Stderr = $stderrTask.Result
        }
    }
    finally {
        $stdout.Dispose()
        $process.Dispose()
    }
}

function ConvertFrom-Utf8Bytes {
    param([byte[]]$Bytes)
    return $script:Utf8Strict.GetString($Bytes)
}

function Invoke-Git {
    param(
        [string]$Repo,
        [string[]]$Arguments,
        [switch]$AllowFailure,
        [byte[]]$InputBytes,
        [int]$TimeoutMilliseconds = 120000
    )

    $git = (Get-Command git.exe -ErrorAction SilentlyContinue)
    if ($null -eq $git) {
        $git = Get-Command git -ErrorAction SilentlyContinue
    }
    if ($null -eq $git) {
        Throw-ToolkitError 'GIT_NOT_FOUND' 'Git was not found on PATH.'
    }

    $safeArguments = @(
        '--no-optional-locks',
        '-c', 'core.fsmonitor=false',
        '-c', 'core.quotepath=false',
        '-c', 'core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol',
        '-C', $Repo
    )
    if ($Arguments.Count -gt 0 -and $Arguments[0] -eq 'diff') {
        $safeArguments += @('diff', '--no-ext-diff', '--no-textconv')
        if ($Arguments.Count -gt 1) {
            $safeArguments += $Arguments[1..($Arguments.Count - 1)]
        }
    }
    else {
        $safeArguments += $Arguments
    }

    $result = Invoke-NativeBytes -FileName $git.Source -Arguments $safeArguments -WorkingDirectory $Repo -InputBytes $InputBytes -TimeoutMilliseconds $TimeoutMilliseconds
    if ($result.ExitCode -ne 0 -and -not $AllowFailure) {
        $message = $result.Stderr.Trim()
        if ([string]::IsNullOrEmpty($message)) {
            $message = "Git exited with code $($result.ExitCode)."
        }
        Throw-ToolkitError 'GIT_COMMAND_FAILED' $message ([pscustomobject]@{ arguments = $Arguments; exitCode = $result.ExitCode })
    }
    return $result
}

function Get-GitText {
    param([string]$Repo, [string[]]$Arguments, [switch]$AllowFailure)
    $result = Invoke-Git -Repo $Repo -Arguments $Arguments -AllowFailure:$AllowFailure
    return [pscustomobject]@{
        ExitCode = $result.ExitCode
        Text = (ConvertFrom-Utf8Bytes $result.StdoutBytes)
        Stderr = $result.Stderr
    }
}

function Resolve-Repository {
    param([string]$Path)

    $candidate = [System.IO.Path]::GetFullPath($Path)
    if (-not [System.IO.Directory]::Exists($candidate)) {
        Throw-ToolkitError 'NOT_GIT_REPOSITORY' "Repository path does not exist: $candidate"
    }
    $rootResult = Get-GitText -Repo $candidate -Arguments @('rev-parse', '--show-toplevel') -AllowFailure
    if ($rootResult.ExitCode -ne 0) {
        Throw-ToolkitError 'NOT_GIT_REPOSITORY' "$candidate is not inside a Git worktree."
    }
    $root = [System.IO.Path]::GetFullPath($rootResult.Text.Trim())
    $gitDirResult = Get-GitText -Repo $root -Arguments @('rev-parse', '--absolute-git-dir')
    $gitDir = [System.IO.Path]::GetFullPath($gitDirResult.Text.Trim())
    $indexResult = Get-GitText -Repo $root -Arguments @('rev-parse', '--git-path', 'index')
    $indexPath = $indexResult.Text.Trim()
    if (-not [System.IO.Path]::IsPathRooted($indexPath)) {
        $indexPath = [System.IO.Path]::GetFullPath((Join-Path $root $indexPath))
    }
    return [pscustomobject]@{
        Root = $root
        GitDir = $gitDir
        IndexPath = $indexPath
        StateDir = Join-Path $gitDir 'git-commit-assistant'
    }
}

function Enter-ToolkitLock {
    param([object]$RepositoryInfo)
    [System.IO.Directory]::CreateDirectory($RepositoryInfo.StateDir) | Out-Null
    $lockPath = Join-Path $RepositoryInfo.StateDir 'lock'
    try {
        return [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    }
    catch {
        Throw-ToolkitError 'TOOLKIT_BUSY' 'Another Git commit assistant action is active for this worktree.'
    }
}

function Get-IndexHash {
    param([object]$RepositoryInfo)
    if (-not [System.IO.File]::Exists($RepositoryInfo.IndexPath)) {
        return $null
    }
    return Get-FileSha256 $RepositoryInfo.IndexPath
}

function Assert-IndexUnchanged {
    param([object]$RepositoryInfo, [string]$BeforeHash)
    $afterHash = Get-IndexHash $RepositoryInfo
    if ($BeforeHash -ne $afterHash) {
        Throw-ToolkitError 'INDEX_CHANGED' 'The Git index changed during a read-only toolkit action.'
    }
}

function Test-PathInsideRoot {
    param([string]$Root, [string]$Path)
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    $pathFull = [System.IO.Path]::GetFullPath($Path)
    return $pathFull.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)
}

function ConvertTo-RepoPath {
    param([string]$Root, [string]$FullPath)
    $rootUri = New-Object System.Uri(([System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'))
    $pathUri = New-Object System.Uri([System.IO.Path]::GetFullPath($FullPath))
    return [System.Uri]::UnescapeDataString($rootUri.MakeRelativeUri($pathUri).ToString()).Replace('\', '/')
}

function Get-RepositoryHead {
    param([string]$Repo)
    $result = Get-GitText -Repo $Repo -Arguments @('rev-parse', '--verify', 'HEAD') -AllowFailure
    if ($result.ExitCode -ne 0) { return $null }
    return $result.Text.Trim()
}

function Get-RepositoryBranch {
    param([string]$Repo)
    $result = Get-GitText -Repo $Repo -Arguments @('symbolic-ref', '--quiet', '--short', 'HEAD') -AllowFailure
    if ($result.ExitCode -ne 0) { return $null }
    return $result.Text.Trim()
}

function Get-OperationState {
    param([object]$RepositoryInfo)
    $checks = [ordered]@{
        merge = 'MERGE_HEAD'
        cherryPick = 'CHERRY_PICK_HEAD'
        revert = 'REVERT_HEAD'
        rebaseMerge = 'rebase-merge'
        rebaseApply = 'rebase-apply'
        bisect = 'BISECT_START'
    }
    $active = @()
    foreach ($entry in $checks.GetEnumerator()) {
        $pathResult = Get-GitText -Repo $RepositoryInfo.Root -Arguments @('rev-parse', '--git-path', $entry.Value)
        $path = $pathResult.Text.Trim()
        if (-not [System.IO.Path]::IsPathRooted($path)) {
            $path = Join-Path $RepositoryInfo.Root $path
        }
        if ([System.IO.File]::Exists($path) -or [System.IO.Directory]::Exists($path)) {
            $active += $entry.Key
        }
    }
    return @($active)
}

function Get-WorktreeStatus {
    param([string]$Repo)

    $result = Invoke-Git -Repo $Repo -Arguments @('status', '--porcelain=v2', '-z', '--untracked-files=all')
    $text = ConvertFrom-Utf8Bytes $result.StdoutBytes
    $records = $text.Split([char]0)
    $entries = New-Object System.Collections.ArrayList
    $index = 0
    while ($index -lt $records.Length) {
        $record = $records[$index]
        $index++
        if ([string]::IsNullOrEmpty($record)) { continue }

        $kind = $record.Substring(0, 1)
        $path = $null
        $originalPath = $null
        $xy = '..'
        $submodule = $false
        switch ($kind) {
            '1' {
                $parts = $record -split ' ', 9
                if ($parts.Count -lt 9) { Throw-ToolkitError 'STATUS_PARSE_FAILED' 'Could not parse a porcelain-v2 ordinary entry.' }
                $xy = $parts[1]
                $submodule = $parts[2] -ne 'N...'
                $path = $parts[8]
            }
            '2' {
                $parts = $record -split ' ', 10
                if ($parts.Count -lt 10 -or $index -ge $records.Length) { Throw-ToolkitError 'STATUS_PARSE_FAILED' 'Could not parse a porcelain-v2 rename entry.' }
                $xy = $parts[1]
                $submodule = $parts[2] -ne 'N...'
                $path = $parts[9]
                $originalPath = $records[$index]
                $index++
            }
            'u' {
                $parts = $record -split ' ', 11
                if ($parts.Count -lt 11) { Throw-ToolkitError 'STATUS_PARSE_FAILED' 'Could not parse a porcelain-v2 conflict entry.' }
                $xy = $parts[1]
                $path = $parts[10]
            }
            '?' {
                $xy = '??'
                $path = $record.Substring(2)
            }
            '!' { continue }
            default { continue }
        }

        $fullPath = [System.IO.Path]::GetFullPath((Join-Path $Repo ($path.Replace('/', '\'))))
        if (-not (Test-PathInsideRoot -Root $Repo -Path $fullPath)) {
            Throw-ToolkitError 'PATH_OUTSIDE_WORKTREE' "Git reported a path outside the worktree: $path"
        }
        $staged = $kind -ne '?' -and $xy.Substring(0, 1) -ne '.'
        $conflicted = $kind -eq 'u' -or $xy -match 'U'
        [void]$entries.Add([pscustomobject]@{
            kind = $kind
            status = $xy
            path = $path.Replace('\', '/')
            originalPath = if ($null -eq $originalPath) { $null } else { $originalPath.Replace('\', '/') }
            fullPath = $fullPath
            tracked = $kind -ne '?'
            staged = $staged
            conflicted = $conflicted
            submodule = $submodule
        })
    }
    return @($entries)
}

function Get-PathAttributes {
    param([string]$Repo, [string]$Path)
    $names = @('text', 'eol', 'working-tree-encoding', 'filter', 'ident', 'diff', 'linguist-generated', 'generated')
    $arguments = @('check-attr', '-z') + $names + @('--', $Path)
    $result = Invoke-Git -Repo $Repo -Arguments $arguments
    $parts = (ConvertFrom-Utf8Bytes $result.StdoutBytes).Split([char]0)
    $attributes = [ordered]@{}
    for ($i = 0; $i + 2 -lt $parts.Length; $i += 3) {
        if ([string]::IsNullOrEmpty($parts[$i])) { continue }
        $attributes[$parts[$i + 1]] = $parts[$i + 2]
    }
    foreach ($name in $names) {
        if (-not $attributes.Contains($name)) {
            $attributes[$name] = 'unspecified'
        }
    }
    return [pscustomobject]$attributes
}

function Test-ReparsePoint {
    param([string]$Path)
    if (-not [System.IO.File]::Exists($Path) -and -not [System.IO.Directory]::Exists($Path)) {
        return $false
    }
    $item = Get-Item -LiteralPath $Path -Force
    return (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Test-BinaryBytes {
    param([byte[]]$Bytes)
    $limit = [Math]::Min($Bytes.Length, 8192)
    for ($i = 0; $i -lt $limit; $i++) {
        if ($Bytes[$i] -eq 0) { return $true }
    }
    return $false
}

function Get-SecretFindings {
    param([string]$Path, [byte[]]$Bytes)

    if (Test-BinaryBytes $Bytes) { return @() }
    try {
        $text = ConvertFrom-Utf8Bytes $Bytes
    }
    catch {
        return @([pscustomobject]@{
            path = $Path
            line = 0
            ruleId = 'UNSCANNABLE_TEXT'
            confidence = 'unknown'
            disposition = 'review'
        })
    }

    $rules = @(
        [pscustomobject]@{ Id = 'PRIVATE_KEY'; Confidence = 'high'; Pattern = '-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----' },
        [pscustomobject]@{ Id = 'AWS_ACCESS_KEY'; Confidence = 'high'; Pattern = '(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])' },
        [pscustomobject]@{ Id = 'GITHUB_TOKEN'; Confidence = 'high'; Pattern = '(?<![A-Za-z0-9_])gh[opsu]_[A-Za-z0-9]{30,}(?![A-Za-z0-9_])' },
        [pscustomobject]@{ Id = 'GENERIC_SECRET_ASSIGNMENT'; Confidence = 'medium'; Pattern = '(?i)(?:password|passwd|api[_-]?key|secret|token)["'']?\s*[:=]\s*["''][^"'']{8,}["'']' }
    )
    $findings = New-Object System.Collections.ArrayList
    $lines = $text -split "\r\n|\n|\r"
    for ($lineIndex = 0; $lineIndex -lt $lines.Count; $lineIndex++) {
        foreach ($rule in $rules) {
            if ($lines[$lineIndex] -match $rule.Pattern) {
                [void]$findings.Add([pscustomobject]@{
                    path = $Path
                    line = $lineIndex + 1
                    ruleId = $rule.Id
                    confidence = $rule.Confidence
                    disposition = 'review'
                })
            }
        }
    }
    return @($findings)
}

function Get-ChangeStats {
    param([string]$Repo, [object]$Entry, [long]$Size)

    if (-not $Entry.tracked -or $Entry.status -match 'D') {
        return [pscustomobject]@{
            added = if ($Entry.tracked) { 0 } else { $null }
            deleted = 0
            hunks = $null
            whitespaceOnly = $false
        }
    }

    $numstat = Invoke-Git -Repo $Repo -Arguments @('diff', '--numstat', '-z', '--', $Entry.path) -AllowFailure
    $added = $null
    $deleted = $null
    if ($numstat.ExitCode -eq 0) {
        $raw = ConvertFrom-Utf8Bytes $numstat.StdoutBytes
        $first = ($raw.Split([char]0) | Select-Object -First 1)
        if ($first -match '^([^\t]+)\t([^\t]+)\t') {
            if ($matches[1] -ne '-') { $added = [int]$matches[1] }
            if ($matches[2] -ne '-') { $deleted = [int]$matches[2] }
        }
    }

    $hunks = $null
    if ($Size -le 1MB) {
        $patch = Invoke-Git -Repo $Repo -Arguments @('diff', '--unified=0', '--', $Entry.path) -AllowFailure
        if ($patch.ExitCode -eq 0 -and $patch.StdoutBytes.Length -le 2MB) {
            $patchText = ConvertFrom-Utf8Bytes $patch.StdoutBytes
            $hunks = ([regex]::Matches($patchText, '(?m)^@@ ')).Count
        }
    }

    $whitespace = Invoke-Git -Repo $Repo -Arguments @('diff', '--quiet', '--ignore-all-space', '--', $Entry.path) -AllowFailure
    return [pscustomobject]@{
        added = $added
        deleted = $deleted
        hunks = $hunks
        whitespaceOnly = $whitespace.ExitCode -eq 0
    }
}

function Get-StyleFeatures {
    param([string[]]$Subjects)
    if ($Subjects.Count -eq 0) {
        return [pscustomobject]@{
            sampleCount = 0
            conventionalRatio = 0
            scopedRatio = 0
            terminalPunctuationRatio = 0
            averageLength = 0
            language = 'unknown'
        }
    }
    $conventional = 0
    $scoped = 0
    $punctuated = 0
    $chinese = 0
    $length = 0
    foreach ($subject in $Subjects) {
        if ($subject -match '^(feat|fix|refactor|docs|test|build|ci|chore|perf|style|revert)(\([^)]+\))?!?:\s') {
            $conventional++
            if ($subject -match '^[a-z]+\([^)]+\)') { $scoped++ }
        }
        if ($subject -match '[.!?\u3002\uFF01\uFF1F]$') { $punctuated++ }
        if ($subject -match '[\u3400-\u9fff]') { $chinese++ }
        $length += $subject.Length
    }
    return [pscustomobject]@{
        sampleCount = $Subjects.Count
        conventionalRatio = [Math]::Round($conventional / $Subjects.Count, 2)
        scopedRatio = [Math]::Round($scoped / $Subjects.Count, 2)
        terminalPunctuationRatio = [Math]::Round($punctuated / $Subjects.Count, 2)
        averageLength = [Math]::Round($length / $Subjects.Count, 1)
        language = if ($chinese -gt ($Subjects.Count / 2)) { 'zh' } else { 'en-or-mixed' }
    }
}

function Get-Context {
    param([object]$RepositoryInfo)

    $indexBefore = Get-IndexHash $RepositoryInfo
    $head = Get-RepositoryHead $RepositoryInfo.Root
    $branch = Get-RepositoryBranch $RepositoryInfo.Root
    $operations = Get-OperationState $RepositoryInfo
    $statusEntries = Get-WorktreeStatus $RepositoryInfo.Root
    $files = New-Object System.Collections.ArrayList
    $secretFindings = New-Object System.Collections.ArrayList

    foreach ($entry in $statusEntries) {
        $exists = [System.IO.File]::Exists($entry.fullPath)
        $isDirectory = [System.IO.Directory]::Exists($entry.fullPath)
        $nestedRepository = $isDirectory -and (
            [System.IO.Directory]::Exists((Join-Path $entry.fullPath '.git')) -or
            [System.IO.File]::Exists((Join-Path $entry.fullPath '.git'))
        )
        $size = if ($exists) { (Get-Item -LiteralPath $entry.fullPath).Length } else { 0 }
        $bytes = if ($exists -and $size -le $script:MaxTextBytes) { [System.IO.File]::ReadAllBytes($entry.fullPath) } else { $null }
        $binary = if ($null -eq $bytes) { $size -gt $script:MaxTextBytes } else { Test-BinaryBytes $bytes }
        $attributes = Get-PathAttributes -Repo $RepositoryInfo.Root -Path $entry.path
        $stats = Get-ChangeStats -Repo $RepositoryInfo.Root -Entry $entry -Size $size
        $extension = [System.IO.Path]::GetExtension($entry.path).ToLowerInvariant()
        $generated = $attributes.'linguist-generated' -eq 'set' -or $attributes.generated -eq 'set'
        $reparse = if ($exists) { Test-ReparsePoint $entry.fullPath } else { $false }
        if ($null -ne $bytes -and ($entry.kind -eq '?' -or $entry.status.Substring(0, 1) -eq 'A')) {
            foreach ($finding in (Get-SecretFindings -Path $entry.path -Bytes $bytes)) {
                [void]$secretFindings.Add($finding)
            }
        }
        [void]$files.Add([pscustomobject]@{
            id = 'f' + ($files.Count + 1)
            path = $entry.path
            originalPath = $entry.originalPath
            status = $entry.status
            kind = $entry.kind
            tracked = $entry.tracked
            staged = $entry.staged
            conflicted = $entry.conflicted
            submodule = $entry.submodule
            extension = $extension
            size = $size
            worktreeSha256 = if ($exists) { Get-FileSha256 $entry.fullPath } else { $null }
            binary = $binary
            generated = $generated
            reparsePoint = $reparse
            directory = $isDirectory
            nestedRepository = $nestedRepository
            attributes = $attributes
            added = $stats.added
            deleted = $stats.deleted
            hunks = $stats.hunks
            whitespaceOnly = $stats.whitespaceOnly
        })
    }

    $log = Get-GitText -Repo $RepositoryInfo.Root -Arguments @('log', '-20', '--format=%s') -AllowFailure
    $subjects = if ($log.ExitCode -eq 0) {
        @($log.Text -split "\r?\n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    }
    else { @() }

    $rollups = @($files | Group-Object {
        $directory = [System.IO.Path]::GetDirectoryName($_.path)
        if ([string]::IsNullOrEmpty($directory)) { '.' } else { $directory.Replace('\', '/') }
    } | ForEach-Object {
        [pscustomobject]@{
            directory = $_.Name
            files = $_.Count
            added = [int](($_.Group | Measure-Object -Property added -Sum).Sum)
            deleted = [int](($_.Group | Measure-Object -Property deleted -Sum).Sum)
        }
    })

    Assert-IndexUnchanged -RepositoryInfo $RepositoryInfo -BeforeHash $indexBefore
    return [pscustomobject]@{
        schemaVersion = $script:SchemaVersion
        capturedAtUtc = [DateTime]::UtcNow.ToString('o')
        repository = $RepositoryInfo.Root
        gitDir = $RepositoryInfo.GitDir
        indexPath = $RepositoryInfo.IndexPath
        indexSha256 = $indexBefore
        head = $head
        branch = $branch
        detached = $null -eq $branch -and $null -ne $head
        operations = @($operations)
        files = @($files)
        rollups = @($rollups)
        recentSubjects = @($subjects)
        style = Get-StyleFeatures $subjects
        secretFindings = @($secretFindings)
    }
}

function Invoke-AnalyzeAction {
    param([object]$RepositoryInfo)
    $context = Get-Context $RepositoryInfo
    $contextPath = Join-Path $RepositoryInfo.StateDir 'context.json'
    if (-not $DryRun) {
        Write-AtomicJson -Path $contextPath -Value $context
    }
    if (-not [string]::IsNullOrEmpty($OutputPath)) {
        Write-AtomicJson -Path ([System.IO.Path]::GetFullPath($OutputPath)) -Value $context
    }
    $boundedFiles = @($context.files | Select-Object -First 250)
    return [pscustomobject]@{
        contextPath = $contextPath
        head = $context.head
        branch = $context.branch
        detached = $context.detached
        operations = $context.operations
        fileCount = $context.files.Count
        files = $boundedFiles
        truncated = $context.files.Count -gt $boundedFiles.Count
        rollups = $context.rollups
        recentSubjects = $context.recentSubjects
        style = $context.style
        secretFindings = $context.secretFindings
        stagedCount = @($context.files | Where-Object { $_.staged }).Count
        conflictCount = @($context.files | Where-Object { $_.conflicted }).Count
    }
}

function ConvertFrom-TextBytes {
    param([byte[]]$Bytes)
    if (Test-BinaryBytes $Bytes) {
        Throw-ToolkitError 'UNSUPPORTED_ENCODING' 'Binary content cannot be normalized.'
    }
    if ($Bytes.Length -ge 3 -and $Bytes[0] -eq 0xEF -and $Bytes[1] -eq 0xBB -and $Bytes[2] -eq 0xBF) {
        $encoding = New-Object System.Text.UTF8Encoding($true, $true)
        return [pscustomobject]@{ Text = $encoding.GetString($Bytes, 3, $Bytes.Length - 3); Encoding = $encoding; Bom = [byte[]]@(0xEF, 0xBB, 0xBF); Name = 'utf-8-bom' }
    }
    if ($Bytes.Length -ge 2 -and $Bytes[0] -eq 0xFF -and $Bytes[1] -eq 0xFE) {
        $encoding = New-Object System.Text.UnicodeEncoding($false, $true, $true)
        return [pscustomobject]@{ Text = $encoding.GetString($Bytes, 2, $Bytes.Length - 2); Encoding = $encoding; Bom = [byte[]]@(0xFF, 0xFE); Name = 'utf-16le-bom' }
    }
    if ($Bytes.Length -ge 2 -and $Bytes[0] -eq 0xFE -and $Bytes[1] -eq 0xFF) {
        $encoding = New-Object System.Text.UnicodeEncoding($true, $true, $true)
        return [pscustomobject]@{ Text = $encoding.GetString($Bytes, 2, $Bytes.Length - 2); Encoding = $encoding; Bom = [byte[]]@(0xFE, 0xFF); Name = 'utf-16be-bom' }
    }
    return [pscustomobject]@{ Text = $script:Utf8Strict.GetString($Bytes); Encoding = $script:Utf8Strict; Bom = [byte[]]@(); Name = 'utf-8' }
}

function ConvertTo-TextBytes {
    param([string]$Text, [object]$TextInfo)
    $payload = $TextInfo.Encoding.GetBytes($Text)
    if ($TextInfo.Bom.Length -eq 0) { return $payload }
    $output = New-Object byte[] ($TextInfo.Bom.Length + $payload.Length)
    [Array]::Copy($TextInfo.Bom, 0, $output, 0, $TextInfo.Bom.Length)
    [Array]::Copy($payload, 0, $output, $TextInfo.Bom.Length, $payload.Length)
    return $output
}

function Split-TextLines {
    param([string]$Text)
    $lines = New-Object System.Collections.ArrayList
    $start = 0
    $index = 0
    while ($index -lt $Text.Length) {
        if ($Text[$index] -eq "`r" -or $Text[$index] -eq "`n") {
            $ending = [string]$Text[$index]
            if ($Text[$index] -eq "`r" -and $index + 1 -lt $Text.Length -and $Text[$index + 1] -eq "`n") {
                $ending = "`r`n"
                $next = $index + 2
            }
            else {
                $next = $index + 1
            }
            [void]$lines.Add([pscustomobject]@{ Content = $Text.Substring($start, $index - $start); Ending = $ending })
            $start = $next
            $index = $next
            continue
        }
        $index++
    }
    if ($start -lt $Text.Length) {
        [void]$lines.Add([pscustomobject]@{ Content = $Text.Substring($start); Ending = '' })
    }
    return @($lines)
}

function Join-TextLines {
    param([object[]]$Lines)
    $builder = New-Object System.Text.StringBuilder
    foreach ($line in $Lines) {
        [void]$builder.Append($line.Content)
        [void]$builder.Append($line.Ending)
    }
    return $builder.ToString()
}

function Normalize-NewlineText {
    param([string]$Text)
    return ($Text.Replace("`r`n", "`n").Replace("`r", "`n"))
}

function Get-BaseBlob {
    param([string]$Repo, [object]$Entry)
    $basePath = if ([string]::IsNullOrEmpty($Entry.originalPath)) { $Entry.path } else { $Entry.originalPath }
    $tree = Invoke-Git -Repo $Repo -Arguments @('ls-tree', '-z', 'HEAD', '--', $basePath) -AllowFailure
    if ($tree.ExitCode -ne 0 -or $tree.StdoutBytes.Length -eq 0) { return $null }
    $record = (ConvertFrom-Utf8Bytes $tree.StdoutBytes).Split([char]0)[0]
    if ($record -notmatch '^([0-9]+)\s+(\S+)\s+([0-9a-f]+)\t') {
        Throw-ToolkitError 'TREE_PARSE_FAILED' "Could not parse the base tree entry for $basePath."
    }
    $mode = $matches[1]
    $type = $matches[2]
    $oid = $matches[3]
    if ($type -ne 'blob' -or $mode -eq '120000') { return $null }
    $blob = Invoke-Git -Repo $Repo -Arguments @('cat-file', 'blob', $oid)
    return [pscustomobject]@{ Path = $basePath; Mode = $mode; Oid = $oid; Bytes = $blob.StdoutBytes }
}

function Get-ZeroContextHunks {
    param([string]$Repo, [string]$Path)
    $patch = Invoke-Git -Repo $Repo -Arguments @('diff', '--unified=0', '--', $Path) -AllowFailure
    if ($patch.ExitCode -ne 0 -or $patch.StdoutBytes.Length -gt 2MB) { return @() }
    $text = ConvertFrom-Utf8Bytes $patch.StdoutBytes
    $lines = $text -split "\n"
    $hunks = New-Object System.Collections.ArrayList
    $current = $null
    foreach ($lineValue in $lines) {
        $line = $lineValue.TrimEnd("`r")
        if ($line -match '^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@') {
            if ($null -ne $current) { [void]$hunks.Add($current) }
            $current = [pscustomobject]@{
                OldStart = [int]$matches[1]
                OldCount = if ([string]::IsNullOrEmpty($matches[2])) { 1 } else { [int]$matches[2] }
                NewStart = [int]$matches[3]
                NewCount = if ([string]::IsNullOrEmpty($matches[4])) { 1 } else { [int]$matches[4] }
                Payload = New-Object System.Collections.ArrayList
            }
            continue
        }
        if ($null -ne $current -and ($line.StartsWith('+') -or $line.StartsWith('-')) -and -not $line.StartsWith('+++') -and -not $line.StartsWith('---')) {
            [void]$current.Payload.Add($line.Substring(1))
        }
    }
    if ($null -ne $current) { [void]$hunks.Add($current) }
    return @($hunks)
}

function Test-BlankOnlyHunk {
    param([object]$Hunk)
    if ($Hunk.Payload.Count -eq 0) { return $false }
    foreach ($line in $Hunk.Payload) {
        if (-not [string]::IsNullOrWhiteSpace([string]$line)) { return $false }
    }
    return $true
}

function Test-CSharpTriviaFile {
    param([string]$BaseText, [string]$CurrentText)
    $combined = $BaseText + "`n" + $CurrentText
    if ($combined -match '/\*|\*/|@"|\$@"|@\$"|"""') { return $false }
    if ($combined -match '(?m)^\s*#') { return $false }
    return $true
}

function Test-LuaTriviaFile {
    param([string]$BaseText, [string]$CurrentText)
    $combined = $BaseText + "`n" + $CurrentText
    if ($combined -match '\[(=*)\[' -or $combined -match '(?m)\\\s*$') { return $false }
    return $true
}

function Get-JsonTokens {
    param([string]$Text)
    $tokens = New-Object System.Collections.ArrayList
    $index = 0
    while ($index -lt $Text.Length) {
        $character = $Text[$index]
        if ([char]::IsWhiteSpace($character)) { $index++; continue }
        if ('{}[],:'.IndexOf($character) -ge 0) {
            [void]$tokens.Add([string]$character)
            $index++
            continue
        }
        if ($character -eq '"') {
            $start = $index
            $index++
            $escaped = $false
            while ($index -lt $Text.Length) {
                $current = $Text[$index]
                if ($escaped) { $escaped = $false; $index++; continue }
                if ($current -eq '\') { $escaped = $true; $index++; continue }
                if ($current -eq '"') { $index++; break }
                if ([int]$current -lt 0x20) { throw 'Control character in JSON string.' }
                $index++
            }
            if ($index -gt $Text.Length -or $Text[$index - 1] -ne '"') { throw 'Unterminated JSON string.' }
            [void]$tokens.Add($Text.Substring($start, $index - $start))
            continue
        }
        $start = $index
        while ($index -lt $Text.Length -and -not [char]::IsWhiteSpace($Text[$index]) -and '{}[],:'.IndexOf($Text[$index]) -lt 0) {
            $index++
        }
        [void]$tokens.Add($Text.Substring($start, $index - $start))
    }
    return @($tokens)
}

function Read-JsonTokenValue {
    param([string]$Token)
    return ($Token | ConvertFrom-Json)
}

function Invoke-JsonParseValue {
    param([object]$State)
    if ($State.Index -ge $State.Tokens.Count) { throw 'Unexpected end of JSON.' }
    $token = [string]$State.Tokens[$State.Index]
    if ($token -eq '{') {
        $State.Index++
        $keys = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
        if ($State.Index -lt $State.Tokens.Count -and $State.Tokens[$State.Index] -eq '}') { $State.Index++; return }
        while ($true) {
            if ($State.Index -ge $State.Tokens.Count -or -not ([string]$State.Tokens[$State.Index]).StartsWith('"')) { throw 'Expected JSON object key.' }
            $key = [string](Read-JsonTokenValue ([string]$State.Tokens[$State.Index]))
            if (-not $keys.Add($key)) { throw "Duplicate JSON key: $key" }
            $State.Index++
            if ($State.Index -ge $State.Tokens.Count -or $State.Tokens[$State.Index] -ne ':') { throw 'Expected colon after JSON key.' }
            $State.Index++
            Invoke-JsonParseValue $State
            if ($State.Index -ge $State.Tokens.Count) { throw 'Unexpected end of JSON object.' }
            if ($State.Tokens[$State.Index] -eq '}') { $State.Index++; return }
            if ($State.Tokens[$State.Index] -ne ',') { throw 'Expected comma in JSON object.' }
            $State.Index++
        }
    }
    if ($token -eq '[') {
        $State.Index++
        if ($State.Index -lt $State.Tokens.Count -and $State.Tokens[$State.Index] -eq ']') { $State.Index++; return }
        while ($true) {
            Invoke-JsonParseValue $State
            if ($State.Index -ge $State.Tokens.Count) { throw 'Unexpected end of JSON array.' }
            if ($State.Tokens[$State.Index] -eq ']') { $State.Index++; return }
            if ($State.Tokens[$State.Index] -ne ',') { throw 'Expected comma in JSON array.' }
            $State.Index++
        }
    }
    if ($token.StartsWith('"') -or $token -match '^(true|false|null|-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?)$') {
        if ($token.StartsWith('"')) { $null = Read-JsonTokenValue $token }
        $State.Index++
        return
    }
    throw "Invalid JSON token: $token"
}

function Test-StrictJson {
    param([string]$Text)
    try {
        $tokens = @(Get-JsonTokens $Text)
        $state = [pscustomobject]@{ Tokens = $tokens; Index = 0 }
        Invoke-JsonParseValue $state
        return $state.Index -eq $tokens.Count
    }
    catch {
        return $false
    }
}

function Test-SecureXml {
    param([string]$Text)
    $settings = New-Object System.Xml.XmlReaderSettings
    $settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $settings.MaxCharactersInDocument = 4MB
    $settings.MaxCharactersFromEntities = 0
    $reader = $null
    try {
        $reader = [System.Xml.XmlReader]::Create((New-Object System.IO.StringReader($Text)), $settings)
        while ($reader.Read()) {}
        return $true
    }
    catch {
        return $false
    }
    finally {
        if ($null -ne $reader) { $reader.Dispose() }
    }
}

function Test-XmlElementOnlyPolicy {
    param([string]$Repo, [string]$Path)
    $configPath = Join-Path $Repo '.git-commit-assistant.json'
    if (-not [System.IO.File]::Exists($configPath)) { return $false }
    try {
        $config = [System.IO.File]::ReadAllText($configPath, $script:Utf8Strict) | ConvertFrom-Json
        foreach ($pattern in @($config.xmlElementOnlyPaths)) {
            $wildcard = New-Object System.Management.Automation.WildcardPattern([string]$pattern, [System.Management.Automation.WildcardOptions]::IgnoreCase)
            if ($wildcard.IsMatch($Path)) { return $true }
        }
    }
    catch {
        return $false
    }
    return $false
}

function Restore-BlankHunks {
    param(
        [object[]]$BaseLines,
        [object[]]$CurrentLines,
        [object[]]$Hunks
    )
    $output = New-Object System.Collections.ArrayList
    foreach ($line in $CurrentLines) {
        [void]$output.Add([pscustomobject]@{ Content = $line.Content; Ending = $line.Ending })
    }
    $candidates = @($Hunks | Where-Object { Test-BlankOnlyHunk $_ } | Sort-Object NewStart -Descending)
    foreach ($hunk in $candidates) {
        $newIndex = if ($hunk.NewStart -eq 0) { 0 } else { $hunk.NewStart - 1 }
        $oldIndex = if ($hunk.OldStart -eq 0) { 0 } else { $hunk.OldStart - 1 }
        if ($newIndex -lt 0 -or $newIndex + $hunk.NewCount -gt $output.Count) { throw 'Hunk no longer maps to current lines.' }
        for ($i = 0; $i -lt $hunk.NewCount; $i++) { $output.RemoveAt($newIndex) }
        for ($i = $hunk.OldCount - 1; $i -ge 0; $i--) {
            $source = $BaseLines[$oldIndex + $i]
            $output.Insert($newIndex, [pscustomobject]@{ Content = $source.Content; Ending = $source.Ending })
        }
    }
    return [pscustomobject]@{ Lines = @($output); Count = $candidates.Count }
}

function Restore-UniqueBaseEndings {
    param([object[]]$BaseLines, [object[]]$CurrentLines)
    $baseMap = @{}
    $currentMap = @{}
    for ($i = 0; $i -lt $BaseLines.Count; $i++) {
        $key = Get-BytesSha256 ($script:Utf8NoBom.GetBytes([string]$BaseLines[$i].Content))
        if (-not $baseMap.ContainsKey($key)) { $baseMap[$key] = New-Object System.Collections.ArrayList }
        [void]$baseMap[$key].Add($i)
    }
    for ($i = 0; $i -lt $CurrentLines.Count; $i++) {
        $key = Get-BytesSha256 ($script:Utf8NoBom.GetBytes([string]$CurrentLines[$i].Content))
        if (-not $currentMap.ContainsKey($key)) { $currentMap[$key] = New-Object System.Collections.ArrayList }
        [void]$currentMap[$key].Add($i)
    }
    $changed = 0
    foreach ($key in $baseMap.Keys) {
        if ($baseMap[$key].Count -eq 1 -and $currentMap.ContainsKey($key) -and $currentMap[$key].Count -eq 1) {
            $baseLine = $BaseLines[$baseMap[$key][0]]
            $currentLine = $CurrentLines[$currentMap[$key][0]]
            if ($baseLine.Content -ceq $currentLine.Content -and $baseLine.Ending -cne $currentLine.Ending) {
                $currentLine.Ending = $baseLine.Ending
                $changed++
            }
        }
    }
    return $changed
}

function Recover-NormalizationJournal {
    param([object]$RepositoryInfo)
    $journalPath = Join-Path $RepositoryInfo.StateDir 'normalization-journal.json'
    if (-not [System.IO.File]::Exists($journalPath)) { return }
    try {
        $journal = [System.IO.File]::ReadAllText($journalPath, $script:Utf8Strict) | ConvertFrom-Json
    }
    catch {
        Throw-ToolkitError 'RECOVERY_REQUIRED' 'The normalization recovery journal is invalid; preserve it for manual review.'
    }

    $targetPath = [System.IO.Path]::GetFullPath([string]$journal.targetPath)
    $backupPath = [System.IO.Path]::GetFullPath([string]$journal.backupPath)
    if (-not (Test-PathInsideRoot -Root $RepositoryInfo.Root -Path $targetPath) -or
        -not (Test-PathInsideRoot -Root $RepositoryInfo.StateDir -Path $backupPath)) {
        Throw-ToolkitError 'RECOVERY_REQUIRED' 'The normalization recovery journal contains an unsafe path; preserve it for manual review.'
    }

    if ($journal.status -eq 'complete') {
        [System.IO.File]::Delete($journalPath)
        return
    }
    if ($journal.status -ne 'pending' -or -not [System.IO.File]::Exists($backupPath)) {
        Throw-ToolkitError 'RECOVERY_REQUIRED' 'Normalization recovery is incomplete and cannot be proven safe; preserve the journal for manual review.'
    }
    if ((Get-FileSha256 $backupPath) -ne [string]$journal.originalSha256) {
        Throw-ToolkitError 'RECOVERY_REQUIRED' 'The normalization backup hash is invalid; preserve the journal for manual review.'
    }

    $currentHash = Get-FileSha256 $targetPath
    if ($currentHash -eq [string]$journal.originalSha256) {
        [System.IO.File]::Delete($journalPath)
        return
    }
    if ($currentHash -ne [string]$journal.expectedSha256) {
        Throw-ToolkitError 'RECOVERY_CONFLICT' 'The normalized file changed after interruption; no file was overwritten and manual review is required.' ([pscustomobject]@{
            path = ConvertTo-RepoPath -Root $RepositoryInfo.Root -FullPath $targetPath
            journalPath = $journalPath
        })
    }

    [System.IO.File]::Copy($backupPath, $targetPath, $true)
    if ((Get-FileSha256 $targetPath) -ne [string]$journal.originalSha256) {
        Throw-ToolkitError 'RECOVERY_REQUIRED' 'Normalization recovery could not restore the original file; preserve the journal for manual review.'
    }
    [System.IO.File]::Delete($journalPath)
}

function Write-NormalizedFile {
    param(
        [object]$RepositoryInfo,
        [string]$Path,
        [byte[]]$Bytes,
        [string]$OriginalHash
    )
    $backupDirectory = Join-Path $RepositoryInfo.StateDir 'backup'
    [System.IO.Directory]::CreateDirectory($backupDirectory) | Out-Null
    $backupPath = Join-Path $backupDirectory ((Get-BytesSha256 ($script:Utf8NoBom.GetBytes($Path))) + '.bak')
    $journalPath = Join-Path $RepositoryInfo.StateDir 'normalization-journal.json'
    $tempPath = Join-Path ([System.IO.Path]::GetDirectoryName($Path)) ('.git-commit-assistant-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    [System.IO.File]::WriteAllBytes($tempPath, $Bytes)
    $journal = [pscustomobject]@{
        schemaVersion = $script:SchemaVersion
        status = 'pending'
        targetPath = $Path
        backupPath = $backupPath
        originalSha256 = $OriginalHash
        expectedSha256 = Get-BytesSha256 $Bytes
    }
    Write-AtomicJson -Path $journalPath -Value $journal
    try {
        [System.IO.File]::Replace($tempPath, $Path, $backupPath, $true)
        if ((Get-FileSha256 $Path) -ne $journal.expectedSha256) {
            throw 'Normalized file hash did not match the intended result.'
        }
        $journal.status = 'complete'
        Write-AtomicJson -Path $journalPath -Value $journal
        [System.IO.File]::Delete($journalPath)
    }
    catch {
        if ([System.IO.File]::Exists($backupPath)) {
            $currentHash = Get-FileSha256 $Path
            if ($currentHash -eq $journal.expectedSha256) {
                [System.IO.File]::Copy($backupPath, $Path, $true)
            }
            elseif ($currentHash -ne $journal.originalSha256) {
                Throw-ToolkitError 'RECOVERY_CONFLICT' 'The normalized file changed during recovery; no later content was overwritten.'
            }
        }
        throw
    }
    finally {
        if ([System.IO.File]::Exists($tempPath)) { [System.IO.File]::Delete($tempPath) }
    }
}

function Assert-NormalizePreconditions {
    param([object]$Context)
    if ($null -eq $Context.head) { Throw-ToolkitError 'UNBORN_HEAD' 'Normalization requires an existing HEAD.' }
    if ($Context.detached) { Throw-ToolkitError 'UNSUPPORTED_GIT_STATE' 'Detached HEAD is not supported.' }
    if ($Context.operations.Count -gt 0) { Throw-ToolkitError 'UNSUPPORTED_GIT_STATE' ('An active Git operation is present: ' + ($Context.operations -join ', ')) }
    if (@($Context.files | Where-Object { $_.staged }).Count -gt 0) { Throw-ToolkitError 'INDEX_NOT_CLEAN' 'The index contains staged changes.' }
    if (@($Context.files | Where-Object { $_.conflicted }).Count -gt 0) { Throw-ToolkitError 'CONFLICTS_PRESENT' 'The worktree contains unresolved conflicts.' }
}

function Invoke-NormalizeAction {
    param([object]$RepositoryInfo)
    Recover-NormalizationJournal $RepositoryInfo
    $context = Get-Context $RepositoryInfo
    Assert-NormalizePreconditions $context
    $allowed = if ($null -ne $Extensions -and $Extensions.Count -gt 0) { @($Extensions | ForEach-Object { $_.ToLowerInvariant() }) } else { $script:DefaultExtensions }
    $results = New-Object System.Collections.ArrayList
    $indexBefore = Get-IndexHash $RepositoryInfo

    foreach ($file in $context.files) {
        $reasons = New-Object System.Collections.ArrayList
        if (-not $file.tracked) { [void]$reasons.Add('new-file-without-explicit-policy') }
        if ($file.status -match 'D') { [void]$reasons.Add('deleted') }
        if ($allowed -notcontains $file.extension) { [void]$reasons.Add('extension-not-eligible') }
        if ($file.binary) { [void]$reasons.Add('binary-or-oversized') }
        if ($file.generated) { [void]$reasons.Add('generated') }
        if ($file.submodule) { [void]$reasons.Add('submodule') }
        if ($file.reparsePoint) { [void]$reasons.Add('reparse-point') }
        if ($file.attributes.filter -notin @('unspecified', 'unset')) { [void]$reasons.Add('filter') }
        if ($file.attributes.ident -eq 'set') { [void]$reasons.Add('ident') }
        if ($file.attributes.'working-tree-encoding' -notin @('unspecified', 'unset', 'UTF-8', 'utf-8')) { [void]$reasons.Add('working-tree-encoding') }
        if ($reasons.Count -gt 0) {
            [void]$results.Add([pscustomobject]@{ path = $file.path; changed = $false; proof = $null; skipped = @($reasons) })
            continue
        }

        try {
            $entry = [pscustomobject]@{ path = $file.path; originalPath = $file.originalPath }
            $baseBlob = Get-BaseBlob -Repo $RepositoryInfo.Root -Entry $entry
            if ($null -eq $baseBlob) {
                [void]$results.Add([pscustomobject]@{ path = $file.path; changed = $false; proof = $null; skipped = @('base-blob-unavailable') })
                continue
            }
            $currentBytes = [System.IO.File]::ReadAllBytes((Join-Path $RepositoryInfo.Root $file.path.Replace('/', '\')))
            $baseInfo = ConvertFrom-TextBytes $baseBlob.Bytes
            $currentInfo = ConvertFrom-TextBytes $currentBytes
            $candidateText = $currentInfo.Text
            $proofs = New-Object System.Collections.ArrayList
            $blankHunks = 0
            $eolLines = 0

            if ((Normalize-NewlineText $baseInfo.Text) -ceq (Normalize-NewlineText $currentInfo.Text)) {
                $candidateBytes = $baseBlob.Bytes
                [void]$proofs.Add('exact-base-restoration')
            }
            else {
                if ($baseInfo.Name -ne $currentInfo.Name) {
                    [void]$results.Add([pscustomobject]@{ path = $file.path; changed = $false; proof = $null; skipped = @('encoding-or-bom-changed-with-semantic-edit') })
                    continue
                }
                $baseLines = @(Split-TextLines $baseInfo.Text)
                $currentLines = @(Split-TextLines $currentInfo.Text)
                if ($baseLines.Count -gt $script:MaxNormalizeLines -or $currentLines.Count -gt $script:MaxNormalizeLines) {
                    [void]$results.Add([pscustomobject]@{ path = $file.path; changed = $false; proof = $null; skipped = @('too-many-lines') })
                    continue
                }
                $hunks = @(Get-ZeroContextHunks -Repo $RepositoryInfo.Root -Path $file.path)
                $canRestoreBlank = $false
                $blankProof = $null
                switch ($file.extension) {
                    '.cs' { $canRestoreBlank = Test-CSharpTriviaFile $baseInfo.Text $currentInfo.Text; $blankProof = 'csharp-trivia' }
                    '.lua' { $canRestoreBlank = Test-LuaTriviaFile $baseInfo.Text $currentInfo.Text; $blankProof = 'lua-trivia' }
                    '.json' {
                        $canRestoreBlank = (Test-StrictJson $baseInfo.Text) -and (Test-StrictJson $currentInfo.Text)
                        if ($canRestoreBlank) {
                            $baseTokens = (Get-JsonTokens $baseInfo.Text) -join [char]0
                            $currentTokens = (Get-JsonTokens $currentInfo.Text) -join [char]0
                            $canRestoreBlank = $baseTokens -ceq $currentTokens
                            $blankProof = 'json-model'
                        }
                    }
                    '.xml' {
                        $canRestoreBlank = (Test-XmlElementOnlyPolicy $RepositoryInfo.Root $file.path) -and (Test-SecureXml $baseInfo.Text) -and (Test-SecureXml $currentInfo.Text)
                        $blankProof = 'xml-element-only'
                    }
                }
                if ($canRestoreBlank -and @($hunks | Where-Object { Test-BlankOnlyHunk $_ }).Count -gt 0) {
                    $restored = Restore-BlankHunks -BaseLines $baseLines -CurrentLines $currentLines -Hunks $hunks
                    $currentLines = @($restored.Lines)
                    $blankHunks = $restored.Count
                    if ($blankHunks -gt 0 -and -not [string]::IsNullOrEmpty($blankProof)) { [void]$proofs.Add($blankProof) }
                }
                $eolLines = Restore-UniqueBaseEndings -BaseLines $baseLines -CurrentLines $currentLines
                if ($eolLines -gt 0) { [void]$proofs.Add('unchanged-line-eol') }
                $candidateText = Join-TextLines $currentLines
                $candidateBytes = ConvertTo-TextBytes -Text $candidateText -TextInfo $currentInfo
            }

            $changed = (Get-BytesSha256 $candidateBytes) -ne (Get-BytesSha256 $currentBytes)
            if ($changed -and -not $DryRun) {
                $targetPath = Join-Path $RepositoryInfo.Root $file.path.Replace('/', '\')
                Write-NormalizedFile -RepositoryInfo $RepositoryInfo -Path $targetPath -Bytes $candidateBytes -OriginalHash (Get-BytesSha256 $currentBytes)
                Assert-IndexUnchanged -RepositoryInfo $RepositoryInfo -BeforeHash $indexBefore
            }
            $skipReasons = if (-not $changed -and $proofs.Count -eq 0) { @('no-applicable-proof-or-no-safe-noise') } else { @() }
            [void]$results.Add([pscustomobject]@{
                path = $file.path
                changed = $changed
                proof = @($proofs | Select-Object -Unique)
                blankHunksReverted = $blankHunks
                eolLinesRestored = $eolLines
                skipped = $skipReasons
            })
        }
        catch {
            [void]$results.Add([pscustomobject]@{ path = $file.path; changed = $false; proof = $null; skipped = @('normalization-failed'); message = $_.Exception.Message })
        }
    }
    Assert-IndexUnchanged -RepositoryInfo $RepositoryInfo -BeforeHash $indexBefore
    return [pscustomobject]@{
        dryRun = [bool]$DryRun
        changedCount = @($results | Where-Object { $_.changed }).Count
        files = @($results)
    }
}

function Read-JsonFile {
    param([string]$Path, [string]$MissingCode = 'PLAN_INVALID')
    if (-not [System.IO.File]::Exists($Path)) {
        Throw-ToolkitError $MissingCode "Required file does not exist: $Path"
    }
    try {
        return ([System.IO.File]::ReadAllText($Path, $script:Utf8Strict) | ConvertFrom-Json)
    }
    catch {
        Throw-ToolkitError $MissingCode "Invalid JSON in $Path."
    }
}

function Assert-ContextSafety {
    param([object]$Context)
    if ($null -eq $Context.head) { Throw-ToolkitError 'UNBORN_HEAD' 'An existing HEAD is required.' }
    if ($Context.detached) { Throw-ToolkitError 'UNSUPPORTED_GIT_STATE' 'Detached HEAD is not supported.' }
    if (@($Context.operations).Count -gt 0) { Throw-ToolkitError 'UNSUPPORTED_GIT_STATE' ('An active Git operation is present: ' + (@($Context.operations) -join ', ')) }
    if (@($Context.files | Where-Object { $_.staged }).Count -gt 0) { Throw-ToolkitError 'INDEX_NOT_CLEAN' 'The index contains staged changes.' }
    if (@($Context.files | Where-Object { $_.conflicted }).Count -gt 0) { Throw-ToolkitError 'CONFLICTS_PRESENT' 'The worktree contains unresolved conflicts.' }
}

function Assert-ContextMatches {
    param([object]$Saved, [object]$Current)
    if ($Saved.head -ne $Current.head) { Throw-ToolkitError 'WORKTREE_DRIFT' 'HEAD changed after analysis.' }
    if ($Saved.branch -ne $Current.branch) { Throw-ToolkitError 'WORKTREE_DRIFT' 'The current branch changed after analysis.' }
    $savedFiles = @{}
    foreach ($file in @($Saved.files)) { $savedFiles[[string]$file.path] = $file }
    $currentFiles = @{}
    foreach ($file in @($Current.files)) { $currentFiles[[string]$file.path] = $file }
    if ($savedFiles.Count -ne $currentFiles.Count) { Throw-ToolkitError 'WORKTREE_DRIFT' 'The changed path set changed after analysis.' }
    foreach ($path in $savedFiles.Keys) {
        if (-not $currentFiles.ContainsKey($path)) { Throw-ToolkitError 'WORKTREE_DRIFT' "Changed path disappeared after analysis: $path" }
        $left = $savedFiles[$path]
        $right = $currentFiles[$path]
        if ($left.status -ne $right.status -or $left.worktreeSha256 -ne $right.worktreeSha256 -or $left.originalPath -ne $right.originalPath) {
            Throw-ToolkitError 'WORKTREE_DRIFT' "Changed path drifted after analysis: $path"
        }
    }
}

function Get-ExpectedBlobId {
    param([object]$RepositoryInfo, [object]$ContextFile)
    if ($ContextFile.status -match 'D' -and -not [System.IO.File]::Exists((Join-Path $RepositoryInfo.Root $ContextFile.path.Replace('/', '\')))) {
        return $null
    }
    if ($ContextFile.attributes.filter -notin @('unspecified', 'unset')) {
        Throw-ToolkitError 'UNSUPPORTED_GIT_FILTER' "Custom or LFS filter blocks safe blob prediction: $($ContextFile.path)"
    }
    if ($ContextFile.attributes.ident -eq 'set') {
        Throw-ToolkitError 'UNSUPPORTED_GIT_FILTER' "The ident attribute blocks safe blob prediction: $($ContextFile.path)"
    }
    if ($ContextFile.attributes.'working-tree-encoding' -notin @('unspecified', 'unset', 'UTF-8', 'utf-8')) {
        Throw-ToolkitError 'UNSUPPORTED_ENCODING' "working-tree-encoding is unsupported in version 1: $($ContextFile.path)"
    }
    $fullPath = Join-Path $RepositoryInfo.Root $ContextFile.path.Replace('/', '\')
    $bytes = [System.IO.File]::ReadAllBytes($fullPath)
    $normalizeText = $ContextFile.attributes.text -in @('set', 'auto') -or $ContextFile.attributes.eol -in @('lf', 'crlf')
    if (-not $normalizeText -and $ContextFile.attributes.text -eq 'unspecified') {
        $auto = Get-GitText -Repo $RepositoryInfo.Root -Arguments @('config', '--get', 'core.autocrlf') -AllowFailure
        $normalizeText = $auto.ExitCode -eq 0 -and $auto.Text.Trim() -in @('true', 'input')
    }
    if ($normalizeText -and -not (Test-BinaryBytes $bytes)) {
        try {
            $info = ConvertFrom-TextBytes $bytes
            $normalized = Normalize-NewlineText $info.Text
            $bytes = ConvertTo-TextBytes -Text $normalized -TextInfo $info
        }
        catch {
            Throw-ToolkitError 'UNSUPPORTED_ENCODING' "Could not reproduce Git text conversion for $($ContextFile.path)."
        }
    }
    $hash = Invoke-Git -Repo $RepositoryInfo.Root -Arguments @('hash-object', '--stdin') -InputBytes $bytes
    return (ConvertFrom-Utf8Bytes $hash.StdoutBytes).Trim()
}

function Get-ExpectedTreeEntries {
    param([object]$RepositoryInfo, [object]$ContextFile)
    $entries = New-Object System.Collections.ArrayList
    $baseEntry = Get-BaseBlob -Repo $RepositoryInfo.Root -Entry ([pscustomobject]@{ path = $ContextFile.path; originalPath = $ContextFile.originalPath })
    $mode = if ($null -ne $baseEntry) { $baseEntry.Mode } else { '100644' }
    if (-not [string]::IsNullOrEmpty([string]$ContextFile.originalPath) -and $ContextFile.originalPath -ne $ContextFile.path) {
        [void]$entries.Add([pscustomobject]@{ path = $ContextFile.originalPath; oid = $null; mode = $null })
    }
    $fullPath = Join-Path $RepositoryInfo.Root $ContextFile.path.Replace('/', '\')
    if ([System.IO.File]::Exists($fullPath)) {
        [void]$entries.Add([pscustomobject]@{
            path = $ContextFile.path
            oid = Get-ExpectedBlobId -RepositoryInfo $RepositoryInfo -ContextFile $ContextFile
            mode = $mode
        })
    }
    else {
        [void]$entries.Add([pscustomobject]@{ path = $ContextFile.path; oid = $null; mode = $null })
    }
    return @($entries)
}

function Test-DependencyCycle {
    param([object[]]$Groups)
    $seen = @{}
    foreach ($group in $Groups) {
        foreach ($dependency in @($group.dependencies)) {
            if (-not $seen.ContainsKey([string]$dependency)) { return $true }
        }
        $seen[[string]$group.id] = $true
    }
    return $false
}

function Invoke-SavePlanAction {
    param([object]$RepositoryInfo)
    if ([string]::IsNullOrWhiteSpace($PlanPath)) { Throw-ToolkitError 'PLAN_INVALID' 'SavePlan requires -PlanPath.' }
    $contextPath = Join-Path $RepositoryInfo.StateDir 'context.json'
    $savedContext = Read-JsonFile -Path $contextPath -MissingCode 'PLAN_INVALID'
    $currentContext = Get-Context $RepositoryInfo
    Assert-ContextSafety $currentContext
    Assert-ContextMatches -Saved $savedContext -Current $currentContext
    $inputPlan = Read-JsonFile -Path ([System.IO.Path]::GetFullPath($PlanPath)) -MissingCode 'PLAN_INVALID'
    if ($inputPlan.schemaVersion -ne $script:SchemaVersion) { Throw-ToolkitError 'PLAN_INVALID' 'Unsupported plan schemaVersion.' }
    if ($inputPlan.baseHead -ne $currentContext.head) { Throw-ToolkitError 'PLAN_INVALID' 'Plan baseHead does not match the analyzed HEAD.' }
    $groups = @($inputPlan.groups)
    if ($groups.Count -eq 0) { Throw-ToolkitError 'PLAN_INVALID' 'Plan must contain at least one group.' }
    if (Test-DependencyCycle $groups) { Throw-ToolkitError 'PLAN_INVALID' 'Dependencies must reference earlier groups and cannot form a cycle.' }

    $contextByPath = @{}
    foreach ($file in @($currentContext.files)) { $contextByPath[[string]$file.path] = $file }
    $usedPaths = @{}
    $usedIds = @{}
    $savedGroups = New-Object System.Collections.ArrayList
    foreach ($group in $groups) {
        $id = [string]$group.id
        if ([string]::IsNullOrWhiteSpace($id) -or $id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' -or $usedIds.ContainsKey($id)) {
            Throw-ToolkitError 'PLAN_INVALID' "Invalid or duplicate group id: $id"
        }
        $usedIds[$id] = $true
        $message = [string]$group.message
        if ([string]::IsNullOrWhiteSpace($message)) { Throw-ToolkitError 'PLAN_INVALID' "Group $id has no commit message." }
        $validationMode = if ($group.PSObject.Properties.Name -contains 'validation') { [string]$group.validation } else { 'auto' }
        if ($validationMode -notin @('light', 'auto', 'full', 'none')) { Throw-ToolkitError 'PLAN_INVALID' "Group $id has an invalid validation mode." }
        $paths = @($group.paths)
        if ($paths.Count -eq 0) { Throw-ToolkitError 'PLAN_INVALID' "Group $id has no paths." }
        $expectedEntries = New-Object System.Collections.ArrayList
        foreach ($pathValue in $paths) {
            $path = ([string]$pathValue).Replace('\', '/')
            if ([System.IO.Path]::IsPathRooted($path)) { Throw-ToolkitError 'PLAN_INVALID' "Plan path must be repository-relative: $path" }
            $fullPath = [System.IO.Path]::GetFullPath((Join-Path $RepositoryInfo.Root $path.Replace('/', '\')))
            if (-not (Test-PathInsideRoot $RepositoryInfo.Root $fullPath)) { Throw-ToolkitError 'PLAN_INVALID' "Plan path escapes the worktree: $path" }
            $canonical = ConvertTo-RepoPath -Root $RepositoryInfo.Root -FullPath $fullPath
            if ($canonical -cne $path) { Throw-ToolkitError 'PLAN_INVALID' "Plan path is not canonical: $path" }
            if (-not $contextByPath.ContainsKey($path)) { Throw-ToolkitError 'PLAN_INVALID' "Plan path is not in the analyzed change set: $path" }
            if ($usedPaths.ContainsKey($path)) { Throw-ToolkitError 'PLAN_INVALID' "Plan path appears in more than one group: $path" }
            if ($contextByPath[$path].directory -or $contextByPath[$path].nestedRepository) { Throw-ToolkitError 'PLAN_INVALID' "Directories and nested repositories cannot be selected: $path" }
            if (Test-ReparsePoint $fullPath) { Throw-ToolkitError 'PLAN_INVALID' "Reparse point cannot be selected: $path" }
            $usedPaths[$path] = $true
            foreach ($treeEntry in (Get-ExpectedTreeEntries -RepositoryInfo $RepositoryInfo -ContextFile $contextByPath[$path])) {
                [void]$expectedEntries.Add($treeEntry)
            }
        }
        [void]$savedGroups.Add([pscustomobject]@{
            id = $id
            intent = [string]$group.intent
            paths = @($paths | ForEach-Object { ([string]$_).Replace('\', '/') })
            message = $message
            dependencies = @($group.dependencies)
            validation = $validationMode
            expectedEntries = @($expectedEntries)
            state = 'pending'
            commit = $null
        })
    }
    if ($usedPaths.Count -ne $contextByPath.Count) {
        $missing = @($contextByPath.Keys | Where-Object { -not $usedPaths.ContainsKey($_) })
        Throw-ToolkitError 'PLAN_INVALID' ('Plan omits changed paths: ' + ($missing -join ', '))
    }

    $plan = [pscustomobject]@{
        schemaVersion = $script:SchemaVersion
        repository = $RepositoryInfo.Root
        baseHead = $currentContext.head
        currentHead = $currentContext.head
        createdAtUtc = [DateTime]::UtcNow.ToString('o')
        contextPath = $contextPath
        groups = @($savedGroups)
    }
    $state = [pscustomobject]@{
        schemaVersion = $script:SchemaVersion
        status = 'ready'
        pendingLaunch = $null
        completedCommits = @()
    }
    Write-AtomicJson -Path (Join-Path $RepositoryInfo.StateDir 'plan.json') -Value $plan
    Write-AtomicJson -Path (Join-Path $RepositoryInfo.StateDir 'state.json') -Value $state
    return [pscustomobject]@{
        planPath = Join-Path $RepositoryInfo.StateDir 'plan.json'
        groupCount = $savedGroups.Count
        groups = @($savedGroups | ForEach-Object { [pscustomobject]@{ id = $_.id; message = $_.message; paths = $_.paths; validation = $_.validation } })
    }
}

function Test-ProcessIdentity {
    param([object]$Launch)
    if ($null -eq $Launch -or $null -eq $Launch.processId) { return $false }
    try {
        $process = Get-Process -Id ([int]$Launch.processId) -ErrorAction Stop
        $actual = $process.StartTime.ToUniversalTime().ToString('o')
        return $actual -eq [string]$Launch.processStartUtc
    }
    catch {
        return $false
    }
}

function Get-CommitTreeEntry {
    param([string]$Repo, [string]$Commit, [string]$Path)
    $tree = Invoke-Git -Repo $Repo -Arguments @('ls-tree', '-z', $Commit, '--', $Path) -AllowFailure
    if ($tree.ExitCode -ne 0 -or $tree.StdoutBytes.Length -eq 0) { return $null }
    $record = (ConvertFrom-Utf8Bytes $tree.StdoutBytes).Split([char]0)[0]
    if ($record -notmatch '^([0-9]+)\s+(\S+)\s+([0-9a-f]+)\t') { return $null }
    return [pscustomobject]@{ mode = $matches[1]; type = $matches[2]; oid = $matches[3] }
}

function Confirm-PendingCommit {
    param([object]$RepositoryInfo, [object]$Plan, [object]$State)
    if ($null -eq $State.pendingLaunch) { return $false }
    $pending = $State.pendingLaunch
    $head = Get-RepositoryHead $RepositoryInfo.Root
    if ($head -eq $pending.expectedParent) {
        if (Test-ProcessIdentity $pending) {
            Throw-ToolkitError 'TORTOISEGIT_ACTIVE' 'The current TortoiseGit commit dialog is still open.'
        }
        if (-not $ConfirmCancelled) {
            Throw-ToolkitError 'CONFIRMATION_REQUIRED' 'TortoiseGit exited without an observable commit. Confirm cancellation before relaunching.'
        }
        foreach ($group in @($Plan.groups)) {
            if ($group.id -eq $pending.groupId) { $group.state = 'pending' }
        }
        $State.pendingLaunch = $null
        $State.status = 'ready'
        Write-AtomicJson -Path (Join-Path $RepositoryInfo.StateDir 'plan.json') -Value $Plan
        Write-AtomicJson -Path (Join-Path $RepositoryInfo.StateDir 'state.json') -Value $State
        return $false
    }

    $parents = Get-GitText -Repo $RepositoryInfo.Root -Arguments @('rev-list', '--parents', '-n', '1', $head)
    $parts = @($parents.Text.Trim() -split '\s+')
    if ($parts.Count -ne 2 -or $parts[1] -ne $pending.expectedParent) {
        Throw-ToolkitError 'PLAN_INVALID' 'HEAD advanced by an unrelated, merged, or multiple-commit sequence.'
    }
    $group = @($Plan.groups | Where-Object { $_.id -eq $pending.groupId }) | Select-Object -First 1
    if ($null -eq $group) { Throw-ToolkitError 'PLAN_INVALID' 'Pending group no longer exists in the plan.' }

    $diff = Invoke-Git -Repo $RepositoryInfo.Root -Arguments @('diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames', $pending.expectedParent, $head)
    $actualPaths = @((ConvertFrom-Utf8Bytes $diff.StdoutBytes).Split([char]0) | Where-Object { -not [string]::IsNullOrEmpty($_) } | Sort-Object -Unique)
    $expectedPaths = @($group.expectedEntries | ForEach-Object { [string]$_.path } | Sort-Object -Unique)
    if (($actualPaths -join [char]0) -cne ($expectedPaths -join [char]0)) {
        Throw-ToolkitError 'PLAN_INVALID' 'The commit path set does not exactly match the pending group.'
    }
    foreach ($expected in @($group.expectedEntries)) {
        $actual = Get-CommitTreeEntry -Repo $RepositoryInfo.Root -Commit $head -Path ([string]$expected.path)
        if ($null -eq $expected.oid) {
            if ($null -ne $actual) { Throw-ToolkitError 'PLAN_INVALID' "Expected deletion did not occur: $($expected.path)" }
        }
        elseif ($null -eq $actual -or $actual.oid -ne $expected.oid -or $actual.mode -ne $expected.mode) {
            Throw-ToolkitError 'PLAN_INVALID' "Committed blob or tree mode differs from the plan: $($expected.path)"
        }
    }

    $group.state = 'complete'
    $group.commit = $head
    $Plan.currentHead = $head
    $State.pendingLaunch = $null
    $State.completedCommits = @($State.completedCommits) + @($head)
    $State.status = 'ready'
    Write-AtomicJson -Path (Join-Path $RepositoryInfo.StateDir 'plan.json') -Value $Plan
    Write-AtomicJson -Path (Join-Path $RepositoryInfo.StateDir 'state.json') -Value $State
    $newContext = Get-Context $RepositoryInfo
    Write-AtomicJson -Path (Join-Path $RepositoryInfo.StateDir 'context.json') -Value $newContext
    return $true
}

function Assert-SelectedFilesSafe {
    param([object]$RepositoryInfo, [object]$Group, [object]$Context)
    $contextByPath = @{}
    foreach ($file in @($Context.files)) { $contextByPath[[string]$file.path] = $file }
    $deletionCount = @($Context.files | Where-Object { $_.status -match 'D' }).Count
    $renameCount = @($Context.files | Where-Object { -not [string]::IsNullOrEmpty([string]$_.originalPath) }).Count
    if ($deletionCount -ge 50 -or $renameCount -ge 50 -or ($Context.files.Count -ge 10 -and $deletionCount -gt ($Context.files.Count / 2))) {
        Throw-ToolkitError 'MASS_CHANGE_REVIEW_REQUIRED' 'Mass deletion or rename requires manual review before a new plan.'
    }
    $findings = New-Object System.Collections.ArrayList
    foreach ($path in @($Group.paths)) {
        if (-not $contextByPath.ContainsKey([string]$path)) {
            Throw-ToolkitError 'WORKTREE_DRIFT' "Selected path is no longer changed: $path"
        }
        $file = $contextByPath[[string]$path]
        if ($file.reparsePoint -or $file.submodule -or $file.binary -or $file.generated -or $file.directory -or $file.nestedRepository) {
            Throw-ToolkitError 'UNSAFE_PATH' "Selected path is not a safe regular text file: $path"
        }
        $fullPath = Join-Path $RepositoryInfo.Root ([string]$path).Replace('/', '\')
        if ([System.IO.File]::Exists($fullPath)) {
            $bytes = [System.IO.File]::ReadAllBytes($fullPath)
            foreach ($finding in (Get-SecretFindings -Path ([string]$path) -Bytes $bytes)) {
                [void]$findings.Add($finding)
            }
            $textInfo = ConvertFrom-TextBytes $bytes
            if ($file.extension -eq '.json' -and -not (Test-StrictJson $textInfo.Text)) {
                Throw-ToolkitError 'VALIDATION_FAILED' "Changed JSON is invalid or has duplicate keys: $path"
            }
            if ($file.extension -eq '.xml' -and -not (Test-SecureXml $textInfo.Text)) {
                Throw-ToolkitError 'VALIDATION_FAILED' "Changed XML failed secure parsing: $path"
            }
            if ($textInfo.Text -match '(?m)^(<<<<<<< |=======\s*$|>>>>>>> )') {
                Throw-ToolkitError 'CONFLICTS_PRESENT' "Conflict marker found in $path."
            }
        }
    }
    if ($findings.Count -gt 0) {
        Throw-ToolkitError 'SECRET_REVIEW_REQUIRED' 'Credential-like content requires human review.' @($findings)
    }
    $arguments = @('diff', '--check', '--') + @($Group.paths)
    $check = Invoke-Git -Repo $RepositoryInfo.Root -Arguments $arguments -AllowFailure
    if ($check.ExitCode -ne 0) {
        Throw-ToolkitError 'VALIDATION_FAILED' 'git diff --check reported whitespace errors in the selected group.'
    }
}

function Get-StatusFingerprint {
    param([object]$Context)
    $items = @($Context.files | Sort-Object path | ForEach-Object {
        [pscustomobject]@{
            path = $_.path
            originalPath = $_.originalPath
            status = $_.status
            hash = $_.worktreeSha256
            staged = $_.staged
        }
    })
    return Get-BytesSha256 ($script:Utf8NoBom.GetBytes((ConvertTo-JsonText ([pscustomobject]@{
        head = $Context.head
        branch = $Context.branch
        index = $Context.indexSha256
        files = $items
    }))))
}

function Find-DotnetValidation {
    param([object]$RepositoryInfo, [object]$Group)
    if (@($Group.paths | Where-Object { [System.IO.Path]::GetExtension([string]$_) -eq '.cs' }).Count -eq 0) { return $null }
    $dotnet = Get-Command dotnet.exe -ErrorAction SilentlyContinue
    if ($null -eq $dotnet) { $dotnet = Get-Command dotnet -ErrorAction SilentlyContinue }
    if ($null -eq $dotnet) { return $null }

    $candidate = $null
    $rootSolutions = @(Get-ChildItem -LiteralPath $RepositoryInfo.Root -File -Filter '*.sln' -ErrorAction SilentlyContinue)
    if ($rootSolutions.Count -eq 1) { $candidate = $rootSolutions[0].FullName }
    if ($null -eq $candidate) {
        foreach ($path in @($Group.paths)) {
            $directory = [System.IO.Path]::GetDirectoryName((Join-Path $RepositoryInfo.Root ([string]$path).Replace('/', '\')))
            while (-not [string]::IsNullOrEmpty($directory) -and (Test-PathInsideRoot $RepositoryInfo.Root ($directory + '\placeholder'))) {
                $projects = @(Get-ChildItem -LiteralPath $directory -File -Filter '*.csproj' -ErrorAction SilentlyContinue)
                if ($projects.Count -eq 1) { $candidate = $projects[0].FullName; break }
                if ($directory.TrimEnd('\') -eq $RepositoryInfo.Root.TrimEnd('\')) { break }
                $directory = [System.IO.Path]::GetDirectoryName($directory)
            }
            if ($null -ne $candidate) { break }
        }
    }
    if ($null -eq $candidate) { return $null }
    return [pscustomobject]@{
        executable = $dotnet.Source
        arguments = @('build', $candidate, '--no-restore', '--nologo')
        workingDirectory = $RepositoryInfo.Root
        definitionPath = $candidate
        definitionSha256 = Get-FileSha256 $candidate
        timeoutMilliseconds = 300000
        environmentPolicy = 'credential variables removed; no restore; bounded output'
    }
}

function Get-CredentialEnvironmentOverrides {
    $overrides = @{}
    foreach ($entry in [System.Environment]::GetEnvironmentVariables().Keys) {
        $name = [string]$entry
        if ($name -match '(?i)(TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|AWS_|AZURE_|GOOGLE_|GITHUB_|GITLAB_|NUGET_)') {
            $overrides[$name] = $null
        }
    }
    return $overrides
}

function Invoke-OptionalValidation {
    param([object]$RepositoryInfo, [object]$Group, [object]$BeforeContext)
    $mode = if (-not [string]::IsNullOrEmpty($Validation)) { $Validation } else { [string]$Group.validation }
    if ($mode -in @('none', 'light')) { return $null }
    $proposal = Find-DotnetValidation -RepositoryInfo $RepositoryInfo -Group $Group
    if ($null -eq $proposal) { return $null }
    $proposalPath = Join-Path $RepositoryInfo.StateDir 'validation-proposal.json'
    if ([string]::IsNullOrEmpty($ValidationApprovalId)) {
        $proposalId = [Guid]::NewGuid().ToString('N')
        $record = [pscustomobject]@{
            schemaVersion = $script:SchemaVersion
            id = $proposalId
            expiresAtUtc = [DateTime]::UtcNow.AddMinutes(15).ToString('o')
            used = $false
            repository = $RepositoryInfo.Root
            head = $BeforeContext.head
            statusFingerprint = Get-StatusFingerprint $BeforeContext
            executable = $proposal.executable
            arguments = $proposal.arguments
            workingDirectory = $proposal.workingDirectory
            definitionPath = $proposal.definitionPath
            definitionSha256 = $proposal.definitionSha256
            timeoutMilliseconds = $proposal.timeoutMilliseconds
            environmentPolicy = $proposal.environmentPolicy
        }
        Write-AtomicJson -Path $proposalPath -Value $record
        Throw-ToolkitError 'VALIDATION_APPROVAL_REQUIRED' 'External validation requires explicit current-conversation approval.' ([pscustomobject]@{
            approvalId = $proposalId
            expiresAtUtc = $record.expiresAtUtc
            executable = $record.executable
            arguments = $record.arguments
            workingDirectory = $record.workingDirectory
            timeoutMilliseconds = $record.timeoutMilliseconds
            environmentPolicy = $record.environmentPolicy
        })
    }

    $record = Read-JsonFile -Path $proposalPath -MissingCode 'VALIDATION_APPROVAL_INVALID'
    if ($record.id -ne $ValidationApprovalId -or $record.used -or [DateTime]::Parse($record.expiresAtUtc).ToUniversalTime() -lt [DateTime]::UtcNow) {
        Throw-ToolkitError 'VALIDATION_APPROVAL_INVALID' 'Validation approval is missing, expired, used, or does not match.'
    }
    if ($record.repository -ne $RepositoryInfo.Root -or $record.head -ne $BeforeContext.head -or $record.statusFingerprint -ne (Get-StatusFingerprint $BeforeContext)) {
        Throw-ToolkitError 'VALIDATION_APPROVAL_INVALID' 'Repository state changed after validation was proposed.'
    }
    if ((Get-FileSha256 $record.definitionPath) -ne $record.definitionSha256) {
        Throw-ToolkitError 'VALIDATION_APPROVAL_INVALID' 'The approved build definition changed.'
    }
    $record.used = $true
    Write-AtomicJson -Path $proposalPath -Value $record
    $validationResult = Invoke-NativeBytes -FileName $record.executable -Arguments @($record.arguments) -WorkingDirectory $record.workingDirectory -TimeoutMilliseconds ([int]$record.timeoutMilliseconds) -Environment (Get-CredentialEnvironmentOverrides)
    if ($validationResult.ExitCode -ne 0) {
        Throw-ToolkitError 'VALIDATION_FAILED' "Approved validator exited with code $($validationResult.ExitCode)."
    }
    $afterContext = Get-Context $RepositoryInfo
    if ((Get-StatusFingerprint $BeforeContext) -ne (Get-StatusFingerprint $afterContext)) {
        Throw-ToolkitError 'WORKTREE_DRIFT' 'Validation changed the worktree, path set, HEAD, or index.'
    }
    return [pscustomobject]@{ executable = $record.executable; exitCode = $validationResult.ExitCode }
}

function Resolve-TortoiseGit {
    $command = Get-Command TortoiseGitProc.exe -ErrorAction SilentlyContinue
    if ($null -ne $command) { return $command.Source }
    foreach ($candidate in @(
        'C:\Program Files\TortoiseGit\bin\TortoiseGitProc.exe',
        'C:\Program Files (x86)\TortoiseGit\bin\TortoiseGitProc.exe'
    )) {
        if ([System.IO.File]::Exists($candidate)) { return $candidate }
    }
    Throw-ToolkitError 'TORTOISEGIT_NOT_FOUND' 'TortoiseGitProc.exe was not found.'
}

function Start-TortoiseCommit {
    param([string]$Executable, [string[]]$Arguments)
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $Executable
    $startInfo.UseShellExecute = $false
    $startInfo.WorkingDirectory = [System.IO.Path]::GetDirectoryName($Executable)
    if ($null -ne $startInfo.PSObject.Properties['ArgumentList']) {
        foreach ($argument in $Arguments) { [void]$startInfo.ArgumentList.Add([string]$argument) }
    }
    else {
        $startInfo.Arguments = ConvertTo-WindowsCommandLine $Arguments
    }
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { Throw-ToolkitError 'PROCESS_START_FAILED' 'Failed to open TortoiseGit.' }
    return $process
}

function Invoke-OpenNextAction {
    param([object]$RepositoryInfo)
    $planPath = Join-Path $RepositoryInfo.StateDir 'plan.json'
    $statePath = Join-Path $RepositoryInfo.StateDir 'state.json'
    $contextPath = Join-Path $RepositoryInfo.StateDir 'context.json'
    $plan = Read-JsonFile -Path $planPath -MissingCode 'PLAN_INVALID'
    $state = Read-JsonFile -Path $statePath -MissingCode 'PLAN_INVALID'
    $null = Confirm-PendingCommit -RepositoryInfo $RepositoryInfo -Plan $plan -State $state
    $plan = Read-JsonFile -Path $planPath -MissingCode 'PLAN_INVALID'
    $state = Read-JsonFile -Path $statePath -MissingCode 'PLAN_INVALID'
    $group = @($plan.groups | Where-Object { $_.state -eq 'pending' }) | Select-Object -First 1
    if ($null -eq $group) {
        $state.status = 'complete'
        Write-AtomicJson -Path $statePath -Value $state
        return [pscustomobject]@{ complete = $true; commits = @($state.completedCommits) }
    }

    $savedContext = Read-JsonFile -Path $contextPath -MissingCode 'PLAN_INVALID'
    $currentContext = Get-Context $RepositoryInfo
    Assert-ContextSafety $currentContext
    Assert-ContextMatches -Saved $savedContext -Current $currentContext
    Assert-SelectedFilesSafe -RepositoryInfo $RepositoryInfo -Group $group -Context $currentContext
    $validationResult = Invoke-OptionalValidation -RepositoryInfo $RepositoryInfo -Group $group -BeforeContext $currentContext

    $executable = Resolve-TortoiseGit
    $launchId = [Guid]::NewGuid().ToString('N')
    $messagesDirectory = Join-Path $RepositoryInfo.StateDir 'messages'
    [System.IO.Directory]::CreateDirectory($messagesDirectory) | Out-Null
    $messagePath = Join-Path $messagesDirectory ($launchId + '.txt')
    Write-AtomicText -Path $messagePath -Text ([string]$group.message) -Encoding $script:Utf8Bom
    $fullPaths = @($group.paths | ForEach-Object {
        $full = [System.IO.Path]::GetFullPath((Join-Path $RepositoryInfo.Root ([string]$_).Replace('/', '\')))
        if (-not (Test-PathInsideRoot $RepositoryInfo.Root $full)) { Throw-ToolkitError 'PATH_OUTSIDE_WORKTREE' "Selected path escaped the worktree: $_" }
        $full
    })
    $arguments = @('/command:commit', ('/path:' + ($fullPaths -join '*')), ('/logmsgfile:' + $messagePath))
    $rendered = (ConvertTo-WindowsCommandLineArgument $executable) + ' ' + (ConvertTo-WindowsCommandLine $arguments) + [char]0
    if ($rendered.Length -gt $script:MaxCommandLineUnits) {
        Throw-ToolkitError 'COMMAND_LINE_TOO_LONG' "Exact TortoiseGit command exceeds $($script:MaxCommandLineUnits) UTF-16 code units."
    }
    if ($DryRun) {
        return [pscustomobject]@{
            complete = $false
            dryRun = $true
            groupId = $group.id
            message = $group.message
            paths = $group.paths
            executable = $executable
            arguments = $arguments
            renderedLength = $rendered.Length
            validation = $validationResult
        }
    }

    $group.state = 'launching'
    $state.status = 'launching'
    $state.pendingLaunch = [pscustomobject]@{
        launchId = $launchId
        groupId = $group.id
        expectedParent = $plan.currentHead
        processId = $null
        processStartUtc = $null
        messagePath = $messagePath
    }
    Write-AtomicJson -Path $planPath -Value $plan
    Write-AtomicJson -Path $statePath -Value $state
    try {
        $process = Start-TortoiseCommit -Executable $executable -Arguments $arguments
        $state.pendingLaunch.processId = $process.Id
        $state.pendingLaunch.processStartUtc = $process.StartTime.ToUniversalTime().ToString('o')
        $state.status = 'pending-confirmation'
        $group.state = 'pending-confirmation'
        Write-AtomicJson -Path $planPath -Value $plan
        Write-AtomicJson -Path $statePath -Value $state
        return [pscustomobject]@{
            complete = $false
            dryRun = $false
            groupId = $group.id
            message = $group.message
            paths = $group.paths
            processId = $process.Id
            validation = $validationResult
        }
    }
    catch {
        $group.state = 'pending'
        $state.status = 'ready'
        $state.pendingLaunch = $null
        Write-AtomicJson -Path $planPath -Value $plan
        Write-AtomicJson -Path $statePath -Value $state
        throw
    }
}

function Invoke-StatusAction {
    param([object]$RepositoryInfo)
    Recover-NormalizationJournal $RepositoryInfo
    $planPath = Join-Path $RepositoryInfo.StateDir 'plan.json'
    $statePath = Join-Path $RepositoryInfo.StateDir 'state.json'
    if (-not [System.IO.File]::Exists($planPath) -or -not [System.IO.File]::Exists($statePath)) {
        return [pscustomobject]@{ exists = $false; status = 'none' }
    }
    $plan = Read-JsonFile $planPath
    $state = Read-JsonFile $statePath
    return [pscustomobject]@{
        exists = $true
        status = $state.status
        currentHead = $plan.currentHead
        pendingLaunch = if ($null -eq $state.pendingLaunch) { $null } else {
            [pscustomobject]@{
                groupId = $state.pendingLaunch.groupId
                processId = $state.pendingLaunch.processId
                processActive = Test-ProcessIdentity $state.pendingLaunch
            }
        }
        groups = @($plan.groups | ForEach-Object { [pscustomobject]@{ id = $_.id; state = $_.state; commit = $_.commit; message = $_.message; paths = $_.paths } })
        completedCommits = @($state.completedCommits)
    }
}

function Invoke-ClearAction {
    param([object]$RepositoryInfo)
    $journalPath = Join-Path $RepositoryInfo.StateDir 'normalization-journal.json'
    if ([System.IO.File]::Exists($journalPath)) {
        Throw-ToolkitError 'RECOVERY_REQUIRED' 'Normalization recovery is pending; run Status first.'
    }
    $statePath = Join-Path $RepositoryInfo.StateDir 'state.json'
    if ([System.IO.File]::Exists($statePath)) {
        $state = Read-JsonFile $statePath
        if ($null -ne $state.pendingLaunch) {
            Throw-ToolkitError 'CONFIRMATION_REQUIRED' 'A TortoiseGit launch is pending confirmation; Clear is refused.'
        }
    }
    foreach ($item in @(Get-ChildItem -LiteralPath $RepositoryInfo.StateDir -Force -ErrorAction SilentlyContinue)) {
        if ($item.Name -eq 'lock') { continue }
        if ($item.PSIsContainer) {
            [System.IO.Directory]::Delete($item.FullName, $true)
        }
        else {
            [System.IO.File]::Delete($item.FullName)
        }
    }
    return [pscustomobject]@{ cleared = $true; stateDirectory = $RepositoryInfo.StateDir }
}

$resultEnvelope = $null
$lockHandle = $null
try {
    $repositoryInfo = Resolve-Repository $Repository
    $lockHandle = Enter-ToolkitLock $repositoryInfo
    $summary = switch ($Action) {
        'Analyze' { Recover-NormalizationJournal $repositoryInfo; Invoke-AnalyzeAction $repositoryInfo }
        'Normalize' { Invoke-NormalizeAction $repositoryInfo }
        'SavePlan' { Recover-NormalizationJournal $repositoryInfo; Invoke-SavePlanAction $repositoryInfo }
        'OpenNext' { Recover-NormalizationJournal $repositoryInfo; Invoke-OpenNextAction $repositoryInfo }
        'Status' { Invoke-StatusAction $repositoryInfo }
        'Clear' { Invoke-ClearAction $repositoryInfo }
    }
    $resultEnvelope = [pscustomobject]@{
        schemaVersion = $script:SchemaVersion
        ok = $true
        action = $Action
        summary = $summary
        warnings = @()
        errors = @()
    }
    [Console]::Out.WriteLine((ConvertTo-JsonText $resultEnvelope))
    exit 0
}
catch {
    $code = if ($_.Exception.Data.Contains('ToolkitCode')) { [string]$_.Exception.Data['ToolkitCode'] } else { 'UNEXPECTED_ERROR' }
    $details = if ($_.Exception.Data.Contains('ToolkitDetails')) { $_.Exception.Data['ToolkitDetails'] } else { $null }
    $resultEnvelope = [pscustomobject]@{
        schemaVersion = $script:SchemaVersion
        ok = $false
        action = $Action
        summary = @{}
        warnings = @()
        errors = @([pscustomobject]@{
            code = $code
            message = $_.Exception.Message
            details = $details
        })
    }
    [Console]::Out.WriteLine((ConvertTo-JsonText $resultEnvelope))
    exit 1
}
finally {
    if ($null -ne $lockHandle) { $lockHandle.Dispose() }
}
