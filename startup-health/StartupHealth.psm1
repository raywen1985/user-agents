Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:IdentifierPattern = '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$'
$script:KnownSurfaces = @('claude', 'codex', 'desktop')
$script:KnownPolicies = @('lark-gateway-task-v1')
$script:KnownContextProfiles = @('runtime-dependencies', 'config-integrity', 'token-meter', 'lark-notify', 'lark-gateway', 'chrome-devtools-mcp', 'model-proxy')
$script:KnownResultProperties = @('schemaVersion', 'id', 'surface', 'status', 'reasonCode', 'guidanceId', 'startEligibility', 'dependencyReady', 'facts')
$script:NativeLoaded = $false

function Initialize-SHNativeTypes {
    if ($script:NativeLoaded -or ('StartupHealth.IsolatedProcess' -as [type])) { $script:NativeLoaded = $true; return }
    $sourcePath = Join-Path $PSScriptRoot 'native\StartupHealthNative.cs'
    Add-Type -Path $sourcePath
    $script:NativeLoaded = $true
}

function Get-SHRepositoryRoot {
    [CmdletBinding()]
    param()
    Split-Path -Parent $PSScriptRoot
}

function Get-SHStateRoot {
    [CmdletBinding()]
    param([string]$LocalApplicationDataPath = [Environment]::GetFolderPath('LocalApplicationData'))
    if ([string]::IsNullOrWhiteSpace($LocalApplicationDataPath)) { throw 'LocalApplicationData is unavailable.' }
    Join-Path $LocalApplicationDataPath 'ai-startup-health'
}

function Test-SHIdentifier([string]$Value) {
    -not [string]::IsNullOrWhiteSpace($Value) -and $Value -match $script:IdentifierPattern
}

function Get-SHSha256 {
    [CmdletBinding(DefaultParameterSetName = 'File')]
    param(
        [Parameter(Mandatory = $true, ParameterSetName = 'File')][string]$Path,
        [Parameter(Mandatory = $true, ParameterSetName = 'Text')][string]$Text
    )
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        if ($PSCmdlet.ParameterSetName -eq 'Text') { $bytes = [Text.Encoding]::UTF8.GetBytes($Text); $hash = $algorithm.ComputeHash($bytes) }
        else { $stream = [IO.File]::OpenRead($Path); try { $hash = $algorithm.ComputeHash($stream) } finally { $stream.Dispose() } }
        ([BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()
    } finally { $algorithm.Dispose() }
}

function Install-SHNativeAssembly {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Destination)
    $directory = Split-Path -Parent $Destination
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) { [IO.Directory]::CreateDirectory($directory) | Out-Null }
    $temporary = Join-Path $directory ('.native-' + [Guid]::NewGuid().ToString('N') + '.dll')
    try {
        Add-Type -Path (Join-Path $PSScriptRoot 'native\StartupHealthNative.cs') -OutputAssembly $temporary
        if (Test-Path -LiteralPath $Destination -PathType Leaf) {
            $backup = $temporary + '.bak'
            try { [IO.File]::Replace($temporary, $Destination, $backup, $true) }
            finally { if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force } }
        } else { [IO.File]::Move($temporary, $Destination) }
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
    Get-SHSha256 -Path $Destination
}

function Get-SHFileIdentity {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path, [string]$NativeAssemblyPath)
    if (-not ('StartupHealth.RuntimeIdentity' -as [type])) {
        if ([string]::IsNullOrWhiteSpace($NativeAssemblyPath)) { Initialize-SHNativeTypes }
        else { $null = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($NativeAssemblyPath)) }
    }
    [StartupHealth.RuntimeIdentity]::GetFileIdentity($Path)
}

function Test-SHFileIdentity {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Expected, [Parameter(Mandatory = $true)]$Actual)
    [string]$Expected.CanonicalPath -ieq [string]$Actual.CanonicalPath -and
        [long]$Expected.Length -eq [long]$Actual.Length -and
        [long]$Expected.LastWriteUtcTicks -eq [long]$Actual.LastWriteUtcTicks -and
        [uint32]$Expected.VolumeSerialNumber -eq [uint32]$Actual.VolumeSerialNumber -and
        [uint64]$Expected.FileIndex -eq [uint64]$Actual.FileIndex -and
        [string]$Expected.FileVersion -eq [string]$Actual.FileVersion
}

function Test-SHDirectoryAccess {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$NativeAssemblyPath)
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $false }
    if (-not ('StartupHealth.RuntimeIdentity' -as [type])) { $null = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($NativeAssemblyPath)) }
    [StartupHealth.RuntimeIdentity]::CanCreateWriteDeleteChild($Path)
}

function Get-SHProcessIdentity {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][int]$ProcessId, [Parameter(Mandatory = $true)][string]$NativeAssemblyPath)
    if (-not ('StartupHealth.RuntimeIdentity' -as [type])) { $null = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($NativeAssemblyPath)) }
    [StartupHealth.RuntimeIdentity]::GetProcess($ProcessId)
}

function ConvertFrom-SHFileTime {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Value)
    if ($Value -notmatch '^\d{10,20}$') { throw 'Process FILETIME is invalid.' }
    [DateTimeOffset]([DateTime]::FromFileTimeUtc([int64]$Value))
}

function Resolve-SHAccountSid {
    [CmdletBinding()]
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    $trimmed = $Value.Trim()
    if ($trimmed -match '^S-\d-\d+(?:-\d+)+$') {
        try { return ([Security.Principal.SecurityIdentifier]::new($trimmed)).Value } catch { return $null }
    }
    try { return ([Security.Principal.NTAccount]::new($trimmed)).Translate([Security.Principal.SecurityIdentifier]).Value }
    catch { return $null }
}

function Test-SHGatewayTaskDefinition {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Actual, [Parameter(Mandatory = $true)]$Expected)
    if ($null -eq $Actual -or @($Actual.actions).Count -ne 1 -or @($Actual.triggers).Count -ne 1) { return $false }
    $action = @($Actual.actions)[0]; $trigger = @($Actual.triggers)[0]
    $expectedSid = Resolve-SHAccountSid ([string]$Expected.userSid)
    $principalSid = Resolve-SHAccountSid ([string]$Actual.userSid)
    $triggerSid = Resolve-SHAccountSid ([string]$trigger.userSid)
    $logonType = [string]$Actual.logonType
    ($logonType -ieq 'Interactive' -or $logonType -ieq 'InteractiveToken') -and
        $null -ne $expectedSid -and $principalSid -eq $expectedSid -and $triggerSid -eq $expectedSid -and
        [string]$action.execute -ieq [string]$Expected.execute -and
        [string]$action.arguments -eq [string]$Expected.arguments -and
        [string]$action.workingDirectory -ieq [string]$Expected.workingDirectory -and
        [string]$Actual.runLevel -eq 'Limited' -and
        [bool]$Actual.enabled -and [int64]$Actual.executionTimeLimitSeconds -eq 0 -and
        [int]$Actual.restartCount -eq 5 -and [int]$Actual.restartIntervalSeconds -eq 60 -and
        [string]$trigger.type -eq 'AtLogOn'
}

function Get-SHAsarPackageMetadata {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path, [int]$MaximumHeaderBytes = 8388608, [int]$MaximumPackageBytes = 1048576)
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
    try {
        [byte[]]$preamble = New-Object byte[] 16
        if ($stream.Read($preamble, 0, 16) -ne 16) { throw 'ASAR preamble is truncated.' }
        $headerLength = [BitConverter]::ToUInt32($preamble, 12)
        if ($headerLength -le 0 -or $headerLength -gt $MaximumHeaderBytes) { throw 'ASAR header size is invalid.' }
        $paddedHeaderLength = [int](($headerLength + 3) -band -bnot 3)
        [byte[]]$headerBytes = New-Object byte[] $headerLength
        if ($stream.Read($headerBytes, 0, [int]$headerLength) -ne [int]$headerLength) { throw 'ASAR header is truncated.' }
        $headerText = [Text.Encoding]::UTF8.GetString($headerBytes).TrimEnd([char]0)
        $header = $headerText | ConvertFrom-Json
        $packageEntry = $header.files.PSObject.Properties['package.json'].Value
        if ($null -eq $packageEntry) { throw 'ASAR package.json entry is missing.' }
        $packageSize = [int64]$packageEntry.size
        $packageOffset = [int64]$packageEntry.offset
        if ($packageSize -le 0 -or $packageSize -gt $MaximumPackageBytes -or $packageOffset -lt 0) { throw 'ASAR package.json entry is invalid.' }
        $dataOffset = 16L + [int64]$paddedHeaderLength
        $stream.Position = $dataOffset + $packageOffset
        [byte[]]$packageBytes = New-Object byte[] ([int]$packageSize)
        if ($stream.Read($packageBytes, 0, [int]$packageSize) -ne [int]$packageSize) { throw 'ASAR package.json content is truncated.' }
        $package = ([Text.Encoding]::UTF8.GetString($packageBytes).TrimStart([char]0)) | ConvertFrom-Json
        if ([string]::IsNullOrWhiteSpace([string]$package.version)) { throw 'ASAR package version is missing.' }
        [pscustomobject]@{ DataOffset = $dataOffset; PackageOffset = $packageOffset; PackageSize = $packageSize; InternalBuild = [string]$package.version }
    } finally { $stream.Dispose() }
}

function Read-SHAsarPackageVersionAt {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][int64]$DataOffset,
        [Parameter(Mandatory = $true)][int64]$PackageOffset,
        [Parameter(Mandatory = $true)][int64]$PackageSize
    )
    if ($DataOffset -lt 16 -or $PackageOffset -lt 0 -or $PackageSize -le 0 -or $PackageSize -gt 1048576) { throw 'Recorded ASAR package location is invalid.' }
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
    try {
        if ($DataOffset + $PackageOffset + $PackageSize -gt $stream.Length) { throw 'Recorded ASAR package location exceeds the file.' }
        $stream.Position = $DataOffset + $PackageOffset
        [byte[]]$bytes = New-Object byte[] ([int]$PackageSize)
        if ($stream.Read($bytes, 0, [int]$PackageSize) -ne [int]$PackageSize) { throw 'ASAR package content is truncated.' }
        $package = ([Text.Encoding]::UTF8.GetString($bytes).TrimStart([char]0)) | ConvertFrom-Json
        [string]$package.version
    } finally { $stream.Dispose() }
}

function Get-SHHookProjection {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$ConfigPath, [string]$Owner = 'AIStartupHealthV1')
    $item = Get-Item -LiteralPath $ConfigPath -ErrorAction Stop
    if ($item.Length -gt 1048576) { throw 'Hook configuration exceeds 1 MiB.' }
    Initialize-SHNativeTypes
    $text = [IO.File]::ReadAllText($ConfigPath)
    $document = [StartupHealth.Jsonc]::NormalizeAndRejectDuplicateProperties($text) | ConvertFrom-Json
    $sessionStart = @($document.hooks.SessionStart)
    $owned = @()
    foreach ($entry in $sessionStart) {
        foreach ($hook in @($entry.hooks)) {
            if ([string]$hook.command -match ('(?:^|\s)-Owner\s+' + [regex]::Escape($Owner) + '(?:\s|$)')) {
                $owned += [pscustomobject]@{ Entry = $entry; Hook = $hook }
            }
        }
    }
    if ($owned.Count -ne 1) { throw "Expected exactly one owned SessionStart hook; found $($owned.Count)." }
    $projection = [ordered]@{
        event = 'SessionStart'
        matcher = [string]$owned[0].Entry.matcher
        type = [string]$owned[0].Hook.type
        command = [string]$owned[0].Hook.command
        timeout = [int]$owned[0].Hook.timeout
        async = [bool]$owned[0].Hook.async
    }
    $json = $projection | ConvertTo-Json -Compress
    [pscustomobject]@{ Projection = [pscustomobject]$projection; Json = $json; Sha256 = Get-SHSha256 -Text $json }
}

