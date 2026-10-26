Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Read-SHCompatibilityMatrix {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)
    $matrix = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    if ([int]$matrix.schemaVersion -ne 1 -or [string]::IsNullOrWhiteSpace([string]$matrix.matrixVersion)) {
        throw 'Compatibility matrix is invalid.'
    }
    foreach ($surface in @('claude', 'codex', 'desktop')) {
        $property = $matrix.runtimes.PSObject.Properties[$surface]
        if ($null -eq $property -or @($property.Value).Count -eq 0) { throw "Compatibility matrix has no $surface entries." }
        foreach ($entry in @($property.Value)) {
            if ([string]::IsNullOrWhiteSpace([string]$entry.version)) { throw "Compatibility matrix has an invalid $surface version." }
            if ($surface -eq 'desktop' -and [string]::IsNullOrWhiteSpace([string]$entry.internalBuild)) {
                throw 'Compatibility matrix has a desktop entry without an internal build.'
            }
        }
    }
    $matrix
}

function Test-SHCompatibilityInventory {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Matrix, [Parameter(Mandatory = $true)][object[]]$Runtimes)
    $issues = [Collections.Generic.List[object]]::new()
    if (@($Runtimes | Where-Object surface -eq 'claude').Count -eq 0) {
        $issues.Add([pscustomobject]@{ code = 'claude-consumer-missing'; surface = 'claude'; path = $null; observed = $null })
    }
    if (@($Runtimes | Where-Object { $_.surface -in @('codex', 'desktop') }).Count -eq 0) {
        $issues.Add([pscustomobject]@{ code = 'codex-consumer-missing'; surface = 'codex'; path = $null; observed = $null })
    }
    foreach ($runtime in $Runtimes) {
        $surface = [string]$runtime.surface
        $path = [string]$runtime.path
        $internalBuild = if ($null -eq $runtime.PSObject.Properties['internalBuild']) { '' } else { [string]$runtime.internalBuild }
        if ($surface -notin @('claude', 'codex', 'desktop')) {
            $issues.Add([pscustomobject]@{ code = 'unknown-surface'; surface = $surface; path = $path; observed = [string]$runtime.version })
            continue
        }
        if ($null -ne $runtime.PSObject.Properties['discoveryError'] -and -not [string]::IsNullOrWhiteSpace([string]$runtime.discoveryError)) {
            $issues.Add([pscustomobject]@{ code = 'runtime-discovery-incomplete'; surface = $surface; path = $path; observed = [string]$runtime.discoveryError })
        }
        $approved = $false
        foreach ($entry in @($Matrix.runtimes.PSObject.Properties[$surface].Value)) {
            if ([string]$entry.version -ne [string]$runtime.version) { continue }
            if ($surface -eq 'desktop' -and [string]$entry.internalBuild -ne $internalBuild) { continue }
            $approved = $true
            break
        }
        if (-not $approved) {
            $observed = [string]$runtime.version
            if ($surface -eq 'desktop') { $observed += '; internalBuild=' + $internalBuild }
            $issues.Add([pscustomobject]@{ code = 'runtime-version-unapproved'; surface = $surface; path = $path; observed = $observed })
        }
    }
    [pscustomobject]@{ Approved = $issues.Count -eq 0; Issues = @($issues); MatrixVersion = [string]$Matrix.matrixVersion }
}

function Get-SHExecutableVersion {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$WorkingDirectory)
    $result = Invoke-SHIsolatedProcess -Executable $Path -Arguments @('--version') -WorkingDirectory $WorkingDirectory -TimeoutMilliseconds 5000 -MaximumBytes 4096
    if ($result.TimedOut -or $result.ExitCode -ne 0) { throw "Version probe failed for $Path" }
    ([string]$result.Stdout).Trim()
}

