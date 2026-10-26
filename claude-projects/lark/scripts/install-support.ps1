Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}

function Get-TextSha256([string]$Text) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        ([BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::Unicode.GetBytes($Text)))).Replace('-', '').ToLowerInvariant()
    } finally { $algorithm.Dispose() }
}

function Assert-NoReparsePoint([string]$Path) {
    $currentPath = $Path
    while (-not [string]::IsNullOrWhiteSpace($currentPath)) {
        $current = Get-Item -LiteralPath $currentPath -Force
        if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Path crosses a reparse point: $($current.FullName)" }
        $parent = Split-Path -Parent $currentPath
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $currentPath) { break }
        $currentPath = $parent
    }
}

function Resolve-RegularExecutable([string]$Path, [string]$Label) {
    if ([string]::IsNullOrWhiteSpace($Path)) { throw "$Label path is empty." }
    $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    $item = Get-Item -LiteralPath $resolved -Force
    if ($item.PSIsContainer -or $item.Extension -ine '.exe') { throw "$Label is not a regular .exe file: $resolved" }
    Assert-NoReparsePoint $resolved
    $resolved
}

function Invoke-CapabilityProbe([string]$Path, [string[]]$Arguments, [string]$Pattern, [string]$Label) {
    $output = & $Path @Arguments 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or $output -notmatch $Pattern) { throw "$Label capability probe failed: $Path" }
    $output.Trim()
}

function Resolve-ExecutableCandidate {
    param([string]$Label, [string]$ExplicitPath, [string[]]$KnownPaths, [string[]]$CommandNames, [string[]]$ProbeArguments, [string]$ProbePattern)
    $groups = [Collections.Generic.List[object]]::new()
    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
        $groups.Add(@($ExplicitPath))
    } else {
        $known = @($KnownPaths | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -Unique)
        if ($known.Count) { $groups.Add($known) }
        $commands = @(
            foreach ($name in $CommandNames) {
                Get-Command $name -CommandType Application -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source }
            }
        ) | Where-Object { $_ } | Select-Object -Unique
        if (@($commands).Count) { $groups.Add(@($commands)) }
    }
    foreach ($group in $groups) {
        $valid = @()
        foreach ($candidate in $group) {
            try {
                $resolved = Resolve-RegularExecutable ([string]$candidate) $Label
                [void](Invoke-CapabilityProbe $resolved $ProbeArguments $ProbePattern $Label)
                $valid += $resolved
            } catch { if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) { throw } }
        }
        $valid = @($valid | Select-Object -Unique)
        if ($valid.Count -gt 1) { throw "Multiple valid $Label installations were found; pass an explicit path." }
        if ($valid.Count -eq 1) { return $valid[0] }
    }
    throw "$Label was not found or failed its capability probe. Pass an explicit path."
}

function Get-InstalledExecutables([System.Collections.IDictionary]$Overrides) {
    $programFiles = [Environment]::GetFolderPath('ProgramFiles')
    $programData = [Environment]::GetFolderPath('CommonApplicationData')
    $profile = [Environment]::GetFolderPath('UserProfile')
    $roaming = [Environment]::GetFolderPath('ApplicationData')
    $result = [ordered]@{}
    $errors = [Collections.Generic.List[string]]::new()
    try {
        $result.node = Resolve-ExecutableCandidate 'Node.js' $Overrides.Node @((Join-Path $programFiles 'nodejs\node.exe')) @('node.exe') @('--version') '^v\d+\.'
        $nodeVersion = Invoke-CapabilityProbe $result.node @('--version') '^v(?<major>\d+)\.' 'Node.js'
        $major = [int]([regex]::Match($nodeVersion, '^v(?<major>\d+)\.').Groups['major'].Value)
        if ($major -lt 24) { throw "Node.js 24 or newer is required: $nodeVersion" }
    } catch { $errors.Add($_.Exception.Message) }
    try {
        $result.larkCli = Resolve-ExecutableCandidate 'Lark CLI' $Overrides.LarkCli @(
            (Join-Path $roaming 'npm\node_modules\@larksuite\cli\bin\lark-cli.exe'),
            (Join-Path $profile '.local\bin\lark-cli.exe')
        ) @('lark-cli.exe') @('--help') '(?i)lark|feishu|usage'
    } catch { $errors.Add($_.Exception.Message) }
    try { $result.claude = Resolve-ExecutableCandidate 'Claude Code' $Overrides.Claude @((Join-Path $profile '.local\bin\claude.exe')) @('claude.exe') @('--version') '(?i)claude|\d+\.\d+' }
    catch { $errors.Add($_.Exception.Message) }
    try { $result.ffmpeg = Resolve-ExecutableCandidate 'FFmpeg' $Overrides.Ffmpeg @((Join-Path $programData 'chocolatey\bin\ffmpeg.exe')) @('ffmpeg.exe') @('-version') '(?i)^ffmpeg version' }
    catch { $errors.Add($_.Exception.Message) }
    try { $result.svn = Resolve-ExecutableCandidate 'SVN' $Overrides.Svn @((Join-Path $programFiles 'TortoiseSVN\bin\svn.exe')) @('svn.exe') @('--version','--quiet') '^\d+\.\d+' }
    catch { $errors.Add($_.Exception.Message) }
    if ($errors.Count) { throw ("Dependency discovery failed:`r`n- " + ($errors -join "`r`n- ")) }
    $result
}