function Test-SHEntryGuardEvidence {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][string[]]$AncestorPaths,
        [string]$OriginatorOverride,
        [int]$MaximumMilliseconds = 500
    )
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    try {
        if ([int]$Manifest.schemaVersion -ne 1 -or -not [bool]$Manifest.installed) { return [pscustomobject]@{ Approved = $false; Reason = 'manifest-invalid'; Surface = $null } }
        $nativePath = [string]$Manifest.nativeAssembly.path
        if (-not (Test-Path -LiteralPath $nativePath -PathType Leaf) -or (Get-SHSha256 -Path $nativePath) -ne [string]$Manifest.nativeAssembly.sha256) {
            return [pscustomobject]@{ Approved = $false; Reason = 'native-helper-drift'; Surface = $null }
        }
        if (-not ('StartupHealth.RuntimeIdentity' -as [type])) { $null = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($nativePath)) }
        $match = $null
        foreach ($ancestor in $AncestorPaths) {
            foreach ($runtime in @($Manifest.runtimes)) {
                if ([string]$runtime.file.CanonicalPath -ieq [IO.Path]::GetFullPath($ancestor)) { $match = $runtime; break }
            }
            if ($null -ne $match) { break }
        }
        if ($null -eq $match) { return [pscustomobject]@{ Approved = $false; Reason = 'runtime-unapproved'; Surface = $null } }
        $actual = Get-SHFileIdentity -Path ([string]$match.file.CanonicalPath) -NativeAssemblyPath $nativePath
        if (-not (Test-SHFileIdentity $match.file $actual)) { return [pscustomobject]@{ Approved = $false; Reason = 'runtime-drift'; Surface = $null } }
        $surface = [string]$match.surface
        if ($surface -eq 'desktop') {
            if ($OriginatorOverride -ne 'Codex Desktop') { return [pscustomobject]@{ Approved = $false; Reason = 'desktop-origin-mismatch'; Surface = $null } }
            $asarActual = Get-SHFileIdentity -Path ([string]$match.appAsar.file.CanonicalPath) -NativeAssemblyPath $nativePath
            if (-not (Test-SHFileIdentity $match.appAsar.file $asarActual)) { return [pscustomobject]@{ Approved = $false; Reason = 'desktop-app-drift'; Surface = $null } }
            $build = Read-SHAsarPackageVersionAt -Path ([string]$match.appAsar.file.CanonicalPath) -DataOffset ([int64]$match.appAsar.dataOffset) -PackageOffset ([int64]$match.appAsar.packageOffset) -PackageSize ([int64]$match.appAsar.packageSize)
            if ($build -ne [string]$match.appAsar.internalBuild) { return [pscustomobject]@{ Approved = $false; Reason = 'desktop-build-drift'; Surface = $null } }
        }
        $hookKey = if ($surface -eq 'claude') { 'claude' } else { 'codex' }
        $hookDefinition = $Manifest.hooks.PSObject.Properties[$hookKey].Value
        $projection = Get-SHHookProjection -ConfigPath ([string]$hookDefinition.configPath)
        if ($projection.Sha256 -ne [string]$hookDefinition.projectionSha256 -or
            $projection.Projection.matcher -ne '^(startup|resume)$' -or $projection.Projection.type -ne 'command' -or
            -not $projection.Projection.async -or $projection.Projection.timeout -ne 75) {
            return [pscustomobject]@{ Approved = $false; Reason = 'hook-drift'; Surface = $surface }
        }
        if ($stopwatch.ElapsedMilliseconds -gt $MaximumMilliseconds) { return [pscustomobject]@{ Approved = $false; Reason = 'guard-timeout'; Surface = $surface } }
        [pscustomobject]@{ Approved = $true; Reason = 'approved'; Surface = $surface; DurationMilliseconds = $stopwatch.ElapsedMilliseconds }
    } catch { [pscustomobject]@{ Approved = $false; Reason = 'guard-error'; Surface = $null } }
}

function Assert-SHNoReparsePoint([string]$Path, [string]$Boundary) {
    $current = [IO.Path]::GetFullPath($Path)
    $limit = [IO.Path]::GetFullPath($Boundary).TrimEnd('\')
    while ($current.StartsWith($limit, [StringComparison]::OrdinalIgnoreCase)) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Path crosses a reparse point: $current"
            }
        }
        if ($current.Equals($limit, [StringComparison]::OrdinalIgnoreCase)) { break }
        $parent = Split-Path -Parent $current
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $current) { break }
        $current = $parent
    }
}

function Resolve-SHProviderPath([string]$Root, [string]$RelativePath) {
    if ([string]::IsNullOrWhiteSpace($RelativePath) -or [IO.Path]::IsPathRooted($RelativePath) -or $RelativePath.Contains(':')) {
        throw "Provider path must be relative: $RelativePath"
    }
    $checksRoot = [IO.Path]::GetFullPath((Join-Path $Root 'checks')).TrimEnd('\')
    $candidate = [IO.Path]::GetFullPath((Join-Path $Root $RelativePath))
    if (-not $candidate.StartsWith($checksRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Provider path escapes checks directory: $RelativePath"
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "Provider file is missing: $RelativePath" }
    Assert-SHNoReparsePoint $candidate $checksRoot
    $candidate
}

function Assert-SHStringCatalog($Catalog, [string]$Label) {
    if ($null -eq $Catalog) { throw "$Label catalog is missing." }
    foreach ($property in @($Catalog.PSObject.Properties)) {
        if (-not (Test-SHIdentifier $property.Name)) { throw "$Label contains an invalid identifier: $($property.Name)" }
        if ($Label -eq 'reasons') {
            if ($property.Value -isnot [string] -or [string]::IsNullOrWhiteSpace($property.Value) -or [Text.Encoding]::UTF8.GetByteCount($property.Value) -gt 512) {
                throw "$Label entry is invalid: $($property.Name)"
            }
        } else {
            $guidance = $property.Value
            if ($null -eq $guidance -or $guidance.text -isnot [string] -or [string]::IsNullOrWhiteSpace($guidance.text)) {
                throw "guidance entry is invalid: $($property.Name)"
            }
            if ([Text.Encoding]::UTF8.GetByteCount([string]$guidance.text) -gt 512) { throw "guidance text is too long: $($property.Name)" }
            if ($null -ne $guidance.PSObject.Properties['documentation']) {
                $documentation = [string]$guidance.documentation
                if ([IO.Path]::IsPathRooted($documentation) -or $documentation.Contains(':') -or $documentation -match '(^|[\\/])\.\.([\\/]|$)') {
                    throw "guidance documentation path is invalid: $($property.Name)"
                }
            }
        }
    }
}

function Read-SHRegistry {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)
    $root = Split-Path -Parent ([IO.Path]::GetFullPath($Path))
    $document = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    if ([int]$document.schemaVersion -ne 1) { throw 'Unsupported registry schema version.' }
    $checks = @($document.checks)
    if ($checks.Count -eq 0) { throw 'Registry contains no checks.' }
    $byId = @{}
    foreach ($check in $checks) {
        $id = [string]$check.id
        if (-not (Test-SHIdentifier $id)) { throw "Invalid check id: $id" }
        if ($byId.ContainsKey($id)) { throw "Duplicate check id: $id" }
        $byId[$id] = $check
        if ([string]$check.scope -notin @('global', 'surface')) { throw "Invalid scope for $id" }
        $clients = @($check.clients)
        if ($clients.Count -eq 0 -or @($clients | Where-Object { $_ -notin $script:KnownSurfaces }).Count) { throw "Invalid clients for $id" }
        if ([string]$check.scope -eq 'surface' -and $clients.Count -eq 0) { throw "Surface check has no clients: $id" }
        if ([int]$check.checkTimeoutMs -lt 500 -or [int]$check.checkTimeoutMs -gt 15000) { throw "Invalid timeout for $id" }
        if ([int]$check.freshnessSeconds -lt 5 -or [int]$check.freshnessSeconds -gt 1800) { throw "Invalid freshness for $id" }
        if ([int]$check.cooldownSeconds -lt 0 -or [int]$check.cooldownSeconds -gt 86400) { throw "Invalid cooldown for $id" }
        if ($null -ne $check.autoStartPolicy -and [string]$check.autoStartPolicy -notin $script:KnownPolicies) { throw "Unknown auto-start policy for $id" }
        if ($null -ne $check.autoStartPolicy -and [string]$check.scope -ne 'global') { throw "Auto-start policy requires global scope: $id" }
        if ($null -ne $check.PSObject.Properties['contextProfile'] -and [string]$check.contextProfile -notin $script:KnownContextProfiles) {
            throw "Unknown context profile for $id"
        }
        $scriptPath = Resolve-SHProviderPath $root ([string]$check.script)
        $check | Add-Member -NotePropertyName scriptPath -NotePropertyValue $scriptPath -Force
        Assert-SHStringCatalog $check.reasons 'reasons'
        Assert-SHStringCatalog $check.guidance 'guidance'
    }
    foreach ($check in $checks) {
        foreach ($dependency in @($check.dependsOn)) {
            $dependencyId = [string]$dependency
            if (-not $byId.ContainsKey($dependencyId)) { throw "Unknown dependency $dependencyId for $($check.id)" }
            if ([string]$check.scope -eq 'global' -and [string]$byId[$dependencyId].scope -eq 'surface') {
                throw "Global check cannot depend on surface check: $($check.id)"
            }
        }
    }
    $visiting = @{}; $visited = @{}
    function Visit-SHCheck([string]$Id) {
        if ($visiting[$Id]) { throw "Dependency cycle contains $Id" }
        if ($visited[$Id]) { return }
        $visiting[$Id] = $true
        foreach ($dependency in @($byId[$Id].dependsOn)) { Visit-SHCheck ([string]$dependency) }
        $visiting.Remove($Id)
        $visited[$Id] = $true
    }
    foreach ($id in $byId.Keys) { Visit-SHCheck $id }
    [pscustomobject]@{ SchemaVersion = 1; Root = $root; Checks = $checks; ById = $byId }
}

function ConvertFrom-SHProviderResult {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Json,
        [Parameter(Mandatory = $true)]$Check,
        [Parameter(Mandatory = $true)][string]$ExpectedSurface
    )
    if ([Text.Encoding]::UTF8.GetByteCount($Json) -gt 65536) { throw 'Provider output exceeds 64 KiB.' }
    $result = $Json | ConvertFrom-Json
    $unknown = @($result.PSObject.Properties.Name | Where-Object { $_ -notin $script:KnownResultProperties })
    if ($unknown.Count) { throw "Provider result contains unknown fields: $($unknown -join ', ')" }
    if ([int]$result.schemaVersion -ne 1 -or [string]$result.id -ne [string]$Check.id -or [string]$result.surface -ne $ExpectedSurface) {
        throw 'Provider result identity mismatch.'
    }
    if ([string]$result.status -notin @('ok', 'warn', 'error')) { throw 'Provider result status is invalid.' }
    if ([string]$result.startEligibility -notin @('not-needed', 'eligible', 'unsupported')) { throw 'Provider start eligibility is invalid.' }
    if ($result.dependencyReady -isnot [bool]) { throw 'Provider dependencyReady must be boolean.' }
    $reasonCode = [string]$result.reasonCode
    if (-not (Test-SHIdentifier $reasonCode) -or $null -eq $Check.reasons.PSObject.Properties[$reasonCode]) { throw 'Provider reason code is not catalogued.' }
    if ($null -ne $result.guidanceId) {
        $guidanceId = [string]$result.guidanceId
        if (-not (Test-SHIdentifier $guidanceId) -or $null -eq $Check.guidance.PSObject.Properties[$guidanceId]) { throw 'Provider guidance id is not catalogued.' }
    }
    $facts = if ($null -eq $result.facts) { [pscustomobject]@{} } else { $result.facts }
    $properties = @($facts.PSObject.Properties)
    if ($properties.Count -gt 16) { throw 'Provider facts contain too many keys.' }
    foreach ($property in $properties) {
        if (-not (Test-SHIdentifier $property.Name)) { throw "Provider fact key is invalid: $($property.Name)" }
        if ($property.Value -is [Collections.IEnumerable] -and $property.Value -isnot [string]) { throw "Provider fact is not scalar: $($property.Name)" }
        if ($property.Value -is [string] -and [Text.Encoding]::UTF8.GetByteCount([string]$property.Value) -gt 256) { throw "Provider fact is too long: $($property.Name)" }
    }
    if ([Text.Encoding]::UTF8.GetByteCount(($facts | ConvertTo-Json -Compress -Depth 4)) -gt 4096) { throw 'Provider facts exceed 4 KiB.' }
    $result
}

function Write-SHAtomicJson {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)]$Value)
    $directory = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) { [IO.Directory]::CreateDirectory($directory) | Out-Null }
    $temporary = Join-Path $directory ('.' + [IO.Path]::GetFileName($Path) + '.' + [Guid]::NewGuid().ToString('N') + '.tmp')
    $backup = $temporary + '.bak'
    try {
        $json = ($Value | ConvertTo-Json -Depth 30) + [Environment]::NewLine
        [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
        if (Test-Path -LiteralPath $Path -PathType Leaf) { [IO.File]::Replace($temporary, $Path, $backup, $true) }
        else { [IO.File]::Move($temporary, $Path) }
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
        if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
    }
}