function Find-SHDesktopAppAsar {
    [CmdletBinding()]
    param([string]$ExplicitPath)
    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
        if (Test-Path -LiteralPath $ExplicitPath -PathType Leaf) { return [IO.Path]::GetFullPath($ExplicitPath) }
        return $null
    }
    $candidates = [Collections.Generic.List[string]]::new()
    foreach ($process in @(Get-Process -Name Codex -ErrorAction SilentlyContinue)) {
        try {
            if (-not [string]::IsNullOrWhiteSpace([string]$process.Path)) {
                $candidate = Join-Path (Split-Path -Parent [string]$process.Path) 'resources\app.asar'
                if (Test-Path -LiteralPath $candidate -PathType Leaf) { $candidates.Add($candidate) }
            }
        } catch { }
    }
    $windowsApps = Join-Path $env:ProgramFiles 'WindowsApps'
    foreach ($package in @(Get-AppxPackage -AllUsers -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue)) {
        foreach ($relative in @('app\resources\app.asar', 'resources\app.asar')) {
            $candidate = Join-Path ([string]$package.InstallLocation) $relative
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { $candidates.Add($candidate) }
        }
    }
    if (Test-Path -LiteralPath $windowsApps -PathType Container) {
        foreach ($directory in @(Get-ChildItem -LiteralPath $windowsApps -Directory -Filter 'OpenAI.Codex*' -ErrorAction SilentlyContinue)) {
            foreach ($relative in @('app\resources\app.asar', 'resources\app.asar')) {
                $candidate = Join-Path $directory.FullName $relative
                if (Test-Path -LiteralPath $candidate -PathType Leaf) { $candidates.Add($candidate) }
            }
        }
    }
    if ($candidates.Count -eq 0) { return $null }
    [IO.Path]::GetFullPath(($candidates | Sort-Object -Unique | Select-Object -Last 1))
}

function Resolve-SHCodexLauncherEngine {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$LauncherPath)
    $extension = [IO.Path]::GetExtension($LauncherPath)
    if ($extension -ieq '.exe') { return [IO.Path]::GetFullPath($LauncherPath) }
    $binRoot = Split-Path -Parent ([IO.Path]::GetFullPath($LauncherPath))
    $packageRoot = Join-Path $binRoot 'node_modules\@openai\codex'
    $candidates = @(
        (Join-Path $packageRoot 'node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe'),
        (Join-Path $packageRoot 'node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\codex\codex.exe'),
        (Join-Path $packageRoot 'vendor\x86_64-pc-windows-msvc\bin\codex.exe'),
        (Join-Path $packageRoot 'vendor\x86_64-pc-windows-msvc\codex\codex.exe')
    )
    foreach ($candidate in $candidates) { if (Test-Path -LiteralPath $candidate -PathType Leaf) { return [IO.Path]::GetFullPath($candidate) } }
    $null
}

function Get-SHCodexLaunchers {
    [CmdletBinding()]
    param()
    $paths = [Collections.Generic.List[string]]::new()
    foreach ($command in @(Get-Command -All codex -ErrorAction SilentlyContinue)) {
        if (-not [string]::IsNullOrWhiteSpace([string]$command.Source) -and (Test-Path -LiteralPath ([string]$command.Source) -PathType Leaf)) { $paths.Add([IO.Path]::GetFullPath([string]$command.Source)) }
    }
    foreach ($scope in @('Process', 'User', 'Machine')) {
        $pathValue = [Environment]::GetEnvironmentVariable('Path', $scope)
        foreach ($directoryText in @([string]$pathValue -split ';')) {
            if ([string]::IsNullOrWhiteSpace($directoryText)) { continue }
            try { $directory = [Environment]::ExpandEnvironmentVariables($directoryText.Trim().Trim('"')) } catch { continue }
            if (-not (Test-Path -LiteralPath $directory -PathType Container)) { continue }
            foreach ($name in @('codex.exe', 'codex.cmd', 'codex.ps1')) {
                $candidate = Join-Path $directory $name
                if (Test-Path -LiteralPath $candidate -PathType Leaf) { $paths.Add([IO.Path]::GetFullPath($candidate)) }
            }
        }
    }
    @($paths | Sort-Object -Unique)
}