function ConvertTo-JsonText($Value) { ($Value | ConvertTo-Json -Depth 30) + "`r`n" }

function Read-JsonObject([string]$Path, $Default) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $Default }
    Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
}

function ConvertTo-ClaudeSlashPath([string]$Path) { $Path.Replace('\', '/') }

function ConvertTo-ClaudeReadPath([string]$Path) {
    $slash = ConvertTo-ClaudeSlashPath $Path
    if ($slash -match '^([A-Za-z]):/(.*)$') { return ('//{0}/{1}' -f $Matches[1].ToLowerInvariant(), $Matches[2]) }
    $slash
}

function Get-ManagedClaudePermissions([System.Collections.IDictionary]$Executables) {
    $lark = ConvertTo-ClaudeSlashPath $Executables.larkCli
    $claudeBin = ConvertTo-ClaudeReadPath (Split-Path -Parent $Executables.claude)
    $voiceNative = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Temp\voice-test'
    $voice = ConvertTo-ClaudeReadPath $voiceNative
    $voiceBody = (Join-Path $voiceNative 'pcm-body.json').Replace('\', '\\')
    @(
        ('Bash("{0}" im *)' -f $lark),
        ('Bash("{0}" --help)' -f $lark),
        ('Bash("{0}" schema *)' -f $lark),
        ('Bash("{0}" api *)' -f $lark),
        ('Bash(MSYS_NO_PATHCONV=1 "{0}" skills list)' -f $lark),
        ('Read({0}/**)' -f $claudeBin),
        ('Read({0}/**)' -f $voice),
        ('Bash(MSYS_NO_PATHCONV=1 "{0}" api POST /open-apis/speech_to_text/v1/speech/file_recognize --data ''@{1}'' --as bot 2>&1 | head -12)' -f $lark, $voiceBody)
    )
}

function New-ClaudeSettingsContent {
    param([string]$SettingsPath, [string]$StatePath, [System.Collections.IDictionary]$Executables, [string]$Generation)
    $settings = Read-JsonObject $SettingsPath ([pscustomobject]@{})
    if ($null -eq $settings.PSObject.Properties['permissions']) { $settings | Add-Member NoteProperty permissions ([pscustomobject]@{}) }
    if ($null -eq $settings.permissions.PSObject.Properties['allow']) { $settings.permissions | Add-Member NoteProperty allow @() }
    $allow = [Collections.Generic.List[string]]::new()
    foreach ($entry in @($settings.permissions.allow)) { if ($entry -is [string] -and -not $allow.Contains($entry)) { $allow.Add($entry) } }
    $priorState = Read-JsonObject $StatePath $null
    $priorManaged = if ($null -ne $priorState -and $null -ne $priorState.PSObject.Properties['managedPermissions']) { @($priorState.managedPermissions) } else { @() }
    foreach ($entry in $priorManaged) { [void]$allow.Remove([string]$entry) }
    $owned = [Collections.Generic.List[string]]::new()
    foreach ($entry in (Get-ManagedClaudePermissions $Executables)) {
        if (-not $allow.Contains($entry)) { $allow.Add($entry); $owned.Add($entry) }
    }
    $settings.permissions.allow = @($allow)
    [pscustomobject]@{
        settings = $settings
        state = [ordered]@{ schemaVersion = 1; installationGeneration = $Generation; managedPermissions = @($owned) }
    }
}

function Write-TextFile([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}

function Enter-InstallationLock([string]$ProjectRoot) {
    $runDirectory = Join-Path $ProjectRoot 'run'
    New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null
    try {
        [IO.File]::Open((Join-Path $runDirectory 'install.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch { throw 'Another gateway installation or recovery is already running.' }
}

function Get-TaskXml([string]$TaskName) {
    if ($null -eq (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) { return $null }
    Export-ScheduledTask -TaskName $TaskName
}

function Test-ProposedTask($Task, $Manifest) {
    if ($null -eq $Task -or @($Task.Actions).Count -ne 1) { return $false }
    $action = @($Task.Actions)[0]
    $triggers = @($Task.Triggers)
    [string]$action.Execute -ieq [string]$Manifest.proposedTask.execute -and
        [string]$action.Arguments -eq [string]$Manifest.proposedTask.arguments -and
        [string]$action.WorkingDirectory -ieq [string]$Manifest.proposedTask.workingDirectory -and
        [string]$Task.Principal.UserId -ieq [string]$Manifest.proposedTask.user -and
        $triggers.Count -eq 1 -and
        [string]$triggers[0].CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' -and
        [string]$triggers[0].UserId -ieq [string]$Manifest.proposedTask.user
}

function Get-TransactionProcess($Manifest, [string]$TransactionRoot) {
    $identityPath = Join-Path $TransactionRoot 'process-identity.json'
    if (Test-Path -LiteralPath $identityPath -PathType Leaf) {
        try {
            $identity = Get-Content -Raw -LiteralPath $identityPath | ConvertFrom-Json
            if ([string]$identity.generation -eq [string]$Manifest.generation) {
                $process = Get-Process -Id ([int]$identity.pid) -ErrorAction Stop
                $start = $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
                $cim = Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$identity.pid) -ErrorAction Stop
                if ($start -eq [string]$identity.procStart -and
                    [string]$cim.ExecutablePath -ieq [string]$Manifest.proposedTask.execute -and
                    [string]$cim.CommandLine -like ('*' + [string]$Manifest.generation + '*') -and
                    [string]$cim.CommandLine -like ('*' + [string]$Manifest.proposedTask.entryPoint + '*')) {
                    return [pscustomobject]@{ process = $process; start = $start }
                }
            }
        } catch { }
    }
    $name = [IO.Path]::GetFileName([string]$Manifest.proposedTask.execute).Replace("'", "''")
    $matches = @(Get-CimInstance Win32_Process -Filter "Name='$name'" -ErrorAction SilentlyContinue | Where-Object {
        [string]$_.ExecutablePath -ieq [string]$Manifest.proposedTask.execute -and
        [string]$_.CommandLine -like ('*' + [string]$Manifest.generation + '*') -and
        [string]$_.CommandLine -like ('*' + [string]$Manifest.proposedTask.entryPoint + '*')
    })
    if ($matches.Count -gt 1) { throw 'Multiple processes match the active installation generation.' }
    if ($matches.Count -eq 0) { return $null }
    $process = Get-Process -Id ([int]$matches[0].ProcessId) -ErrorAction Stop
    [pscustomobject]@{ process = $process; start = $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() }
}

function Restore-InstallationTransaction([string]$ProjectRoot, [string]$TaskName) {
    $transactionRoot = Join-Path $ProjectRoot 'run\install-transaction'
    $activePath = Join-Path $transactionRoot 'active.json'
    if (-not (Test-Path -LiteralPath $activePath -PathType Leaf)) {
        Get-ChildItem -LiteralPath $transactionRoot -Directory -Filter 'pending-*' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
        foreach ($directory in @((Join-Path $ProjectRoot 'config'), (Join-Path $ProjectRoot '.claude'))) {
            Get-ChildItem -LiteralPath $directory -File -Filter '.install-*.tmp' -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match '^\.install-[a-fA-F0-9]{32}-(gateway|projects|settings|state)\.tmp$' } |
                Remove-Item -Force
        }
        return
    }
    $manifest = Get-Content -Raw -LiteralPath $activePath | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or [string]$manifest.generation -notmatch '^[a-fA-F0-9]{32}$') { throw 'The active installation recovery journal is invalid; manual recovery is required.' }
    $fixedTargets = @{
        gateway = Join-Path $ProjectRoot 'config\gateway.local.json'; projects = Join-Path $ProjectRoot 'config\projects.local.json'
        settings = Join-Path $ProjectRoot '.claude\settings.local.json'; state = Join-Path $ProjectRoot '.claude\install-state.local.json'
    }
    foreach ($target in @($manifest.targets)) {
        if (-not $fixedTargets.ContainsKey([string]$target.id)) { throw 'Recovery journal contains an unknown target.' }
        if ($target.existed) {
            $backup = Join-Path ([string]$manifest.backupDirectory) ([string]$target.backupFile)
            if (-not (Test-Path -LiteralPath $backup -PathType Leaf) -or (Get-Item $backup).Length -ne [long]$target.length -or (Get-Sha256 $backup) -ne [string]$target.sha256) {
                throw 'Recovery backup validation failed; manual recovery is required.'
            }
        }
    }
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $currentXml = if ($null -ne $task) { Export-ScheduledTask -TaskName $TaskName } else { $null }
    $priorMatch = $manifest.priorTask.existed -and $null -ne $currentXml -and (Get-TextSha256 $currentXml) -eq [string]$manifest.priorTask.sha256
    $proposedMatch = Test-ProposedTask $task $manifest
    if ($null -ne $task -and -not $priorMatch -and -not $proposedMatch) { throw 'Scheduled Task differs from both the prior and proposed installation; manual recovery is required.' }
    if ($proposedMatch -and [string]$task.State -ne 'Disabled') { Disable-ScheduledTask -TaskName $TaskName | Out-Null }
    $transactionProcess = Get-TransactionProcess $manifest $transactionRoot
    if ($null -ne $transactionProcess) {
        $pid = $transactionProcess.process.Id
        if ((Get-Process -Id $pid -ErrorAction Stop).StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne $transactionProcess.start) { throw 'Installation process identity changed during recovery.' }
        Stop-Process -Id $pid -Force
        $transactionProcess.process.WaitForExit(10000)
    }
    foreach ($target in @($manifest.targets)) {
        $destination = $fixedTargets[[string]$target.id]
        if ($target.existed) { Copy-Item -LiteralPath (Join-Path ([string]$manifest.backupDirectory) ([string]$target.backupFile)) -Destination $destination -Force }
        elseif (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Force }
    }
    if ($manifest.priorTask.existed) { Register-ScheduledTask -TaskName $TaskName -Xml ([string]$manifest.priorTask.xml) -Force | Out-Null }
    elseif ($null -ne (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
    Remove-Item -LiteralPath $transactionRoot -Recurse -Force
}

function New-InstallationTransaction {
    param([string]$ProjectRoot, [string]$TaskName, [string]$Generation, [System.Collections.IDictionary]$Contents, [System.Collections.IDictionary]$ProposedTask)
    $transactionRoot = Join-Path $ProjectRoot 'run\install-transaction'
    $pending = Join-Path $transactionRoot ('pending-' + $Generation)
    $backupDirectory = Join-Path $pending 'backups'
    New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
    $destinations = [ordered]@{
        gateway = Join-Path $ProjectRoot 'config\gateway.local.json'; projects = Join-Path $ProjectRoot 'config\projects.local.json'
        settings = Join-Path $ProjectRoot '.claude\settings.local.json'; state = Join-Path $ProjectRoot '.claude\install-state.local.json'
    }
    $targets = @()
    foreach ($id in $destinations.Keys) {
        $destination = $destinations[$id]
        $proposal = Join-Path (Split-Path -Parent $destination) ('.install-' + $Generation + '-' + $id + '.tmp')
        Write-TextFile $proposal ([string]$Contents[$id])
        if (Test-Path -LiteralPath $destination -PathType Leaf) {
            $backupName = $id + '.bak'; $backupPath = Join-Path $backupDirectory $backupName
            Copy-Item -LiteralPath $destination -Destination $backupPath
            $targets += [ordered]@{ id = $id; existed = $true; backupFile = $backupName; length = (Get-Item $backupPath).Length; sha256 = Get-Sha256 $backupPath; proposal = $proposal }
        } else { $targets += [ordered]@{ id = $id; existed = $false; backupFile = $null; length = 0; sha256 = $null; proposal = $proposal } }
    }
    $priorXml = Get-TaskXml $TaskName
    $priorTask = if ($null -eq $priorXml) { [ordered]@{ existed = $false; xml = $null; sha256 = $null } }
        else { [ordered]@{ existed = $true; xml = $priorXml; sha256 = Get-TextSha256 $priorXml } }
    $manifest = [ordered]@{ schemaVersion = 1; generation = $Generation; backupDirectory = $backupDirectory; targets = $targets; priorTask = $priorTask; proposedTask = $ProposedTask }
    $pendingManifest = Join-Path $pending 'manifest.json'
    Write-TextFile $pendingManifest (ConvertTo-JsonText $manifest)
    Move-Item -LiteralPath $pendingManifest -Destination (Join-Path $transactionRoot 'active.json')
    $manifest
}