function Move-SHCorruptState {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path, [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $stamp = $Now.UtcDateTime.ToString('yyyyMMddTHHmmssfffZ')
    $destination = "$Path.corrupt-$stamp"
    Move-Item -LiteralPath $Path -Destination $destination
    $destination
}

function Read-SHStateJson {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [int64]$MaximumBytes = 1048576,
        [switch]$QuarantineCorrupt
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try {
        $item = Get-Item -LiteralPath $Path
        if ($item.Length -gt $MaximumBytes) { throw 'State file exceeds its size cap.' }
        Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    } catch {
        if ($QuarantineCorrupt) { try { $null = Move-SHCorruptState $Path } catch { } }
        $null
    }
}

function Get-SHGatewayTaskDefinition {
    [CmdletBinding()]
    param([string]$TaskName = 'LarkClaudeGateway')
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $task) { return $null }
    function Convert-SHTaskDuration([object]$Value) {
        if ([string]::IsNullOrWhiteSpace([string]$Value)) { return 0L }
        try { [int64]([Xml.XmlConvert]::ToTimeSpan([string]$Value).TotalSeconds) } catch { -1L }
    }
    [pscustomobject]@{
        taskName = [string]$task.TaskName
        taskPath = [string]$task.TaskPath
        state = [string]$task.State
        actions = @($task.Actions | ForEach-Object { [pscustomobject]@{ execute = [string]$_.Execute; arguments = [string]$_.Arguments; workingDirectory = [string]$_.WorkingDirectory } })
        triggers = @($task.Triggers | ForEach-Object { [pscustomobject]@{ type = if ($_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger') { 'AtLogOn' } else { [string]$_.CimClass.CimClassName }; userSid = [string]$_.UserId } })
        userSid = [string]$task.Principal.UserId
        logonType = [string]$task.Principal.LogonType
        runLevel = [string]$task.Principal.RunLevel
        enabled = [bool]$task.Settings.Enabled
        executionTimeLimitSeconds = Convert-SHTaskDuration $task.Settings.ExecutionTimeLimit
        restartCount = [int]$task.Settings.RestartCount
        restartIntervalSeconds = Convert-SHTaskDuration $task.Settings.RestartInterval
    }
}

function Write-SHLog {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Message, [int]$MaximumBytes = 2097152, [int]$Rotations = 3)
    try {
        $directory = Split-Path -Parent $Path
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) { [IO.Directory]::CreateDirectory($directory) | Out-Null }
        $line = ([DateTimeOffset]::UtcNow.ToString('o') + ' ' + ($Message -replace '[\r\n]+', ' ') + [Environment]::NewLine)
        $lineBytes = [Text.Encoding]::UTF8.GetByteCount($line)
        if ((Test-Path -LiteralPath $Path -PathType Leaf) -and ((Get-Item -LiteralPath $Path).Length + $lineBytes -gt $MaximumBytes)) {
            for ($index = $Rotations; $index -ge 1; $index--) {
                $source = if ($index -eq 1) { $Path } else { "$Path.$($index - 1)" }
                $target = "$Path.$index"
                if (Test-Path -LiteralPath $source -PathType Leaf) { Move-Item -LiteralPath $source -Destination $target -Force }
            }
        }
        [IO.File]::AppendAllText($Path, $line, [Text.UTF8Encoding]::new($false))
    } catch { }
}

function Get-SHUserSid {
    [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}

function Get-SHMutexName([string]$Sid = (Get-SHUserSid)) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { $hash = $algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($Sid)) }
    finally { $algorithm.Dispose() }
    'Global\AIStartupHealth-' + ([BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()
}

function Enter-SHMutex {
    [CmdletBinding()]
    param([int]$WaitMilliseconds = 0, [string]$NameOverride)
    if ($WaitMilliseconds -lt 0 -or $WaitMilliseconds -gt 65000) { throw 'Mutex wait must be between 0 and 65000 milliseconds.' }
    $name = if ([string]::IsNullOrWhiteSpace($NameOverride)) { Get-SHMutexName } else { $NameOverride }
    $rights = [Security.AccessControl.MutexRights]::Synchronize -bor [Security.AccessControl.MutexRights]::Modify
    $mutex = $null; $created = $false
    try {
        try { $mutex = [Threading.Mutex]::OpenExisting($name, $rights) }
        catch [Threading.WaitHandleCannotBeOpenedException] {
            $security = [Security.AccessControl.MutexSecurity]::new()
            foreach ($sidValue in @((Get-SHUserSid), 'S-1-5-18')) {
                $sid = [Security.Principal.SecurityIdentifier]::new($sidValue)
                $rule = [Security.AccessControl.MutexAccessRule]::new($sid, $rights, [Security.AccessControl.AccessControlType]::Allow)
                $security.AddAccessRule($rule)
            }
            $mutex = [Threading.Mutex]::new($false, $name, [ref]$created, $security)
            if (-not $created) {
                $mutex.Dispose(); $mutex = [Threading.Mutex]::OpenExisting($name, $rights)
            }
        }
        $acquired = $false; $abandoned = $false
        try { $acquired = $mutex.WaitOne($WaitMilliseconds) }
        catch [Threading.AbandonedMutexException] { $acquired = $true; $abandoned = $true }
        [pscustomobject]@{ Name = $name; Mutex = $mutex; Acquired = $acquired; Abandoned = $abandoned; Rights = $rights }
    } catch {
        if ($null -ne $mutex) { $mutex.Dispose() }
        throw
    }
}

function Exit-SHMutex {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Lease)
    try { if ($Lease.Acquired) { $Lease.Mutex.ReleaseMutex() } }
    finally { $Lease.Mutex.Dispose() }
}

function New-SHDeadline {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][int]$DurationMilliseconds)
    if ($DurationMilliseconds -le 0) { throw 'Deadline duration must be positive.' }
    $frequency = [Diagnostics.Stopwatch]::Frequency
    [pscustomobject]@{
        Started = [Diagnostics.Stopwatch]::GetTimestamp()
        Deadline = [Diagnostics.Stopwatch]::GetTimestamp() + [long]([double]$DurationMilliseconds * $frequency / 1000.0)
        Frequency = $frequency
        DurationMilliseconds = $DurationMilliseconds
    }
}

function Get-SHRemainingMilliseconds {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Deadline)
    $remaining = ([double]([long]$Deadline.Deadline - [Diagnostics.Stopwatch]::GetTimestamp()) * 1000.0) / [double]$Deadline.Frequency
    [Math]::Max(0, [Math]::Floor($remaining))
}

function Invoke-SHIsolatedProcess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [string[]]$Arguments = @(),
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][int]$TimeoutMilliseconds,
        [int]$MaximumBytes = 65536
    )
    Initialize-SHNativeTypes
    [StartupHealth.IsolatedProcess]::Run($Executable, $Arguments, $WorkingDirectory, $TimeoutMilliseconds, $MaximumBytes)
}

function Invoke-SHProcessBatch {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object[]]$Requests,
        [Parameter(Mandatory = $true)][ValidateRange(1, 32)][int]$MaximumConcurrency,
        [Parameter(Mandatory = $true)][int]$AggregateMilliseconds
    )
    Initialize-SHNativeTypes
    $nativeRequests = New-Object 'StartupHealth.ProcessRequest[]' $Requests.Count
    for ($index = 0; $index -lt $Requests.Count; $index++) {
        $request = $Requests[$index]
        $native = [StartupHealth.ProcessRequest]::new()
        $native.Key = [string]$request.Key
        $native.Executable = [string]$request.Executable
        $native.Arguments = [string[]]@($request.Arguments)
        $native.WorkingDirectory = [string]$request.WorkingDirectory
        $native.TimeoutMilliseconds = [int]$request.TimeoutMilliseconds
        $native.MaximumBytes = if ($null -eq $request.PSObject.Properties['MaximumBytes']) { 65536 } else { [int]$request.MaximumBytes }
        $nativeRequests[$index] = $native
    }
    @([StartupHealth.IsolatedProcess]::RunBatch($nativeRequests, $MaximumConcurrency, $AggregateMilliseconds))
}

function Get-SHProbeKey {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Probe)
    $argumentJson = @($Probe.Arguments) | ConvertTo-Json -Compress
    $text = '{0}|{1}|{2}|{3}' -f [string]$Probe.Profile, [string]$Probe.ExecutableIdentity, $argumentJson, [string]$Probe.Surface
    Get-SHSha256 -Text $text
}

function Invoke-SHDiagnosticProbes {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Manifest, [int]$AggregateMilliseconds = 7000, [string[]]$Profiles = @())
    $facts = @{}
    $requests = [Collections.Generic.List[object]]::new()
    $seen = @{}
    foreach ($probe in @($Manifest.diagnosticProbes)) {
        if ($Profiles.Count -gt 0 -and [string]$probe.profile -notin $Profiles) { continue }
        $id = [string]$probe.id
        try {
            if (-not (Test-SHIdentifier $id) -or [string]$probe.profile -notin @('version-output', 'codex-config-load')) { throw 'probe-profile-invalid' }
            $profile = [string]$probe.profile
            $path = [string]$probe.file.CanonicalPath
            $actual = Get-SHFileIdentity $path ([string]$Manifest.nativeAssembly.path)
            if (-not (Test-SHFileIdentity $probe.file $actual) -or (Get-SHSha256 -Path $path) -ne [string]$probe.sha256) { throw 'probe-executable-drift' }
            $arguments = @($probe.arguments | ForEach-Object { [string]$_ })
            if ($arguments.Count -gt 8 -or @($arguments | Where-Object { $_.Length -gt 256 }).Count -gt 0) { throw 'probe-arguments-invalid' }
            $key = Get-SHProbeKey ([pscustomobject]@{ Profile = $profile; ExecutableIdentity = [string]$probe.sha256; Arguments = $arguments; Surface = [string]$probe.surface })
            if ($seen.ContainsKey($key)) { $facts[$id] = $facts[$seen[$key]]; continue }
            $seen[$key] = $id
            $profileLimit = if ($profile -eq 'codex-config-load') { 6500 } else { 3500 }
            $requests.Add([pscustomobject]@{ Key = $id; Executable = $path; Arguments = $arguments; WorkingDirectory = [string]$Manifest.frameworkRoot; TimeoutMilliseconds = [Math]::Min($profileLimit, [int]$probe.timeoutMilliseconds); MaximumBytes = 4096 })
            $facts[$id] = [pscustomobject]@{ ready = $false; available = $false; profile = $profile; path = $path; version = $null }
        } catch { $facts[$id] = [pscustomobject]@{ ready = $false; available = $false; profile = [string]$probe.profile; path = [string]$probe.file.CanonicalPath; version = $null } }
    }
    if ($requests.Count -gt 0) {
        foreach ($item in @(Invoke-SHProcessBatch @($requests) 8 $AggregateMilliseconds)) {
            $id = [string]$item.Key
            if ($item.AggregateTimedOut -or $null -eq $item.Result -or $item.Result.TimedOut) { continue }
            $profile = [string]$facts[$id].profile
            if ($profile -eq 'version-output') {
                if ($item.Result.ExitCode -eq 0) {
                    $version = ([string]$item.Result.Stdout).Trim()
                    if ([Text.Encoding]::UTF8.GetByteCount($version) -le 512 -and -not [string]::IsNullOrWhiteSpace($version)) {
                        $facts[$id] = [pscustomobject]@{ ready = $true; available = $true; profile = $profile; path = [string]$facts[$id].path; version = $version }
                    }
                }
            } elseif ($profile -eq 'codex-config-load') {
                try {
                    $report = ([string]$item.Result.Stdout).Trim() | ConvertFrom-Json
                    $configLoad = if ($null -ne $report.PSObject.Properties['checks'] -and $null -ne $report.checks.PSObject.Properties['config.load']) { [string]$report.checks.'config.load'.status } else { '' }
                    $facts[$id] = [pscustomobject]@{ ready = ($configLoad -eq 'ok'); available = ($configLoad -eq 'ok' -or $configLoad -eq 'fail'); profile = $profile; path = [string]$facts[$id].path; version = $null }
                } catch { }
            }
        }
    }
    $facts
}

function Test-SHDeterministicSchedule {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object[]]$Items,
        [Parameter(Mandatory = $true)][int]$MaximumConcurrency,
        [Parameter(Mandatory = $true)][int]$BudgetMilliseconds
    )
    if ($MaximumConcurrency -le 0 -or $BudgetMilliseconds -le 0) { return $false }
    $remaining = @{}; $completed = @{}; $clock = 0
    foreach ($item in $Items) {
        $id = [string]$item.Id
        if ([string]::IsNullOrWhiteSpace($id) -or $remaining.ContainsKey($id)) { return $false }
        $remaining[$id] = $item
    }
    while ($remaining.Count) {
        $ready = @($remaining.Values | Where-Object {
            $dependencies = @($_.DependsOn)
            @($dependencies | Where-Object { -not $completed.ContainsKey([string]$_) }).Count -eq 0
        } | Sort-Object @{ Expression = { [string]$_.Id } })
        if ($ready.Count -eq 0) { return $false }
        for ($offset = 0; $offset -lt $ready.Count; $offset += $MaximumConcurrency) {
            $wave = @($ready[$offset..([Math]::Min($ready.Count - 1, $offset + $MaximumConcurrency - 1))])
            $clock += [int](($wave | Measure-Object -Property TimeoutMilliseconds -Maximum).Maximum)
            if ($clock -gt $BudgetMilliseconds) { return $false }
            foreach ($item in $wave) { $remaining.Remove([string]$item.Id); $completed[[string]$item.Id] = $true }
        }
    }
    $true
}