function Get-SHDesktopEngineCandidates {
    [CmdletBinding()]
    param([string]$LocalApplicationDataPath, [string]$DesktopAppAsarPath)
    $local = if ([string]::IsNullOrWhiteSpace($LocalApplicationDataPath)) { [Environment]::GetFolderPath('LocalApplicationData') } else { $LocalApplicationDataPath }
    $candidates = [Collections.Generic.List[string]]::new()
    if (-not [string]::IsNullOrWhiteSpace($local)) {
        $binRoot = Join-Path $local 'OpenAI\Codex\bin'
        foreach ($process in @(Get-Process -Name Codex -ErrorAction SilentlyContinue)) {
            try {
                $path = [string]$process.Path
                if (-not [string]::IsNullOrWhiteSpace($path) -and $path.StartsWith($binRoot, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $path -PathType Leaf)) {
                    $candidates.Add([IO.Path]::GetFullPath($path))
                }
            } catch { }
        }
        if (Test-Path -LiteralPath $binRoot -PathType Container) {
            foreach ($directory in @(Get-ChildItem -LiteralPath $binRoot -Directory -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending)) {
                $path = Join-Path $directory.FullName 'codex.exe'
                if (Test-Path -LiteralPath $path -PathType Leaf) { $candidates.Add([IO.Path]::GetFullPath($path)) }
            }
        }
    }
    $asar = Find-SHDesktopAppAsar $DesktopAppAsarPath
    if (-not [string]::IsNullOrWhiteSpace($asar)) {
        $appRoot = Split-Path -Parent (Split-Path -Parent $asar)
        foreach ($relative in @('resources\codex.exe')) {
            $path = Join-Path $appRoot $relative
            if (Test-Path -LiteralPath $path -PathType Leaf) { $candidates.Add([IO.Path]::GetFullPath($path)) }
        }
    }
    $seen = @{}
    $ordered = [Collections.Generic.List[string]]::new()
    foreach ($candidate in $candidates) {
        $key = $candidate.ToLowerInvariant()
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        $ordered.Add($candidate)
    }
    @($ordered)
}