function Merge-SHSnapshotCells {
    [CmdletBinding()]
    param(
        [object[]]$ExistingCells = @(),
        [object[]]$NewCells = @(),
        [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow
    )
    $cells = [ordered]@{}
    foreach ($cell in @($ExistingCells)) {
        try {
            $key = [string]$cell.key
            $checked = [DateTimeOffset]::Parse([string]$cell.checkedAt)
            $expires = [DateTimeOffset]::Parse([string]$cell.expiresAt)
            if ($checked -le $Now.AddSeconds(15) -and $expires -gt $Now -and $expires -le $checked.AddSeconds(1800) -and -not $cells.Contains($key)) { $cells[$key] = $cell }
        } catch { }
    }
    foreach ($cell in @($NewCells)) { $cells[[string]$cell.key] = $cell }
    @($cells.Values)
}

function Read-SHJsoncDocument {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path, [int64]$MaximumBytes = 1048576)
    $item = Get-Item -LiteralPath $Path -ErrorAction Stop
    if ($item.Length -gt $MaximumBytes) { throw 'JSONC document exceeds its size cap.' }
    Initialize-SHNativeTypes
    [StartupHealth.Jsonc]::NormalizeAndRejectDuplicateProperties([IO.File]::ReadAllText($Path)) | ConvertFrom-Json
}

function Test-SHObjectCommandMatch {
    param([object]$Entries, [string]$Pattern)
    foreach ($entry in @($Entries)) {
        foreach ($hook in @($entry.hooks)) {
            if ([string]$hook.command -match $Pattern) { return $true }
        }
    }
    $false
}

function Test-SHLoopbackPort {
    param([int]$Port, [int]$TimeoutMilliseconds = 150)
    $client = [Net.Sockets.TcpClient]::new()
    try {
        $pending = $client.BeginConnect([Net.IPAddress]::Loopback, $Port, $null, $null)
        if (-not $pending.AsyncWaitHandle.WaitOne($TimeoutMilliseconds)) { return $false }
        $client.EndConnect($pending)
        $client.Connected
    } catch { $false } finally { $client.Dispose() }
}

function Get-SHSafeLoopbackEndpoint {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    try {
        $uri = [Uri]$Value
        $builder = [UriBuilder]::new($uri.Scheme, $uri.DnsSafeHost, $uri.Port, $uri.AbsolutePath)
        $builder.UserName = ''; $builder.Password = ''; $builder.Query = ''; $builder.Fragment = ''
        $builder.Uri.AbsoluteUri
    } catch { $null }
}

function Test-SHPathEquivalent {
    param([string]$Left, [string]$Right)
    if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) { return $false }
    try {
        $a = [IO.Path]::GetFullPath($Left.Trim().Trim('"'))
        $b = [IO.Path]::GetFullPath($Right.Trim().Trim('"'))
        [string]::Equals($a, $b, [StringComparison]::OrdinalIgnoreCase)
    } catch { $false }
}

function Test-SHCommandReferences {
    param([string]$Command, [string[]]$Names)
    if ([string]::IsNullOrWhiteSpace($Command) -or @($Names).Count -eq 0) { return $false }
    foreach ($name in @($Names)) {
        if ($Command -match [regex]::Escape([string]$name)) { return $true }
    }
    $encoded = [regex]::Match($Command, '(?i)-EncodedCommand\s+([A-Za-z0-9+/=]+)')
    if (-not $encoded.Success) { return $false }
    try { $decoded = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encoded.Groups[1].Value)) }
    catch { return $false }
    foreach ($name in @($Names)) {
        if ($decoded -match [regex]::Escape([string]$name)) { return $true }
    }
    $false
}

function Test-SHObjectCommandReferences {
    param([object]$Entries, [string[]]$Names)
    foreach ($entry in @($Entries)) {
        foreach ($hook in @($entry.hooks)) {
            if (Test-SHCommandReferences ([string]$hook.command) $Names) { return $true }
        }
    }
    $false
}

function Get-SHLarkCliInfo {
    [CmdletBinding()]
    param()
    $commands = @(Get-Command lark-cli -All -ErrorAction SilentlyContinue)
    if ($commands.Count -eq 0) { return $null }
    $command = @($commands | Where-Object { [IO.Path]::GetExtension([string]$_.Source) -ieq '.exe' } | Select-Object -First 1)
    if ($command.Count -eq 0) { $command = @($commands | Where-Object { [IO.Path]::GetExtension([string]$_.Source) -ieq '.cmd' } | Select-Object -First 1) }
    if ($command.Count -eq 0) { $command = @($commands | Select-Object -First 1) }
    $path = [string]$command[0].Source
    if ([string]::IsNullOrWhiteSpace($path)) { return $null }
    $entry = $null
    if ([IO.Path]::GetExtension($path) -ine '.exe') {
        try {
            $text = Get-Content -Raw -LiteralPath $path
            $match = [regex]::Match($text, '(?i)(node_modules[\\/][^"'']+?\.js)')
            if ($match.Success) {
                $relative = $match.Groups[1].Value -replace '[/\\]+', '\'
                $entry = Join-Path (Split-Path -Parent $path) $relative
            }
        } catch { }
    } else { $entry = $path }
    [pscustomobject]@{
        Path = $path
        Entry = $entry
        EntryExists = ($null -ne $entry -and (Test-Path -LiteralPath $entry -PathType Leaf))
    }
}

function Get-SHChromeDebugPort {
    [CmdletBinding()]
    param()
    $local = [Environment]::GetFolderPath('LocalApplicationData')
    if ([string]::IsNullOrWhiteSpace($local)) { $local = $env:LOCALAPPDATA }
    if ([string]::IsNullOrWhiteSpace($local)) { return $null }
    $path = Join-Path $local 'Google\Chrome\User Data\DevToolsActivePort'
    try {
        $first = Get-Content -LiteralPath $path -TotalCount 1 -ErrorAction Stop
        if ([string]$first -match '^\d{1,5}$') { return [int]$first }
    } catch { }
    $null
}

function Get-SHProfilePaths {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Manifest)
    $profile = [Environment]::GetFolderPath('UserProfile')
    if ([string]::IsNullOrWhiteSpace($profile)) { $profile = $env:USERPROFILE }
    $claudeConfig = Join-Path $profile '.claude\settings.json'
    $codexHooks = Join-Path $profile '.codex\hooks.json'
    try {
        if ($null -ne $Manifest.hooks -and $null -ne $Manifest.hooks.PSObject.Properties['claude']) {
            $value = [string]$Manifest.hooks.claude.configPath
            if (-not [string]::IsNullOrWhiteSpace($value)) { $claudeConfig = $value }
        }
        if ($null -ne $Manifest.hooks -and $null -ne $Manifest.hooks.PSObject.Properties['codex']) {
            $value = [string]$Manifest.hooks.codex.configPath
            if (-not [string]::IsNullOrWhiteSpace($value)) { $codexHooks = $value }
        }
    } catch { }
    $claudeHome = Split-Path -Parent (Split-Path -Parent $claudeConfig)
    $codexHome = Split-Path -Parent $codexHooks
    [pscustomobject]@{
        ClaudeConfigPath = $claudeConfig
        ClaudeJsonPath = Join-Path $claudeHome '.claude.json'
        CodexHooksPath = $codexHooks
        CodexConfigPath = Join-Path $codexHome 'config.toml'
    }
}

function Get-SHOwnedHookCount {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$ConfigPath, [string]$Owner = 'AIStartupHealthV1')
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { return 0 }
    Initialize-SHNativeTypes
    $item = Get-Item -LiteralPath $ConfigPath
    if ($item.Length -gt 1048576) { throw 'Hook configuration exceeds 1 MiB.' }
    $document = [StartupHealth.Jsonc]::NormalizeAndRejectDuplicateProperties([IO.File]::ReadAllText($ConfigPath)) | ConvertFrom-Json
    if ($null -eq $document.PSObject.Properties['hooks'] -or $null -eq $document.hooks.PSObject.Properties['SessionStart']) { return 0 }
    $count = 0
    foreach ($entry in @($document.hooks.SessionStart)) {
        foreach ($hook in @($entry.hooks)) {
            if ([string]$hook.command -match ('(?:^|\s)-Owner\s+' + [regex]::Escape($Owner) + '(?:\s|$)')) { $count++ }
        }
    }
    $count
}

function Get-SHPhaseBudget {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Overall, [Parameter(Mandatory = $true)][int]$MaximumMilliseconds, [int]$ReserveMilliseconds = 0)
    if ($MaximumMilliseconds -le 0) { return 0 }
    $remaining = Get-SHRemainingMilliseconds $Overall
    $budget = [Math]::Min([double]$MaximumMilliseconds, [Math]::Max(0.0, [double]$remaining - [double]$ReserveMilliseconds))
    [Math]::Max(0, [int]$budget)
}

function Get-SHAutoStartPolicy {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Registry, [Parameter(Mandatory = $true)]$Manifest)
    $policies = @($Registry.Checks | Where-Object { $null -ne $_.autoStartPolicy })
    if ($policies.Count -ne 1) { return $null }
    $check = $policies[0]
    if ([string]$check.scope -ne 'global' -or [bool]$check.enabled -ne $true) { return $null }
    $policyId = [string]$check.autoStartPolicy
    if ($policyId -notin $script:KnownPolicies) { return $null }
    if ($null -eq $Manifest.PSObject.Properties['taskPolicy'] -or [string]$Manifest.taskPolicy.id -ne $policyId) { return $null }
    $expected = switch ($policyId) { 'lark-gateway-task-v1' { @('gateway-not-running') } default { @() } }
    [pscustomobject]@{
        Check = $check
        PolicyId = $policyId
        Key = Get-SHCellKey $check 'global'
        CooldownSeconds = [int]$check.cooldownSeconds
        ExpectedReasons = @($expected)
    }
}

function Test-SHManifestGenerationCurrent {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Manifest, [Parameter(Mandatory = $true)][string]$StateRoot)
    $current = Read-SHStateJson (Join-Path $StateRoot 'install-manifest.json')
    $null -ne $current -and [bool]$current.installed -and [string]$current.generation -eq [string]$Manifest.generation
}

function Test-SHShouldNotifyGuard {
    [CmdletBinding()]
    param([object]$Ledger, [Parameter(Mandatory = $true)][string]$Reason, [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow, [int]$SuppressionMinutes = 30)
    if ($null -eq $Ledger -or $null -eq $Ledger.PSObject.Properties['compatibility-guard']) { return $true }
    $prior = $Ledger.PSObject.Properties['compatibility-guard'].Value
    if ([string]$prior.hash -ne (Get-SHSha256 -Text $Reason)) { return $true }
    try { ([DateTimeOffset]::Parse([string]$prior.notifiedAt)).AddMinutes($SuppressionMinutes) -le $Now }
    catch { $true }
}

function Update-SHGuardNotification {
    [CmdletBinding()]
    param([object]$Ledger, [Parameter(Mandatory = $true)][string]$Reason, [Parameter(Mandatory = $true)][string]$Path, [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow)
    $entries = [ordered]@{}
    if ($null -ne $Ledger) { foreach ($property in @($Ledger.PSObject.Properties)) { $entries[$property.Name] = $property.Value } }
    $entries['compatibility-guard'] = [ordered]@{ hash = Get-SHSha256 -Text $Reason; reason = $Reason; notifiedAt = $Now.ToString('O') }
    Write-SHAtomicJson $Path $entries
}

function New-SHProviderContext {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Check,
        [Parameter(Mandatory = $true)][string]$Surface,
        [Parameter(Mandatory = $true)]$Manifest,
        [hashtable]$Results = @{},
        [hashtable]$ProbeFacts = @{}
    )
    $frameworkRoot = [string]$Manifest.frameworkRoot
    $repositoryRoot = Split-Path -Parent $frameworkRoot
    $localData = [Environment]::GetFolderPath('LocalApplicationData')
    if ([string]::IsNullOrWhiteSpace($localData)) { $localData = $env:LOCALAPPDATA }
    $paths = Get-SHProfilePaths $Manifest
    $claude = try { Read-SHJsoncDocument $paths.ClaudeConfigPath } catch { $null }
    $claudeJson = try { Read-SHJsoncDocument $paths.ClaudeJsonPath } catch { $null }
    $codexHooks = try { Read-SHJsoncDocument $paths.CodexHooksPath } catch { $null }
    $codexToml = try { Get-Content -Raw -LiteralPath $paths.CodexConfigPath } catch { '' }
    $contextSurface = if ([string]$Check.scope -eq 'global') { 'global' } else { $Surface }
    $contextProfile = if ($null -ne $Check.PSObject.Properties['contextProfile'] -and -not [string]::IsNullOrWhiteSpace([string]$Check.contextProfile)) { [string]$Check.contextProfile } else { [string]$Check.id }
    $context = [ordered]@{
        schemaVersion = 1
        surface = $contextSurface
        paths = [ordered]@{ repositoryRoot = $repositoryRoot; nativeAssemblyPath = [string]$Manifest.nativeAssembly.path }
    }
    switch ($contextProfile) {
        'runtime-dependencies' {
            $dependencies = [Collections.Generic.List[object]]::new()
            $powershellCommand = Get-Command powershell.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            $powershellPath = if ($null -eq $powershellCommand) { $null } else { [string]$powershellCommand.Source }
            $nodeProbe = @($ProbeFacts.Values | Where-Object { [string]$_.profile -eq 'version-output' -and [string]$_.path -match '(?i)node\.exe$' } | Select-Object -First 1)
            $nodePath = if ($nodeProbe.Count -eq 1) { [string]$nodeProbe[0].path } else { $null }
            if ([string]::IsNullOrWhiteSpace($nodePath)) {
                $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($null -ne $nodeCommand) { $nodePath = [string]$nodeCommand.Source }
            }
            $dependencies.Add([ordered]@{ id = 'powershell'; path = $powershellPath; required = $true; probeReady = ($null -ne $powershellPath) })
            $dependencies.Add([ordered]@{ id = 'node'; path = $nodePath; required = $true; probeReady = ($nodeProbe.Count -eq 1 -and [bool]$nodeProbe[0].ready) })
            $larkCli = Get-SHLarkCliInfo
            $larkCliReady = $null -ne $larkCli -and ([IO.Path]::GetExtension([string]$larkCli.Path) -ieq '.exe' -or [bool]$larkCli.EntryExists)
            $dependencies.Add([ordered]@{ id = 'lark-cli'; path = $(if ($null -eq $larkCli) { $null } else { [string]$larkCli.Path }); required = $true; probeReady = $larkCliReady })
            foreach ($runtime in @($Manifest.runtimes)) {
                $runtimePath = [string]$runtime.file.CanonicalPath
                $matchingProbe = @($ProbeFacts.Values | Where-Object { [string]$_.profile -eq 'version-output' -and [string]$_.path -ieq $runtimePath } | Select-Object -First 1)
                $dependencies.Add([ordered]@{ id = 'client-' + [string]$runtime.surface; path = $runtimePath; required = $true; probeReady = ($matchingProbe.Count -eq 1 -and [bool]$matchingProbe[0].ready) })
            }
            $context.runtimeDependencies = @($dependencies)
        }
        'config-integrity' {
            $key = if ($Surface -eq 'claude') { 'claude' } else { 'codex' }
            $hookDefinition = $Manifest.hooks.PSObject.Properties[$key].Value
            $hookConfigPath = [string]$hookDefinition.configPath
            $projectionValid = $false
            try {
                $projection = Get-SHHookProjection $hookConfigPath
                $projectionValid = $projection.Sha256 -eq [string]$hookDefinition.projectionSha256
            } catch { $projectionValid = $false }
            $ownedHookCount = 0
            try { $ownedHookCount = Get-SHOwnedHookCount $hookConfigPath } catch { $ownedHookCount = 0 }
            $jsonValid = $true
            foreach ($jsonPath in @($paths.ClaudeConfigPath, $paths.ClaudeJsonPath, $paths.CodexHooksPath)) {
                try {
                    if (Test-Path -LiteralPath $jsonPath -PathType Leaf) { $null = Read-SHJsoncDocument $jsonPath }
                } catch { $jsonValid = $false }
            }
            $codexProbe = @($ProbeFacts.Values | Where-Object { $null -ne $_.PSObject.Properties['profile'] -and [string]$_.profile -eq 'codex-config-load' } | Select-Object -First 1)
            $codexProbeAvailable = $codexProbe.Count -eq 1 -and ($null -eq $codexProbe[0].PSObject.Properties['available'] -or [bool]$codexProbe[0].available)
            $validatorAvailable = if ($Surface -eq 'claude') { $true } else { $codexProbeAvailable }
            $codexConfigOk = $codexProbe.Count -eq 1 -and [bool]$codexProbe[0].ready
            $valid = $projectionValid -and $jsonValid -and ($Surface -eq 'claude' -or $codexConfigOk)
            $context.configuration = [ordered]@{ validatorAvailable = $validatorAvailable; valid = $valid; ownedHookCount = $ownedHookCount }
        }
        'token-meter' {
            $computer = if ([string]::IsNullOrWhiteSpace($env:COMPUTERNAME)) { [Environment]::MachineName } else { $env:COMPUTERNAME }
            $user = if ([string]::IsNullOrWhiteSpace($env:USERNAME)) { [Environment]::UserName } else { $env:USERNAME }
            $safeComputer = ([regex]::Replace($computer, '[<>:"/\\|?*\x00-\x1f]', '_')).ToLowerInvariant()
            $safeUser = ([regex]::Replace($user, '[<>:"/\\|?*\x00-\x1f]', '_')).ToLowerInvariant()
            $profileRoot = [Environment]::GetFolderPath('UserProfile')
            if ([string]::IsNullOrWhiteSpace($profileRoot)) { $profileRoot = $env:USERPROFILE }
            $sharedData = if ([string]::IsNullOrWhiteSpace($env:TOKEN_METER_DATA_ROOT)) { Join-Path $profileRoot '.agents\.token-meter-data' } else { [IO.Path]::GetFullPath($env:TOKEN_METER_DATA_ROOT) }
            $dataRoot = Join-Path (Join-Path $sharedData $safeComputer) $safeUser
            $claudeStop = if ($null -ne $claude -and $null -ne $claude.PSObject.Properties['hooks'] -and $null -ne $claude.hooks.PSObject.Properties['Stop']) { $claude.hooks.Stop } else { @() }
            $codexStop = if ($null -ne $codexHooks -and $null -ne $codexHooks.PSObject.Properties['hooks'] -and $null -ne $codexHooks.hooks.PSObject.Properties['Stop']) { $codexHooks.hooks.Stop } else { @() }
            $hookHealthy = if ($Surface -eq 'claude') {
                Test-SHObjectCommandReferences $claudeStop @('ClaudeTurnHook.ps1', 'Invoke-ClaudeTurnHook.cmd')
            } else {
                Test-SHObjectCommandReferences $codexStop @('CodexTurnHook.ps1', 'Invoke-CodexTurnHook.cmd')
            }
            $statusCommand = if ($null -ne $claude -and $null -ne $claude.PSObject.Properties['statusLine']) { [string]$claude.statusLine.command } else { '' }
            $statusHealthy = if ($Surface -eq 'claude') {
                Test-SHCommandReferences $statusCommand @('ClaudeStatusLine.ps1', 'Invoke-ClaudeStatusLine.cmd')
            } else {
                $codexToml -match '(?m)^\s*status_line\s*=.*context-remaining'
            }
            $manifestPath = Join-Path $dataRoot 'install-manifest.json'
            $tokenManifest = Read-SHStateJson $manifestPath
            $context.tokenMeter = [ordered]@{ manifestValid = $null -ne $tokenManifest; hookHealthy = $hookHealthy; statusLineHealthy = $statusHealthy; dataRoot = $dataRoot }
        }
        'lark-notify' {
            $larkCli = Get-SHLarkCliInfo
            $claudeStop = if ($null -ne $claude -and $null -ne $claude.PSObject.Properties['hooks'] -and $null -ne $claude.hooks.PSObject.Properties['Stop']) { $claude.hooks.Stop } else { @() }
            $notifyPresent = $codexToml -match '(?m)^\s*notify\s*='
            $codexNotifyHealthy = $notifyPresent -and (Test-SHCommandReferences $codexToml @('Invoke-CodexNotifyBridge.ps1'))
            $hookHealthy = if ($Surface -eq 'claude') { Test-SHObjectCommandReferences $claudeStop @('lark-notify.ps1') } else { $codexNotifyHealthy }
            $task = Get-ScheduledTask -TaskName 'LarkNotifyBootstrap' -ErrorAction SilentlyContinue
            $taskInfo = if ($null -eq $task) { $null } else { Get-ScheduledTaskInfo -TaskName 'LarkNotifyBootstrap' -ErrorAction SilentlyContinue }
            $context.larkNotify = [ordered]@{
                larkCliPresent = $null -ne $larkCli
                hookHealthy = $hookHealthy
                bridgeHealthy = Test-Path -LiteralPath (Join-Path $repositoryRoot 'hooks\Invoke-CodexNotifyBridge.ps1') -PathType Leaf
                taskPresent = $null -ne $task
                taskEnabled = $null -ne $task -and [string]$task.State -ne 'Disabled'
                taskState = if ($null -eq $task) { 'Missing' } else { [string]$task.State }
                lastTaskResult = if ($null -eq $taskInfo) { -1 } else { [int64]$taskInfo.LastTaskResult }
            }
        }
        'lark-gateway' {
            $actual = Get-SHGatewayTaskDefinition
            $installed = if ($null -ne $Manifest.PSObject.Properties['taskPolicy']) { $Manifest.taskPolicy.definition } else { $null }
            $installedActions = if ($null -ne $installed -and $null -ne $installed.PSObject.Properties['actions']) { @($installed.actions) } else { @() }
            $installedAction = if ($installedActions.Count -gt 0) { $installedActions[0] } else { $null }
            $expected = if ($null -eq $installedAction) { $null } else {
                [pscustomobject]@{ execute = [string]$installedAction.execute; arguments = [string]$installedAction.arguments; workingDirectory = [string]$installedAction.workingDirectory; userSid = [string]$installed.userSid }
            }
            $matches = $null -ne $actual -and $null -ne $expected -and (Test-SHGatewayTaskDefinition $actual $expected)
            $gatewayRoot = if ($null -ne $installedAction -and -not [string]::IsNullOrWhiteSpace([string]$installedAction.workingDirectory)) { [string]$installedAction.workingDirectory } else { Join-Path $repositoryRoot 'claude-projects\lark' }
            $runtimeReady = $Results.ContainsKey('runtime-dependencies|global') -and [bool]$Results['runtime-dependencies|global'].dependencyReady
            $context.larkGateway = [ordered]@{
                taskPresent = $null -ne $actual
                taskEnabled = $null -ne $actual -and [bool]$actual.enabled
                taskState = if ($null -eq $actual) { 'Missing' } else { [string]$actual.state }
                taskDefinitionMatches = $matches
                dependenciesReady = $runtimeReady
                healthPath = Join-Path $gatewayRoot 'run\health.json'
                expectedNodePath = if ($null -eq $expected) { '' } else { [string]$expected.execute }
                expectedGatewayEntry = Join-Path $gatewayRoot 'src\gateway.mjs'
            }
        }
        'chrome-devtools-mcp' {
            $packageRoot = Join-Path $repositoryRoot 'tools\chrome-devtools-mcp'
            $entry = Join-Path $packageRoot 'node_modules\chrome-devtools-mcp\build\src\bin\chrome-devtools-mcp.js'
            $packageText = try { Get-Content -Raw -LiteralPath (Join-Path $packageRoot 'package.json') } catch { '' }
            $lockText = try { Get-Content -Raw -LiteralPath (Join-Path $packageRoot 'package-lock.json') } catch { '' }
            $installedPackageText = try { Get-Content -Raw -LiteralPath (Join-Path $packageRoot 'node_modules\chrome-devtools-mcp\package.json') } catch { '' }
            $declaredVersion = if ($packageText -match '"chrome-devtools-mcp"\s*:\s*"([^"]+)"') { $Matches[1] } else { '' }
            $lockedVersion = if ($lockText -match '"node_modules/chrome-devtools-mcp"\s*:\s*\{[^}]*?"version"\s*:\s*"([^"]+)"') { $Matches[1] } else { '' }
            $installedVersion = if ($installedPackageText -match '"version"\s*:\s*"([^"]+)"') { $Matches[1] } else { '' }
            $lockConsistent = -not [string]::IsNullOrWhiteSpace($declaredVersion) -and $declaredVersion -eq $lockedVersion -and $declaredVersion -eq $installedVersion
            $configured = $false; $enabled = $false; $required = $false; $commandMatches = $false; $argumentsMatch = $false; $autoConnect = $false
            if ($Surface -eq 'claude') {
                $server = $null
                if ($null -ne $claudeJson -and $null -ne $claudeJson.PSObject.Properties['mcpServers']) {
                    $servers = $claudeJson.mcpServers
                    if ($null -ne $servers -and $null -ne $servers.PSObject.Properties['chrome-devtools']) { $server = $servers.'chrome-devtools' }
                }
                if ($null -ne $server) {
                    $disabled = $null -ne $server.PSObject.Properties['disabled'] -and [bool]$server.disabled
                    $configured = $true; $enabled = -not $disabled
                    $required = $null -ne $server.PSObject.Properties['required'] -and [bool]$server.required
                    $serverCommand = if ($null -ne $server.PSObject.Properties['command']) { [string]$server.command } else { '' }
                    $commandMatches = [IO.Path]::GetFileName($serverCommand) -ieq 'node.exe'
                    $arguments = if ($null -ne $server.PSObject.Properties['args']) { @($server.args) } else { @() }
                    $argumentsMatch = @($arguments | Where-Object { Test-SHPathEquivalent ([string]$_) $entry }).Count -eq 1
                    $autoConnect = @($arguments) -contains '--autoConnect'
                }
            } else {
                $section = [regex]::Match($codexToml, '(?ms)^\[mcp_servers\.chrome-devtools\]\s*(.*?)(?=^\[|\z)').Groups[1].Value
                $configured = -not [string]::IsNullOrWhiteSpace($section)
                $enabled = $section -notmatch '(?m)^enabled\s*=\s*false'
                $required = $section -match '(?m)^required\s*=\s*true'
                $commandMatches = $section -match '(?m)^command\s*=\s*["''](?:[^"'']*[\\/])?node(?:\.exe)?["'']'
                $argumentsMatch = $section -match [regex]::Escape($entry)
                $autoConnect = $section -match '["'']--autoConnect["'']'
            }
            $chromePaths = @(
                (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
                (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
                (Join-Path $localData 'Google\Chrome\Application\chrome.exe')
            )
            $debugPort = Get-SHChromeDebugPort
            $remoteDebuggingAvailable = if ($null -ne $debugPort) { Test-SHLoopbackPort $debugPort 150 } else { Test-SHLoopbackPort 9222 150 }
            $context.chromeDevtools = [ordered]@{
                packagePath = $packageRoot; entryScript = $entry; lockConsistent = $lockConsistent
                configured = $configured; enabled = $enabled; required = $required; commandMatches = $commandMatches; argumentsMatch = $argumentsMatch; autoConnect = $autoConnect
                chromePresent = @($chromePaths | Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and (Test-Path -LiteralPath $_ -PathType Leaf) }).Count -gt 0
                remoteDebuggingAvailable = $remoteDebuggingAvailable
            }
        }
        'model-proxy' {
            $endpoint = if ($Surface -eq 'claude') {
                if ($null -ne $claude -and $null -ne $claude.PSObject.Properties['env'] -and $null -ne $claude.env.PSObject.Properties['ANTHROPIC_BASE_URL']) { [string]$claude.env.ANTHROPIC_BASE_URL } else { '' }
            } else {
                $match = [regex]::Match($codexToml, '(?m)^\s*base_url\s*=\s*["'']([^"'']+)["'']')
                if ($match.Success) { $match.Groups[1].Value } else { '' }
            }
            $context.modelProxy = [ordered]@{ endpoint = Get-SHSafeLoopbackEndpoint $endpoint }
        }
        default { throw "No provider context builder is registered for $($Check.id)." }
    }
    [pscustomobject]$context
}

function Get-SHCellKey {
    param([Parameter(Mandatory = $true)]$Check, [Parameter(Mandatory = $true)][string]$Surface)
    [string]$Check.id + '|' + $(if ([string]$Check.scope -eq 'global') { 'global' } else { $Surface })
}

function New-SHProviderFailureResult {
    param([Parameter(Mandatory = $true)]$Check, [Parameter(Mandatory = $true)][string]$Surface, [string]$Reason = 'provider-failed')
    $reasonProperties = @($Check.reasons.PSObject.Properties)
    if ($reasonProperties.Count -eq 0) { throw "Check $($Check.id) has no reason catalog." }
    $guidanceProperties = @($Check.guidance.PSObject.Properties)
    $reasonProperty = $Check.reasons.PSObject.Properties[$Reason]
    $reasonCode = if ($null -ne $reasonProperty) { $Reason } else { [string]$reasonProperties[0].Name }
    $guidanceId = if ($null -ne $reasonProperty) { $null } elseif ($guidanceProperties.Count -gt 0) { [string]$guidanceProperties[0].Name } else { $null }
    [pscustomobject]@{
        schemaVersion = 1; id = [string]$Check.id; surface = if ([string]$Check.scope -eq 'global') { 'global' } else { $Surface }
        status = 'warn'; reasonCode = $reasonCode; guidanceId = $guidanceId; startEligibility = 'unsupported'; dependencyReady = $false
        facts = [pscustomobject]@{}
    }
}

function Get-SHProviderPlan {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Registry,
        [Parameter(Mandatory = $true)][string]$Surface,
        [object[]]$ExistingCells = @(),
        [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow
    )
    $applicable = @($Registry.Checks | Where-Object { [bool]$_.enabled -and @($_.clients) -contains $Surface })
    $existing = @{}
    foreach ($cell in @($ExistingCells)) { $existing[[string]$cell.key] = $cell }
    $refresh = @{}; $results = @{}; $checksByKey = @{}
    $remaining = @($applicable)
    while ($remaining.Count -gt 0) {
        $progress = $false
        foreach ($check in @($remaining)) {
            $dependencies = @($check.dependsOn | ForEach-Object {
                $dependency = $Registry.ById[[string]$_]
                Get-SHCellKey $dependency $Surface
            })
            if (@($dependencies | Where-Object { -not $refresh.ContainsKey($_) }).Count -gt 0) { continue }
            $key = Get-SHCellKey $check $Surface
            $checksByKey[$key] = $check
            $fresh = $false
            if ($existing.ContainsKey($key)) {
                try { $fresh = [DateTimeOffset]::Parse([string]$existing[$key].expiresAt) -gt $Now.AddSeconds(15) } catch { $fresh = $false }
            }
            $refresh[$key] = -not $fresh -or @($dependencies | Where-Object { $refresh[$_] }).Count -gt 0
            if (-not $refresh[$key]) { $results[$key] = $existing[$key].result }
            $remaining = @($remaining | Where-Object { $null -ne $_ -and $_ -ne $check })
            $progress = $true
        }
        if (-not $progress) { throw 'Provider dependency schedule could not make progress.' }
    }
    [pscustomobject]@{
        Applicable = @($applicable)
        ChecksByKey = $checksByKey
        Refresh = $refresh
        FreshResults = $results
        RefreshKeys = @($checksByKey.Keys | Where-Object { $refresh[$_] } | Sort-Object)
    }
}

function Invoke-SHProviderSchedule {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Registry,
        [Parameter(Mandatory = $true)][string]$Surface,
        [Parameter(Mandatory = $true)]$Manifest,
        [object[]]$ExistingCells = @(),
        [int]$BudgetMilliseconds = 10000,
        [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow,
        [hashtable]$ProbeFacts = @{},
        [object]$Plan
    )
    if ($null -eq $Plan) { $Plan = Get-SHProviderPlan -Registry $Registry -Surface $Surface -ExistingCells $ExistingCells -Now $Now }
    $checksByKey = $Plan.ChecksByKey
    $refresh = $Plan.Refresh
    $results = @{}
    foreach ($key in @($Plan.FreshResults.Keys)) { $results[$key] = $Plan.FreshResults[$key] }
    $pending = @($Plan.RefreshKeys)
    $completed = @($checksByKey.Keys | Where-Object { -not $refresh[$_] })
    $refreshedKeys = @($Plan.RefreshKeys)
    $newCells = [Collections.Generic.List[object]]::new()
    $deadline = New-SHDeadline $BudgetMilliseconds
    $temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('startup-health-providers-' + [Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($temporaryRoot) | Out-Null
    try {
        $powerShell = (Get-Command powershell.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
        while ($pending.Count -gt 0) {
            $ready = @($pending | Where-Object {
                $check = $checksByKey[$_]
                $dependencyKeys = @($check.dependsOn | ForEach-Object { Get-SHCellKey $Registry.ById[[string]$_] $Surface })
                @($dependencyKeys | Where-Object { $completed -notcontains $_ }).Count -eq 0
            } | Sort-Object)
            if ($ready.Count -eq 0) { throw 'Provider execution schedule is cyclic.' }
            $requests = [Collections.Generic.List[object]]::new()
            foreach ($key in $ready) {
                $check = $checksByKey[$key]
                try {
                    $context = New-SHProviderContext $check $Surface $Manifest $results $ProbeFacts
                    $contextPath = Join-Path $temporaryRoot (($key -replace '[^a-zA-Z0-9-]', '_') + '.json')
                    Write-SHAtomicJson $contextPath $context
                    $requests.Add([pscustomobject]@{
                        Key = $key; Executable = [string]$powerShell
                        Arguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', [string]$check.scriptPath, '-Action', 'Check', '-ContextPath', $contextPath)
                        WorkingDirectory = $Registry.Root; TimeoutMilliseconds = [int]$check.checkTimeoutMs; MaximumBytes = 65536
                    })
                } catch {
                    $results[$key] = New-SHProviderFailureResult $check $Surface 'context-failed'
                    $completed += $key
                    $pending = @($pending | Where-Object { $_ -ne $key })
                }
            }
            if ($requests.Count -gt 0) {
                $remainingMilliseconds = [int](Get-SHRemainingMilliseconds $deadline)
                if ($remainingMilliseconds -le 0) { break }
                $batch = @(Invoke-SHProcessBatch -Requests @($requests) -MaximumConcurrency 4 -AggregateMilliseconds $remainingMilliseconds)
                foreach ($item in $batch) {
                    $key = [string]$item.Key; $check = $checksByKey[$key]
                    try {
                        if ($item.AggregateTimedOut -or $null -eq $item.Result -or $item.Result.TimedOut -or $item.Result.ExitCode -ne 0) { throw 'provider execution failed' }
                        $expectedSurface = if ([string]$check.scope -eq 'global') { 'global' } else { $Surface }
                        $results[$key] = ConvertFrom-SHProviderResult ([string]$item.Result.Stdout).Trim() $check $expectedSurface
                    } catch { $results[$key] = New-SHProviderFailureResult $check $Surface }
                    $completed += $key
                    $pending = @($pending | Where-Object { $_ -ne $key })
                }
            }
            if ((Get-SHRemainingMilliseconds $deadline) -le 0) { break }
        }
        foreach ($key in $pending) { $results[$key] = New-SHProviderFailureResult $checksByKey[$key] $Surface 'provider-timeout' }
        foreach ($key in $checksByKey.Keys) {
            if (-not $refresh[$key]) { continue }
            $check = $checksByKey[$key]
            $newCells.Add([pscustomobject]@{
                key = $key; id = [string]$check.id; surface = [string]$results[$key].surface
                checkedAt = $Now.ToString('O'); expiresAt = $Now.AddSeconds([int]$check.freshnessSeconds).ToString('O'); result = $results[$key]
            })
        }
        [pscustomobject]@{ Results = $results; NewCells = @($newCells); TimedOut = $pending.Count -gt 0; RefreshedKeys = $refreshedKeys }
    } finally {
        if ($temporaryRoot.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $temporaryRoot)) {
            Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
        }
    }
}

function Test-SHManifestArtifacts {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Manifest, [Parameter(Mandatory = $true)]$Registry)
    if ((Get-SHSha256 -Path ([string]$Manifest.registry.path)) -ne [string]$Manifest.registry.sha256) { return $false }
    foreach ($check in $Registry.Checks) {
        $entry = $Manifest.providers.PSObject.Properties[[string]$check.id].Value
        if ($null -eq $entry) { return $false }
        $expectedHash = if ($entry -is [string]) { [string]$entry } else { [string]$entry.sha256 }
        $expectedPath = if ($entry -is [string]) { [string]$check.scriptPath } else { [string]$entry.path }
        if ([string]$check.scriptPath -ine $expectedPath -or (Get-SHSha256 -Path ([string]$check.scriptPath)) -ne $expectedHash) { return $false }
    }
    $true
}

function Test-SHActivationComplete {
    [CmdletBinding()]
    param([object]$Activation, [Parameter(Mandatory = $true)]$Manifest, [Parameter(Mandatory = $true)][string]$ManifestSha256)
    if ($null -eq $Activation -or [int]$Activation.schemaVersion -ne 1 -or [string]$Activation.generation -ne [string]$Manifest.generation) { return $false }
    $required = @($Manifest.runtimes | ForEach-Object { [string]$_.surface } | Sort-Object -Unique)
    foreach ($surface in $required) {
        $property = if ($null -eq $Activation.surfaces) { $null } else { $Activation.surfaces.PSObject.Properties[$surface] }
        if ($null -eq $property) { return $false }
        $entry = $property.Value
        if ($null -eq $entry -or -not [bool]$entry.passed -or [string]$entry.generation -ne [string]$Manifest.generation -or [string]$entry.manifestSha256 -ne $ManifestSha256) { return $false }
        $hookKey = if ($surface -eq 'claude') { 'claude' } else { 'codex' }
        if ([string]$entry.hookProjectionSha256 -ne [string]$Manifest.hooks.PSObject.Properties[$hookKey].Value.projectionSha256) { return $false }
    }
    $true
}

function Update-SHActivationEvidence {
    [CmdletBinding()]
    param(
        [object]$Activation,
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][string]$ManifestSha256,
        [Parameter(Mandatory = $true)][string]$Surface,
        [Parameter(Mandatory = $true)][string]$Path
    )
    $surfaces = [ordered]@{}
    if ($null -ne $Activation -and [string]$Activation.generation -eq [string]$Manifest.generation -and $null -ne $Activation.surfaces) {
        foreach ($property in @($Activation.surfaces.PSObject.Properties)) { $surfaces[$property.Name] = $property.Value }
    }
    $hookKey = if ($Surface -eq 'claude') { 'claude' } else { 'codex' }
    $surfaces[$Surface] = [ordered]@{
        passed = $true; generation = [string]$Manifest.generation; manifestSha256 = $ManifestSha256
        hookProjectionSha256 = [string]$Manifest.hooks.PSObject.Properties[$hookKey].Value.projectionSha256
        observedAt = [DateTimeOffset]::UtcNow.ToString('O'); mode = 'warn-only'
    }
    Write-SHAtomicJson $Path ([ordered]@{ schemaVersion = 1; generation = [string]$Manifest.generation; status = 'pending'; surfaces = $surfaces })
}

function Test-SHGatewayHealthReady {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$HealthPath,
        [Parameter(Mandatory = $true)][string]$ExpectedNodePath,
        [Parameter(Mandatory = $true)][string]$ExpectedGatewayEntry,
        [Parameter(Mandatory = $true)][string]$NativeAssemblyPath,
        [Parameter(Mandatory = $true)][DateTimeOffset]$AttemptedAt
    )
    try {
        $item = Get-Item -LiteralPath $HealthPath -ErrorAction Stop
        if ($item.Length -gt 65536) { return $false }
        $health = Get-Content -Raw -LiteralPath $HealthPath | ConvertFrom-Json
        $updated = [DateTimeOffset]::Parse([string]$health.updatedAt)
        $now = [DateTimeOffset]::UtcNow
        if ($updated -lt $AttemptedAt -or $updated -lt $now.AddSeconds(-45) -or $updated -gt $now.AddSeconds(15) -or -not [bool]$health.listenerReady -or [bool]$health.stopping) { return $false }
        $process = Get-SHProcessIdentity ([int]$health.pid) $NativeAssemblyPath
        $actualStart = ConvertFrom-SHFileTime ([string]$process.ProcessStartFileTime)
        $expectedStart = [DateTimeOffset]::Parse([string]$health.processStartedAt)
        if ([Math]::Abs(($actualStart - $expectedStart).TotalSeconds) -gt 5 -or [string]$process.ExecutablePath -ine $ExpectedNodePath) { return $false }
        if ($null -ne $health.PSObject.Properties['gatewayEntry'] -and [string]$health.gatewayEntry -ine $ExpectedGatewayEntry) { return $false }
        $true
    } catch { $false }
}

function Wait-SHGatewayReadiness {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][DateTimeOffset]$AttemptedAt,
        [int]$MaximumMilliseconds = 30000
    )
    $definition = if ($null -ne $Manifest.PSObject.Properties['taskPolicy']) { $Manifest.taskPolicy.definition } else { $null }
    $actions = if ($null -ne $definition -and $null -ne $definition.PSObject.Properties['actions']) { @($definition.actions) } else { @() }
    $action = if ($actions.Count -gt 0) { $actions[0] } else { $null }
    $expectedNode = if ($null -eq $action) { '' } else { [string]$action.execute }
    $repositoryRoot = Split-Path -Parent ([string]$Manifest.frameworkRoot)
    $gatewayRoot = if ($null -ne $action -and -not [string]::IsNullOrWhiteSpace([string]$action.workingDirectory)) { [string]$action.workingDirectory } else { Join-Path $repositoryRoot 'claude-projects\lark' }
    $gatewayEntry = Join-Path $gatewayRoot 'src\gateway.mjs'
    $healthPath = Join-Path $gatewayRoot 'run\health.json'
    $deadline = New-SHDeadline $MaximumMilliseconds
    $activeObserved = $false
    while ((Get-SHRemainingMilliseconds $deadline) -gt 0) {
        $task = Get-SHGatewayTaskDefinition
        if ($null -eq $task -or -not [bool]$task.enabled -or [string]$task.state -eq 'Disabled') { return 'gateway-task-exited' }
        if ([string]$task.state -in @('Running', 'Queued')) { $activeObserved = $true }
        elseif ($activeObserved -or ([DateTimeOffset]::UtcNow - $AttemptedAt).TotalSeconds -ge 3) { return 'gateway-task-exited' }
        if ($activeObserved -and (Test-SHGatewayHealthReady $healthPath $expectedNode $gatewayEntry ([string]$Manifest.nativeAssembly.path) $AttemptedAt)) { return 'listener-ready' }
        Start-Sleep -Milliseconds 250
    }
    'gateway-start-timeout'
}