function Get-SHRuntimeInventory {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$FrameworkRoot,
        [string]$DesktopAppAsarPath,
        [string]$LocalApplicationDataPath
    )
    $workingDirectory = Split-Path -Parent $FrameworkRoot
    $records = [Collections.Generic.List[object]]::new()
    $seen = @{}
    $claude = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $claude) {
        $path = [IO.Path]::GetFullPath([string]$claude.Source)
        $seen[$path.ToLowerInvariant()] = $true
        try {
            $records.Add([pscustomobject]@{ surface = 'claude'; path = $path; version = Get-SHExecutableVersion $path $workingDirectory; file = Get-SHFileIdentity $path })
        } catch {
            $records.Add([pscustomobject]@{ surface = 'claude'; path = $path; version = $null; discoveryError = 'version-or-identity-unavailable' })
        }
    }
    $localAppData = if ([string]::IsNullOrWhiteSpace($LocalApplicationDataPath)) { [Environment]::GetFolderPath('LocalApplicationData') } else { $LocalApplicationDataPath }
    $desktopBin = if ([string]::IsNullOrWhiteSpace($localAppData)) { $null } else { [IO.Path]::GetFullPath((Join-Path $localAppData 'OpenAI\Codex\bin')).TrimEnd('\') + '\' }
    $appAsarPath = Find-SHDesktopAppAsar $DesktopAppAsarPath
    foreach ($launcherPath in @(Get-SHCodexLaunchers)) {
        $path = Resolve-SHCodexLauncherEngine $launcherPath
        if ([string]::IsNullOrWhiteSpace($path)) {
            $launcherKey = ([IO.Path]::GetFullPath($launcherPath)).ToLowerInvariant()
            if (-not $seen.ContainsKey($launcherKey)) {
                $seen[$launcherKey] = $true
                $records.Add([pscustomobject]@{ surface = 'codex'; path = [IO.Path]::GetFullPath($launcherPath); launcherPath = [IO.Path]::GetFullPath($launcherPath); version = $null; discoveryError = 'launcher-engine-unresolved' })
            }
            continue
        }
        $key = $path.ToLowerInvariant()
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        $surface = if ($null -ne $desktopBin -and $path.StartsWith($desktopBin, [StringComparison]::OrdinalIgnoreCase)) { 'desktop' } else { 'codex' }
        try {
            $record = [ordered]@{ surface = $surface; path = $path; launcherPath = [IO.Path]::GetFullPath($launcherPath); version = Get-SHExecutableVersion $path $workingDirectory; file = Get-SHFileIdentity $path }
            if ($surface -eq 'desktop') {
                if ([string]::IsNullOrWhiteSpace($appAsarPath)) { $record.discoveryError = 'desktop-app-asar-unavailable' }
                else {
                    $metadata = Get-SHAsarPackageMetadata $appAsarPath
                    $record.internalBuild = $metadata.InternalBuild
                    $record.appAsar = [pscustomobject]@{
                        file = Get-SHFileIdentity $appAsarPath
                        dataOffset = $metadata.DataOffset
                        packageOffset = $metadata.PackageOffset
                        packageSize = $metadata.PackageSize
                        internalBuild = $metadata.InternalBuild
                    }
                }
            }
            $records.Add([pscustomobject]$record)
        } catch {
            $records.Add([pscustomobject]@{ surface = $surface; path = $path; version = $null; discoveryError = 'version-or-identity-unavailable' })
        }
    }
    if (@($records | Where-Object surface -eq 'desktop').Count -eq 0) {
        $desktopCandidates = @(Get-SHDesktopEngineCandidates -LocalApplicationDataPath $localAppData -DesktopAppAsarPath $DesktopAppAsarPath)
        $desktopRecorded = $false
        foreach ($candidate in $desktopCandidates) {
            $key = ([IO.Path]::GetFullPath($candidate)).ToLowerInvariant()
            if ($seen.ContainsKey($key)) { continue }
            $seen[$key] = $true
            try {
                $record = [ordered]@{ surface = 'desktop'; path = [IO.Path]::GetFullPath($candidate); launcherPath = [IO.Path]::GetFullPath($candidate); version = Get-SHExecutableVersion $candidate $workingDirectory; file = Get-SHFileIdentity $candidate }
                if ([string]::IsNullOrWhiteSpace($appAsarPath)) { $record.discoveryError = 'desktop-app-asar-unavailable' }
                else {
                    $metadata = Get-SHAsarPackageMetadata $appAsarPath
                    $record.internalBuild = $metadata.InternalBuild
                    $record.appAsar = [pscustomobject]@{
                        file = Get-SHFileIdentity $appAsarPath
                        dataOffset = $metadata.DataOffset
                        packageOffset = $metadata.PackageOffset
                        packageSize = $metadata.PackageSize
                        internalBuild = $metadata.InternalBuild
                    }
                }
                $records.Add([pscustomobject]$record)
                $desktopRecorded = $true
                break
            } catch { }
        }
        if (-not $desktopRecorded -and $desktopCandidates.Count -gt 0) {
            $records.Add([pscustomobject]@{ surface = 'desktop'; path = [IO.Path]::GetFullPath($desktopCandidates[0]); version = $null; discoveryError = 'version-or-identity-unavailable' })
        }
    }
    @($records)
}

function New-SHOwnedHookCommand {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$PowerShellPath,
        [Parameter(Mandatory = $true)][string]$HookScriptPath
    )
    foreach ($path in @($PowerShellPath, $HookScriptPath)) {
        if ($path.Contains('"')) { throw 'Hook command paths cannot contain quotation marks.' }
        if (-not [IO.Path]::IsPathRooted($path)) { throw 'Hook command paths must be resolved during installation.' }
    }
    '"{0}" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{1}" -Owner AIStartupHealthV1' -f [IO.Path]::GetFullPath($PowerShellPath), [IO.Path]::GetFullPath($HookScriptPath)
}