function Invoke-SHRunner {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)][ValidateSet('claude', 'codex', 'desktop')][string]$Surface,
        [Parameter(Mandatory = $true)][string]$StateRoot
    )
    $mutex = $null; $readiness = $null; $warnings = @(); $registry = $null; $cells = @(); $results = @{}; $manifestSha = $null
    $policy = $null; $policyCheck = $null; $policyKey = $null; $policyId = $null; $policyOrder = -1
    $logPath = Join-Path $StateRoot 'runner.log'
    $overall = New-SHDeadline 60000
    try {
        $mutex = Enter-SHMutex -WaitMilliseconds 0
        if (-not $mutex.Acquired) { return }
        if (Test-Path -LiteralPath (Join-Path $StateRoot 'disabled') -PathType Leaf) { return }
        $checkDeadline = New-SHDeadline 20000
        $manifestPath = Join-Path $StateRoot 'install-manifest.json'
        $currentManifest = Read-SHStateJson $manifestPath
        if ($null -eq $currentManifest -or [string]$currentManifest.generation -ne [string]$Manifest.generation -or -not [bool]$currentManifest.installed) { return }
        $Manifest = $currentManifest
        $manifestSha = Get-SHSha256 -Path $manifestPath
        try {
            $registry = Read-SHRegistry ([string]$Manifest.registry.path)
            if (-not (Test-SHManifestArtifacts $Manifest $registry)) { throw 'manifest-artifact-drift' }
        } catch {
            $warnings = @([pscustomobject]@{ id = 'config-integrity'; status = 'warn'; reasonCode = 'manifest-artifact-drift'; registryOrder = 0 })
            throw 'runner-report-only'
        }
        $modePath = Join-Path $StateRoot 'mode.json'
        $mode = Read-SHStateJson $modePath -QuarantineCorrupt
        $autoStartMode = if ($null -ne $mode -and [int]$mode.schemaVersion -eq 1 -and [string]$mode.autoStart -in @('warn-only', 'enabled')) { [string]$mode.autoStart } else { 'warn-only' }
        if ($autoStartMode -eq 'warn-only' -and ($null -eq $mode -or [string]$mode.autoStart -notin @('warn-only', 'enabled'))) {
            $warnings += [pscustomobject]@{ id = 'startup-health'; status = 'warn'; reasonCode = 'mode-invalid'; registryOrder = -1 }
        }
        $latestPath = Join-Path $StateRoot 'latest.json'
        $latest = Read-SHStateJson $latestPath -QuarantineCorrupt
        $existingCells = if ($null -eq $latest -or [string]$latest.generation -ne [string]$Manifest.generation) { @() } else { @($latest.cells) }
        $now = [DateTimeOffset]::UtcNow
        $plan = Get-SHProviderPlan -Registry $registry -Surface $Surface -ExistingCells $existingCells -Now $now
        $profiles = [Collections.Generic.List[string]]::new()
        if (@($plan.RefreshKeys) -contains 'runtime-dependencies|global') { $profiles.Add('version-output') }
        if ($Surface -ne 'claude' -and @($plan.RefreshKeys) -contains ('config-integrity|' + $Surface)) { $profiles.Add('codex-config-load') }
        $probeFacts = @{}
        if ($profiles.Count -gt 0) {
            $probeBudget = [Math]::Min((Get-SHRemainingMilliseconds $overall), [Math]::Min((Get-SHRemainingMilliseconds $checkDeadline), 7000))
            if ($probeBudget -gt 0) { $probeFacts = Invoke-SHDiagnosticProbes $Manifest $probeBudget @($profiles) }
        }
        $providerBudget = [Math]::Min((Get-SHRemainingMilliseconds $overall), [Math]::Min((Get-SHRemainingMilliseconds $checkDeadline), 10000))
        if ($providerBudget -gt 0) {
            $schedule = Invoke-SHProviderSchedule -Registry $registry -Surface $Surface -Manifest $Manifest -ExistingCells $existingCells -BudgetMilliseconds $providerBudget -Now $now -ProbeFacts $probeFacts -Plan $plan
        } else {
            $skippedResults = @{}
            foreach ($key in @($plan.FreshResults.Keys)) { $skippedResults[$key] = $plan.FreshResults[$key] }
            foreach ($key in @($plan.RefreshKeys)) { $skippedResults[$key] = New-SHProviderFailureResult $plan.ChecksByKey[$key] $Surface 'provider-timeout' }
            $schedule = [pscustomobject]@{ Results = $skippedResults; NewCells = @(); TimedOut = $plan.RefreshKeys.Count -gt 0; RefreshedKeys = @() }
        }
        $results = $schedule.Results
        $cells = @(Merge-SHSnapshotCells $existingCells $schedule.NewCells $now)
        $order = @{}; $orderIndex = 0
        foreach ($check in $registry.Checks) { $order[[string]$check.id] = $orderIndex; $orderIndex++ }
        foreach ($check in $registry.Checks) {
            $key = Get-SHCellKey $check $Surface
            if ($results.ContainsKey($key) -and [string]$results[$key].status -ne 'ok') {
                $warnings += [pscustomobject]@{ id = [string]$results[$key].id; status = [string]$results[$key].status; reasonCode = [string]$results[$key].reasonCode; registryOrder = [int]$order[[string]$check.id] }
            }
        }
        Write-SHAtomicJson $latestPath ([ordered]@{ schemaVersion = 1; generation = [string]$Manifest.generation; updatedAt = [DateTimeOffset]::UtcNow.ToString('O'); cells = $cells })

        $activationPath = Join-Path $StateRoot 'activation.json'
        $activation = Read-SHStateJson $activationPath -QuarantineCorrupt
        if ($autoStartMode -eq 'warn-only') {
            Update-SHActivationEvidence $activation $Manifest $manifestSha $Surface $activationPath
            $activation = Read-SHStateJson $activationPath
        }
        $policy = Get-SHAutoStartPolicy -Registry $registry -Manifest $Manifest
        if ($null -ne $policy) {
            $policyCheck = $policy.Check; $policyKey = $policy.Key; $policyId = $policy.PolicyId
            if ($order.ContainsKey([string]$policyCheck.id)) { $policyOrder = [int]$order[[string]$policyCheck.id] }
        }
        $eligible = $null -ne $policy -and -not $schedule.TimedOut -and @($schedule.RefreshedKeys) -contains $policyKey -and
            $results.ContainsKey($policyKey) -and [string]$results[$policyKey].startEligibility -eq 'eligible' -and
            [bool]$results[$policyKey].dependencyReady -eq $true -and
            (@($policy.ExpectedReasons).Count -eq 0 -or [string]$results[$policyKey].reasonCode -in @($policy.ExpectedReasons))
        if ($autoStartMode -eq 'enabled' -and $eligible) {
            if (-not (Test-SHActivationComplete $activation $Manifest $manifestSha)) {
                $warnings += [pscustomobject]@{ id = 'startup-health'; status = 'warn'; reasonCode = 'activation-incomplete'; registryOrder = -1 }
            } else {
                $ledgerPath = Join-Path $StateRoot 'start-attempts.json'
                $ledgerExisted = Test-Path -LiteralPath $ledgerPath -PathType Leaf
                $ledger = Read-SHStateJson $ledgerPath -QuarantineCorrupt
                $canAttempt = $ledgerExisted -and $null -ne $ledger
                if ($null -eq $ledger) { Write-SHAtomicJson $ledgerPath ([ordered]@{ schemaVersion = 1 }) }
                if ($null -ne $ledger -and $null -ne $ledger.PSObject.Properties[$policyId]) {
                    try {
                        $cooldownSeconds = [Math]::Max(0, [int]$policy.CooldownSeconds)
                        $canAttempt = [DateTimeOffset]::Parse([string]$ledger.$policyId.attemptedAt).AddSeconds($cooldownSeconds) -le [DateTimeOffset]::UtcNow
                    } catch { $canAttempt = $false }
                }
                $startBudget = Get-SHPhaseBudget $overall 3000 30000
                if ($canAttempt -and $startBudget -ge 500) {
                    $startDeadline = New-SHDeadline $startBudget
                    $freshMode = Read-SHStateJson $modePath
                    $task = Get-SHGatewayTaskDefinition
                    $installedTask = if ($null -ne $Manifest.PSObject.Properties['taskPolicy']) { $Manifest.taskPolicy.definition } else { $null }
                    $installedActions = if ($null -ne $installedTask -and $null -ne $installedTask.PSObject.Properties['actions']) { @($installedTask.actions) } else { @() }
                    $installedAction = if ($installedActions.Count -gt 0) { $installedActions[0] } else { $null }
                    $expected = if ($null -eq $installedAction) { $null } else {
                        [pscustomobject]@{ execute = [string]$installedAction.execute; arguments = [string]$installedAction.arguments; workingDirectory = [string]$installedAction.workingDirectory; userSid = [string]$installedTask.userSid }
                    }
                    $hookKey = if ($Surface -eq 'claude') { 'claude' } else { 'codex' }
                    $hookDefinition = $Manifest.hooks.PSObject.Properties[$hookKey].Value
                    $projection = Get-SHHookProjection ([string]$hookDefinition.configPath)
                    if ($null -ne $expected -and $null -ne $freshMode -and [string]$freshMode.autoStart -eq 'enabled' -and $null -ne $task -and
                        [string]$task.state -eq 'Ready' -and (Test-SHGatewayTaskDefinition $task $expected) -and
                        $projection.Sha256 -eq [string]$hookDefinition.projectionSha256 -and
                        (Get-SHRemainingMilliseconds $startDeadline) -ge 100) {
                        $helperBudget = Get-SHRemainingMilliseconds $startDeadline
                        $attemptedAt = [DateTimeOffset]::UtcNow
                        $ledgerObject = [ordered]@{ schemaVersion = 1; $policyId = [ordered]@{ attemptedAt = $attemptedAt.ToString('O'); generation = [string]$Manifest.generation; surface = $Surface } }
                        Write-SHAtomicJson $ledgerPath $ledgerObject
                        $helper = Join-Path ([string]$Manifest.frameworkRoot) 'internal\Start-LarkGatewayTask.ps1'
                        $powerShell = (Get-Command powershell.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
                        $startResult = Invoke-SHIsolatedProcess $powerShell @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $helper) ([string]$Manifest.frameworkRoot) $helperBudget 4096
                        if (-not $startResult.TimedOut -and $startResult.ExitCode -eq 0) {
                            $readiness = [pscustomobject]@{ AttemptedAt = $attemptedAt; Key = $policyKey; Check = $policyCheck; Order = $policyOrder }
                        } else {
                            $results[$policyKey] = New-SHProviderFailureResult $policyCheck $Surface 'gateway-task-exited'
                            $warnings = @($warnings | Where-Object id -ne [string]$policyCheck.id)
                            $warnings += [pscustomobject]@{ id = [string]$policyCheck.id; status = 'warn'; reasonCode = 'gateway-task-exited'; registryOrder = $policyOrder }
                        }
                    }
                }
            }
        }
    } catch {
        if ($_.Exception.Message -ne 'runner-report-only') {
            Write-SHLog $logPath ('runner-error ' + $_.Exception.GetType().Name)
            if ($warnings.Count -eq 0) { $warnings = @([pscustomobject]@{ id = 'startup-health'; status = 'warn'; reasonCode = 'runner-failed'; registryOrder = -1 }) }
        }
    } finally {
        if ($null -ne $mutex) { Exit-SHMutex $mutex; $mutex = $null }
    }

    if ($null -ne $readiness) {
        try {
            $remaining = Get-SHRemainingMilliseconds $overall
            $readinessBudget = [Math]::Min(30000, [Math]::Max(0, $remaining - 7000))
            $reason = if ($readinessBudget -le 0) { 'gateway-start-timeout' } else { Wait-SHGatewayReadiness $Manifest $readiness.AttemptedAt $readinessBudget }
            $gatewayCheck = $readiness.Check
            if ($reason -eq 'listener-ready') {
                $results[$readiness.Key] = [pscustomobject]@{ schemaVersion = 1; id = [string]$gatewayCheck.id; surface = 'global'; status = 'ok'; reasonCode = 'listener-ready'; guidanceId = $null; startEligibility = 'not-needed'; dependencyReady = $true; facts = [pscustomobject]@{} }
            } else {
                $results[$readiness.Key] = New-SHProviderFailureResult $gatewayCheck $Surface $reason
            }
            $warnings = @($warnings | Where-Object id -ne [string]$gatewayCheck.id)
            if ([string]$results[$readiness.Key].status -ne 'ok') { $warnings += [pscustomobject]@{ id = [string]$gatewayCheck.id; status = 'warn'; reasonCode = $reason; registryOrder = $readiness.Order } }
            $mutex = Enter-SHMutex -WaitMilliseconds 1000
            if ($mutex.Acquired -and (Test-SHManifestGenerationCurrent $Manifest $StateRoot) -and -not (Test-Path -LiteralPath (Join-Path $StateRoot 'disabled') -PathType Leaf)) {
                $now = [DateTimeOffset]::UtcNow
                $replacement = [pscustomobject]@{ key = $readiness.Key; id = [string]$gatewayCheck.id; surface = 'global'; checkedAt = $now.ToString('O'); expiresAt = $now.AddSeconds([int]$gatewayCheck.freshnessSeconds).ToString('O'); result = $results[$readiness.Key] }
                $currentLatest = Read-SHStateJson (Join-Path $StateRoot 'latest.json')
                $currentCells = if ($null -ne $currentLatest -and [string]$currentLatest.generation -eq [string]$Manifest.generation) { @($currentLatest.cells) } else { @() }
                $cells = @(Merge-SHSnapshotCells $currentCells @($replacement) $now)
                Write-SHAtomicJson (Join-Path $StateRoot 'latest.json') ([ordered]@{ schemaVersion = 1; generation = [string]$Manifest.generation; updatedAt = $now.ToString('O'); cells = $cells })
            }
        } catch {
            if ($null -ne $readiness) { $warnings += [pscustomobject]@{ id = [string]$readiness.Check.id; status = 'warn'; reasonCode = 'gateway-start-timeout'; registryOrder = $readiness.Order } }
        } finally { if ($null -ne $mutex) { Exit-SHMutex $mutex; $mutex = $null } }
    }

    try {
        if ($warnings.Count -eq 0) { return }
        if (-not (Test-SHManifestGenerationCurrent $Manifest $StateRoot)) { return }
        if (Test-Path -LiteralPath (Join-Path $StateRoot 'disabled') -PathType Leaf) { return }
        $notifyPath = Join-Path $StateRoot 'last-notified.json'
        $notifyMutex = Enter-SHMutex -WaitMilliseconds 1000
        if (-not $notifyMutex.Acquired) { Exit-SHMutex $notifyMutex; return }
        try {
            $ledger = Read-SHStateJson $notifyPath -QuarantineCorrupt
            if (Test-SHShouldNotify $ledger $Surface $warnings) {
                $entries = [ordered]@{}
                if ($null -ne $ledger) { foreach ($property in @($ledger.PSObject.Properties)) { $entries[$property.Name] = $property.Value } }
                $entries[$Surface] = [ordered]@{ hash = Get-SHWarningSetHash $warnings; notifiedAt = [DateTimeOffset]::UtcNow.ToString('O') }
                Write-SHAtomicJson $notifyPath $entries
                [Console]::Out.Write((ConvertTo-SHSystemMessageEnvelope $warnings))
            }
        } finally { Exit-SHMutex $notifyMutex }
    } catch { Write-SHLog $logPath ('report-error ' + $_.Exception.GetType().Name) }
}

function Format-SHWarningPayload {
    [CmdletBinding()]
    param([object[]]$Warnings = @(), [int]$MaximumSegments = 8, [int]$MaximumBytes = 1024)
    $ordered = @($Warnings | Sort-Object @{ Expression = { if ([string]$_.status -eq 'error') { 0 } else { 1 } } }, @{ Expression = { [int]$_.registryOrder } })
    $segments = [Collections.Generic.List[string]]::new()
    $limit = [Math]::Min($MaximumSegments, $ordered.Count)
    for ($index = 0; $index -lt $limit; $index++) {
        $warning = $ordered[$index]
        $segment = '{0}={1}({2})' -f [string]$warning.id, [string]$warning.status, [string]$warning.reasonCode
        if ($segment -notmatch '^[a-z0-9-]+=(?:warn|error)\([a-z0-9-]+\)$') { continue }
        $segments.Add($segment)
    }
    $omitted = $ordered.Count - $segments.Count
    function Build-SHPayload([Collections.Generic.List[string]]$Values, [int]$Hidden) {
        $parts = @($Values)
        if ($Hidden -gt 0) { $parts += ('more-warnings=warn(omitted-{0})' -f [Math]::Min(999, $Hidden)) }
        'AI health: ' + ($parts -join ' | ')
    }
    $payload = Build-SHPayload $segments $omitted
    while ([Text.Encoding]::UTF8.GetByteCount($payload) -gt $MaximumBytes -and $segments.Count -gt 0) {
        $segments.RemoveAt($segments.Count - 1)
        $omitted++
        $payload = Build-SHPayload $segments $omitted
    }
    if ([Text.Encoding]::UTF8.GetByteCount($payload) -gt $MaximumBytes) { return 'AI health: more-warnings=warn(omitted)' }
    $payload
}