function Invoke-SHConfigEditor {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$NodePath,
        [Parameter(Mandatory = $true)][ValidateSet('install', 'remove')][string]$Action,
        [Parameter(Mandatory = $true)][string]$InputPath,
        [Parameter(Mandatory = $true)][string]$OutputPath,
        [string]$Command,
        [Parameter(Mandatory = $true)][string]$FrameworkRoot
    )
    $editor = Join-Path $FrameworkRoot 'tools\config-editor.mjs'
    $arguments = @($editor, $Action, '--input', $InputPath, '--output', $OutputPath)
    if ($Action -eq 'install') { $arguments += @('--command', $Command) }
    $result = Invoke-SHIsolatedProcess -Executable $NodePath -Arguments $arguments -WorkingDirectory (Join-Path $FrameworkRoot 'tools') -TimeoutMilliseconds 5000 -MaximumBytes 8192
    if ($result.TimedOut -or $result.ExitCode -ne 0) { throw "Configuration editor failed: $($result.Stderr)" }
    ([string]$result.Stdout).Trim() | ConvertFrom-Json
}

function Get-SHFileStamp {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return [pscustomobject]@{ exists = $false; path = [IO.Path]::GetFullPath($Path) } }
    $item = Get-Item -LiteralPath $Path
    [pscustomobject]@{
        exists = $true
        path = [IO.Path]::GetFullPath($Path)
        length = [int64]$item.Length
        lastWriteUtcTicks = [int64]$item.LastWriteTimeUtc.Ticks
        sha256 = Get-SHSha256 -Path $Path
    }
}

function Test-SHFileStamp {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Expected, [Parameter(Mandatory = $true)][string]$Path)
    $actual = Get-SHFileStamp $Path
    if ([bool]$Expected.exists -ne [bool]$actual.exists) { return $false }
    if (-not [bool]$Expected.exists) { return $true }
    [int64]$Expected.length -eq [int64]$actual.length -and
        [int64]$Expected.lastWriteUtcTicks -eq [int64]$actual.lastWriteUtcTicks -and
        [string]$Expected.sha256 -eq [string]$actual.sha256
}

function New-SHTransactionFileRecord {
    param([Parameter(Mandatory = $true)][string]$Path)
    $exists = Test-Path -LiteralPath $Path -PathType Leaf
    [pscustomobject]@{
        Path = $Path
        Existed = $exists
        OriginalBytes = if ($exists) { [IO.File]::ReadAllBytes($Path) } else { $null }
        OriginalAcl = if ($exists) { Get-Acl -LiteralPath $Path } else { $null }
        OriginalSha256 = if ($exists) { Get-SHSha256 -Path $Path } else { $null }
        InstalledSha256 = $null
        Changed = $false
    }
}

function Write-SHTransactionalJson {
    param([Parameter(Mandatory = $true)]$Record, [Parameter(Mandatory = $true)]$Value)
    $json = ($Value | ConvertTo-Json -Depth 30) + [Environment]::NewLine
    $Record.InstalledSha256 = Get-SHSha256 -Text $json
    $Record.Changed = $true
    Write-SHAtomicJson $Record.Path $Value
}

function Restore-SHTransactionFile {
    param([Parameter(Mandatory = $true)]$Record)
    if (-not $Record.Changed) { return }
    $exists = Test-Path -LiteralPath $Record.Path -PathType Leaf
    if ($Record.Existed -and $exists -and (Get-SHSha256 -Path $Record.Path) -eq $Record.OriginalSha256) { return }
    if (-not $Record.Existed -and -not $exists) { return }
    if (-not $exists -or (Get-SHSha256 -Path $Record.Path) -ne $Record.InstalledSha256) {
        throw "Transactional state changed concurrently; manual recovery is required: $($Record.Path)"
    }
    if (-not $Record.Existed) {
        Remove-Item -LiteralPath $Record.Path -Force
        return
    }
    $directory = Split-Path -Parent $Record.Path
    $temporary = Join-Path $directory ('.startup-health-state-restore-' + [Guid]::NewGuid().ToString('N'))
    $discard = $temporary + '.discard'
    try {
        [IO.File]::WriteAllBytes($temporary, $Record.OriginalBytes)
        [IO.File]::Replace($temporary, $Record.Path, $discard, $true)
        Set-Acl -LiteralPath $Record.Path -AclObject $Record.OriginalAcl
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
        if (Test-Path -LiteralPath $discard) { Remove-Item -LiteralPath $discard -Force }
    }
}