function ConvertTo-SHSystemMessageEnvelope {
    [CmdletBinding()]
    param([object[]]$Warnings = @(), [int]$MaximumEnvelopeBytes = 1280)
    $working = @($Warnings)
    while ($true) {
        $payload = Format-SHWarningPayload $working
        $line = (@{ systemMessage = $payload } | ConvertTo-Json -Compress) + [Environment]::NewLine
        if ([Text.Encoding]::UTF8.GetByteCount($line) -le $MaximumEnvelopeBytes) { return $line }
        if ($working.Count -eq 0) { return (@{ systemMessage = 'AI health: more-warnings=warn(omitted)' } | ConvertTo-Json -Compress) + [Environment]::NewLine }
        $working = @($working | Select-Object -First ($working.Count - 1))
    }
}

function Get-SHWarningSetHash {
    [CmdletBinding()]
    param([object[]]$Warnings = @())
    $identity = @($Warnings | Sort-Object id, status, reasonCode | ForEach-Object { '{0}|{1}|{2}' -f $_.id, $_.status, $_.reasonCode }) -join "`n"
    Get-SHSha256 -Text $identity
}

function Test-SHShouldNotify {
    [CmdletBinding()]
    param([object]$Ledger, [Parameter(Mandatory = $true)][string]$Surface, [object[]]$Warnings = @(), [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow, [int]$SuppressionMinutes = 30)
    if ($Warnings.Count -eq 0) { return $false }
    if ($null -eq $Ledger -or $null -eq $Ledger.PSObject.Properties[$Surface]) { return $true }
    $prior = $Ledger.PSObject.Properties[$Surface].Value
    $hash = Get-SHWarningSetHash $Warnings
    if ([string]$prior.hash -ne $hash) { return $true }
    try { ([DateTimeOffset]::Parse([string]$prior.notifiedAt)).AddMinutes($SuppressionMinutes) -le $Now }
    catch { $true }
}

Export-ModuleMember -Function Get-SHRepositoryRoot, Get-SHStateRoot, Get-SHSha256, Install-SHNativeAssembly, Get-SHFileIdentity, Test-SHFileIdentity, Test-SHDirectoryAccess, Get-SHProcessIdentity, ConvertFrom-SHFileTime, Resolve-SHAccountSid, Test-SHGatewayTaskDefinition, Get-SHGatewayTaskDefinition, Get-SHAsarPackageMetadata, Read-SHAsarPackageVersionAt, Get-SHHookProjection, Test-SHEntryGuardEvidence, Read-SHRegistry, ConvertFrom-SHProviderResult, Write-SHAtomicJson, Read-SHStateJson, Move-SHCorruptState, Write-SHLog, Get-SHMutexName, Enter-SHMutex, Exit-SHMutex, New-SHDeadline, Get-SHRemainingMilliseconds, Invoke-SHIsolatedProcess, Invoke-SHProcessBatch, Get-SHProbeKey, Invoke-SHDiagnosticProbes, Test-SHDeterministicSchedule, Merge-SHSnapshotCells, Read-SHJsoncDocument, Test-SHPathEquivalent, Test-SHCommandReferences, Test-SHObjectCommandReferences, Get-SHLarkCliInfo, Get-SHChromeDebugPort, Get-SHProfilePaths, Get-SHOwnedHookCount, Get-SHPhaseBudget, Get-SHAutoStartPolicy, Test-SHManifestGenerationCurrent, Test-SHShouldNotifyGuard, Update-SHGuardNotification, New-SHProviderContext, Get-SHCellKey, Get-SHProviderPlan, Invoke-SHProviderSchedule, Test-SHManifestArtifacts, Test-SHActivationComplete, Update-SHActivationEvidence, Test-SHGatewayHealthReady, Wait-SHGatewayReadiness, Invoke-SHRunner, Format-SHWarningPayload, ConvertTo-SHSystemMessageEnvelope, Get-SHWarningSetHash, Test-SHShouldNotify