function Install-SHHookTransaction {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object[]]$Targets,
        [Parameter(Mandatory = $true)][string]$StateRoot,
        [Parameter(Mandatory = $true)]$Manifest,
        [string]$MutexName
    )
    $mutex = Enter-SHMutex -NameOverride $MutexName -WaitMilliseconds 10000
    if (-not $mutex.Acquired) { throw 'Another startup-health install or runner owns the control mutex.' }
    $installed = [Collections.Generic.List[object]]::new()
    $stateRecords = [Collections.Generic.List[object]]::new()
    $committed = $false
    try {
        if (-not (Test-Path -LiteralPath $StateRoot -PathType Container)) { [IO.Directory]::CreateDirectory($StateRoot) | Out-Null }
        foreach ($target in $Targets) {
            if (-not (Test-SHFileStamp $target.sourceStamp ([string]$target.configPath))) {
                throw "Hook configuration changed after candidate validation: $($target.configPath)"
            }
        }

        $modeRecord = New-SHTransactionFileRecord (Join-Path $StateRoot 'mode.json')
        $stateRecords.Add($modeRecord)
        Write-SHTransactionalJson $modeRecord ([ordered]@{ schemaVersion = 1; autoStart = 'warn-only'; generation = [string]$Manifest.generation })
        $activationStatus = if ($null -ne $Manifest.PSObject.Properties['installed'] -and -not [bool]$Manifest.installed) { 'uninstalled' } else { 'pending' }
        $activationState = [ordered]@{ schemaVersion = 1; generation = [string]$Manifest.generation; status = $activationStatus; surfaces = [ordered]@{} }
        if ($activationStatus -eq 'uninstalled') { $activationState.uninstalledAt = [DateTimeOffset]::UtcNow.ToString('O') }
        $activationRecord = New-SHTransactionFileRecord (Join-Path $StateRoot 'activation.json')
        $stateRecords.Add($activationRecord)
        Write-SHTransactionalJson $activationRecord $activationState
        foreach ($ledgerName in @('start-attempts.json', 'last-notified.json')) {
            $ledgerPath = Join-Path $StateRoot $ledgerName
            if (-not (Test-Path -LiteralPath $ledgerPath -PathType Leaf)) {
                $ledgerRecord = New-SHTransactionFileRecord $ledgerPath
                $stateRecords.Add($ledgerRecord)
                Write-SHTransactionalJson $ledgerRecord ([ordered]@{ schemaVersion = 1 })
            }
        }
        foreach ($target in $Targets) {
            $configPath = [string]$target.configPath
            $candidatePath = [string]$target.candidatePath
            $directory = Split-Path -Parent $configPath
            if (-not (Test-Path -LiteralPath $directory -PathType Container)) { [IO.Directory]::CreateDirectory($directory) | Out-Null }
            $backupPath = Join-Path $directory ('.startup-health-backup-' + [Guid]::NewGuid().ToString('N'))
            if ([bool]$target.sourceStamp.exists) {
                try { Set-Acl -LiteralPath $candidatePath -AclObject (Get-Acl -LiteralPath $configPath) } catch { throw "Unable to preserve hook configuration ACL: $configPath" }
                [IO.File]::Replace($candidatePath, $configPath, $backupPath, $true)
            } else {
                # Create the file in the target directory so it inherits the parent's ACL,
                # then move it into place without replacing an existing destination.
                $sameDirectoryCandidate = Join-Path $directory ('.startup-health-candidate-' + [Guid]::NewGuid().ToString('N') + '.tmp')
                try {
                    [IO.File]::WriteAllBytes($sameDirectoryCandidate, [IO.File]::ReadAllBytes($candidatePath))
                    [IO.File]::Move($sameDirectoryCandidate, $configPath)
                } finally {
                    if (Test-Path -LiteralPath $sameDirectoryCandidate) { Remove-Item -LiteralPath $sameDirectoryCandidate -Force }
                }
            }
            $installed.Add([pscustomobject]@{
                configPath = $configPath
                backupPath = $backupPath
                sourceExisted = [bool]$target.sourceStamp.exists
                installedSha256 = Get-SHSha256 -Path $configPath
            })
        }
        $manifestRecord = New-SHTransactionFileRecord (Join-Path $StateRoot 'install-manifest.json')
        $stateRecords.Add($manifestRecord)
        Write-SHTransactionalJson $manifestRecord $Manifest
        $committed = $true
        foreach ($record in $installed) {
            if ($record.sourceExisted -and (Test-Path -LiteralPath $record.backupPath)) {
                try { Remove-Item -LiteralPath $record.backupPath -Force } catch { }
            }
        }
        [pscustomobject]@{ Installed = $true; Targets = @($installed) }
    } catch {
        $installError = $_
        $rollbackErrors = [Collections.Generic.List[string]]::new()
        for ($index = $installed.Count - 1; $index -ge 0; $index--) {
            $record = $installed[$index]
            try {
                if (-not (Test-Path -LiteralPath $record.configPath -PathType Leaf) -or (Get-SHSha256 -Path $record.configPath) -ne $record.installedSha256) {
                    throw "Installed hook changed concurrently; manual recovery is required: $($record.configPath)"
                }
                if ($record.sourceExisted) {
                    $discard = $record.backupPath + '.discard'
                    [IO.File]::Replace($record.backupPath, $record.configPath, $discard, $true)
                    if (Test-Path -LiteralPath $discard) { Remove-Item -LiteralPath $discard -Force }
                } else { Remove-Item -LiteralPath $record.configPath -Force }
            } catch { $rollbackErrors.Add($_.Exception.Message) }
        }
        if (-not $committed -and $rollbackErrors.Count -eq 0) {
            for ($index = $stateRecords.Count - 1; $index -ge 0; $index--) {
                try { Restore-SHTransactionFile $stateRecords[$index] }
                catch { $rollbackErrors.Add($_.Exception.Message) }
            }
        }
        if ($rollbackErrors.Count -gt 0) {
            throw "$($installError.Exception.Message) Rollback failed: $($rollbackErrors -join '; ')"
        }
        throw $installError
    } finally { Exit-SHMutex $mutex }
}

Export-ModuleMember -Function Read-SHCompatibilityMatrix, Test-SHCompatibilityInventory, Get-SHExecutableVersion, Find-SHDesktopAppAsar, Resolve-SHCodexLauncherEngine, Get-SHCodexLaunchers, Get-SHDesktopEngineCandidates, Get-SHRuntimeInventory, New-SHOwnedHookCommand, Invoke-SHConfigEditor, Get-SHFileStamp, Test-SHFileStamp, Install-SHHookTransaction
