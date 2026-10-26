[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateSet('Preflight', 'Install')][string]$Mode = 'Preflight',
    [string]$UserHome,
    [string]$StateRoot,
    [string]$InventoryPath,
    [string]$DesktopAppAsarPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$frameworkRoot = $PSScriptRoot
$repositoryRoot = Split-Path -Parent $frameworkRoot
Import-Module (Join-Path $frameworkRoot 'StartupHealth.psm1') -Force
Import-Module (Join-Path $frameworkRoot 'StartupHealthInstaller.psm1') -Force

if ([string]::IsNullOrWhiteSpace($UserHome)) {
    $UserHome = [Environment]::GetFolderPath('UserProfile')
    if ([string]::IsNullOrWhiteSpace($UserHome)) { $UserHome = $env:USERPROFILE }
}
if ([string]::IsNullOrWhiteSpace($UserHome)) { throw 'User profile directory is unavailable.' }
if ([string]::IsNullOrWhiteSpace($StateRoot)) {
    $localApplicationData = [Environment]::GetFolderPath('LocalApplicationData')
    if ([string]::IsNullOrWhiteSpace($localApplicationData)) { $localApplicationData = $env:LOCALAPPDATA }
    $StateRoot = Get-SHStateRoot $localApplicationData
}
if ($Mode -eq 'Install' -and -not [string]::IsNullOrWhiteSpace($InventoryPath)) {
    throw 'Fixture runtime inventories are accepted only by read-only preflight.'
}

$issues = [Collections.Generic.List[object]]::new()
function Add-PreflightIssue([string]$Code, [string]$Detail) {
    $issues.Add([pscustomobject]@{ code = $Code; detail = $Detail })
}

$matrixPath = Join-Path $frameworkRoot 'compatibility.json'
$registryPath = Join-Path $frameworkRoot 'checks.json'
$packageLockPath = Join-Path $frameworkRoot 'tools\package-lock.json'
$parserPath = Join-Path $frameworkRoot 'tools\node_modules\jsonc-parser\lib\umd\main.js'
$gatewayRoot = Join-Path $repositoryRoot 'claude-projects\lark'
$taskDefinition = $null
try { $taskDefinition = Get-SHGatewayTaskDefinition } catch { }
if ($null -ne $taskDefinition -and $null -ne $taskDefinition.PSObject.Properties['actions'] -and @($taskDefinition.actions).Count -gt 0 -and
    -not [string]::IsNullOrWhiteSpace([string]$taskDefinition.actions[0].workingDirectory)) {
    $gatewayRoot = [string]$taskDefinition.actions[0].workingDirectory
}
$gatewayEntry = Join-Path $gatewayRoot 'src\gateway.mjs'
$gatewayHealthSource = Join-Path $gatewayRoot 'src\gateway-health.mjs'

try { $matrix = Read-SHCompatibilityMatrix $matrixPath } catch { Add-PreflightIssue 'compatibility-matrix-invalid' $_.Exception.Message; $matrix = $null }

$nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$powerShellCommand = Get-Command powershell.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $nodeCommand) { Add-PreflightIssue 'node-missing' 'node.exe was not found.' }
if ($null -eq $powerShellCommand) { Add-PreflightIssue 'powershell-missing' 'powershell.exe was not found.' }

try {
    $lockText = Get-Content -Raw -LiteralPath $packageLockPath
    if ($lockText.Length -gt 1048576 -or $lockText -notmatch '(?s)"node_modules/jsonc-parser"\s*:\s*\{.{0,2048}?"version"\s*:\s*"3\.3\.1"') {
        throw 'package-lock does not pin jsonc-parser 3.3.1.'
    }
    if (-not (Test-Path -LiteralPath $parserPath -PathType Leaf)) { throw 'Pinned jsonc-parser dependency is not installed; run npm ci in startup-health/tools.' }
} catch { Add-PreflightIssue 'config-editor-dependency-invalid' $_.Exception.Message }

try {
    $registry = Read-SHRegistry $registryPath
    $schedule = @($registry.Checks | Where-Object enabled | ForEach-Object {
        [pscustomobject]@{ Id = [string]$_.id; TimeoutMilliseconds = [int]$_.checkTimeoutMs; DependsOn = @($_.dependsOn) }
    })
    if (-not (Test-SHDeterministicSchedule -Items $schedule -MaximumConcurrency 4 -BudgetMilliseconds 10000)) {
        throw 'Provider critical path exceeds the 10-second provider budget.'
    }
} catch { Add-PreflightIssue 'registry-or-budget-invalid' $_.Exception.Message; $registry = $null }

try {
    $gatewayText = Get-Content -Raw -LiteralPath $gatewayEntry
    $healthText = Get-Content -Raw -LiteralPath $gatewayHealthSource
    if ($gatewayText -notmatch '\bprocessStartedAt\b' -or $healthText -notmatch '\bprocessStartedAt\b') {
        throw 'Gateway health contract does not publish processStartedAt.'
    }
} catch { Add-PreflightIssue 'gateway-health-contract-missing' $_.Exception.Message }

try {
    $runtimes = if ([string]::IsNullOrWhiteSpace($InventoryPath)) {
        @(Get-SHRuntimeInventory -FrameworkRoot $frameworkRoot -DesktopAppAsarPath $DesktopAppAsarPath)
    } else {
        @((Get-Content -Raw -LiteralPath $InventoryPath | ConvertFrom-Json).runtimes)
    }
    if ($null -ne $matrix) {
        $compatibility = Test-SHCompatibilityInventory -Matrix $matrix -Runtimes $runtimes
        foreach ($issue in $compatibility.Issues) {
            Add-PreflightIssue $issue.code ("surface={0}; path={1}; observed={2}" -f $issue.surface, $issue.path, $issue.observed)
        }
    }
} catch { Add-PreflightIssue 'runtime-inventory-failed' $_.Exception.Message; $runtimes = @() }

try {
    if ($null -eq $taskDefinition) { throw 'Scheduled task LarkClaudeGateway is not installed.' }
    $expectedTask = [pscustomobject]@{
        execute = [IO.Path]::GetFullPath([string]$nodeCommand.Source)
        arguments = '"{0}"' -f [IO.Path]::GetFullPath($gatewayEntry)
        workingDirectory = [IO.Path]::GetFullPath($gatewayRoot)
        userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    }
    if ($taskDefinition.taskPath -ne '\' -or $taskDefinition.taskName -ne 'LarkClaudeGateway' -or -not (Test-SHGatewayTaskDefinition $taskDefinition $expectedTask)) {
        throw 'Scheduled task LarkClaudeGateway differs from the fixed startup policy.'
    }
} catch { Add-PreflightIssue 'gateway-task-policy-invalid' $_.Exception.Message }

$report = [ordered]@{
    schemaVersion = 1
    mode = $Mode.ToLowerInvariant()
    approved = $issues.Count -eq 0
    matrixVersion = if ($null -eq $matrix) { $null } else { [string]$matrix.matrixVersion }
    runtimes = @($runtimes | ForEach-Object {
        [ordered]@{
            surface = [string]$_.surface
            path = [string]$_.path
            version = [string]$_.version
            internalBuild = if ($null -eq $_.PSObject.Properties['internalBuild']) { $null } else { [string]$_.internalBuild }
        }
    })
    issues = @($issues)
}

if ($Mode -eq 'Preflight' -or $issues.Count -gt 0 -or $WhatIfPreference) {
    $report | ConvertTo-Json -Depth 10
    if ($Mode -eq 'Install' -and $issues.Count -gt 0) { exit 2 }
    exit 0
}

if (-not $PSCmdlet.ShouldProcess('Claude and Codex user hook configurations', 'Install AIStartupHealthV1 hooks in warn-only mode')) { exit 0 }

$stagingRoot = Join-Path ([IO.Path]::GetTempPath()) ('startup-health-install-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($stagingRoot) | Out-Null
$nativeDestination = $null
$nativeHash = $null
$installationCommitted = $false
try {
    $generation = [Guid]::NewGuid().ToString('N')
    $nativeCandidate = Join-Path $stagingRoot 'StartupHealthNative.dll'
    $nativeHash = Install-SHNativeAssembly $nativeCandidate
    $nativeDestination = Join-Path $StateRoot ("StartupHealthNative-$generation.dll")
    if (-not (Test-Path -LiteralPath $StateRoot -PathType Container)) { [IO.Directory]::CreateDirectory($StateRoot) | Out-Null }
    [IO.File]::Copy($nativeCandidate, $nativeDestination, $false)

    $hookScriptPath = Join-Path $frameworkRoot 'Invoke-StartupHealthHook.ps1'
    $hookCommand = New-SHOwnedHookCommand -PowerShellPath ([string]$powerShellCommand.Source) -HookScriptPath $hookScriptPath
    $nodePath = [string]$nodeCommand.Source
    $targetDefinitions = @(
        [pscustomobject]@{ key = 'claude'; configPath = Join-Path $UserHome '.claude\settings.json' },
        [pscustomobject]@{ key = 'codex'; configPath = Join-Path $UserHome '.codex\hooks.json' }
    )
    $targets = [Collections.Generic.List[object]]::new()
    foreach ($definition in $targetDefinitions) {
        $sourceStamp = Get-SHFileStamp $definition.configPath
        $editorInput = $definition.configPath
        if (-not $sourceStamp.exists) {
            $editorInput = Join-Path $stagingRoot ($definition.key + '-empty.json')
            [IO.File]::WriteAllText($editorInput, "{}`r`n", [Text.UTF8Encoding]::new($false))
        }
        $candidatePath = Join-Path $stagingRoot ($definition.key + '-candidate.json')
        $null = Invoke-SHConfigEditor -NodePath $nodePath -Action install -InputPath $editorInput -OutputPath $candidatePath -Command $hookCommand -FrameworkRoot $frameworkRoot
        $projection = Get-SHHookProjection $candidatePath
        if ($projection.Projection.matcher -ne '^(startup|resume)$' -or -not $projection.Projection.async -or $projection.Projection.timeout -ne 75 -or
            $projection.Projection.type -ne 'command' -or [string]::IsNullOrWhiteSpace([string]$projection.Projection.command)) {
            throw "Owned hook candidate is invalid: $($definition.key)"
        }
        $targets.Add([pscustomobject]@{
            key = $definition.key
            configPath = [IO.Path]::GetFullPath($definition.configPath)
            candidatePath = $candidatePath
            sourceStamp = $sourceStamp
            candidateSha256 = Get-SHSha256 -Path $candidatePath
            projection = $projection
        })
    }

    $claudeTarget = @($targets | Where-Object key -eq 'claude')[0]
    foreach ($runtime in @($runtimes | Where-Object surface -eq 'claude')) {
        $validation = Invoke-SHIsolatedProcess -Executable ([string]$runtime.path) -Arguments @('--settings', $claudeTarget.candidatePath, 'doctor') -WorkingDirectory $repositoryRoot -TimeoutMilliseconds 8000 -MaximumBytes 32768
        $validationText = ([string]$validation.Stdout + "`n" + [string]$validation.Stderr)
        if ($validation.TimedOut -or $validation.ExitCode -ne 0 -or $validationText -match '(?im)\bSessionStart\b[^\r\n]*(?:ignored|invalid|must be|error)') {
            throw "Claude rejected the candidate hook configuration: $($runtime.path)"
        }
    }
    # Codex has no offline hook-schema validator. The candidate is validated by the
    # JSONC parser plus the owned-hook identity checks above; behavior is proven by
    # the warning-only async-hook canary, never by `doctor` (which reports auth and
    # network state, not hook schema).
    $codexTarget = @($targets | Where-Object key -eq 'codex')[0]
    if (-not (Test-Path -LiteralPath $codexTarget.candidatePath -PathType Leaf)) { throw 'Codex hook candidate is missing.' }

    $providerArtifacts = [ordered]@{}
    foreach ($check in $registry.Checks) {
        $providerArtifacts[[string]$check.id] = [ordered]@{ path = [IO.Path]::GetFullPath([string]$check.scriptPath); sha256 = Get-SHSha256 -Path ([string]$check.scriptPath) }
    }
    $manifestHooks = [ordered]@{}
    foreach ($target in $targets) {
        $manifestHooks[$target.key] = [ordered]@{
            configPath = $target.configPath
            projectionSha256 = $target.projection.Sha256
            installedSha256 = $target.candidateSha256
        }
    }
    $manifestRuntimes = @($runtimes | ForEach-Object {
        $entry = [ordered]@{ surface = $_.surface; version = $_.version; file = $_.file }
        if ($_.surface -eq 'desktop') { $entry.appAsar = $_.appAsar }
        [pscustomobject]$entry
    })
    $diagnosticProbes = [Collections.Generic.List[object]]::new()
    $probeCandidates = [Collections.Generic.List[object]]::new()
    $probeCandidates.Add([pscustomobject]@{ id = 'node-version'; surface = 'global'; path = $nodePath; arguments = @('--version') })
    $larkCli = Get-SHLarkCliInfo
    if ($null -ne $larkCli -and [bool]$larkCli.EntryExists) {
        $probeCandidates.Add([pscustomobject]@{ id = 'lark-cli-version'; surface = 'global'; path = $nodePath; arguments = @([string]$larkCli.Entry, '--version') })
    }
    $codexRuntime = @($runtimes | Where-Object { $_.surface -in @('codex', 'desktop') } | Select-Object -First 1)
    if ($codexRuntime.Count -eq 1) {
        $probeCandidates.Add([pscustomobject]@{ id = 'codex-config-load'; profile = 'codex-config-load'; surface = 'global'; path = [string]$codexRuntime[0].path; arguments = @('doctor', '--json'); timeoutMilliseconds = 6500 })
    }
    $runtimeIndex = 0
    foreach ($runtime in @($runtimes)) {
        $runtimeIndex++
        $probeCandidates.Add([pscustomobject]@{ id = ([string]$runtime.surface + '-version-' + $runtimeIndex); surface = [string]$runtime.surface; path = [string]$runtime.path; arguments = @('--version') })
    }
    foreach ($probe in $probeCandidates) {
        $diagnosticProbes.Add([ordered]@{
            id = [string]$probe.id
            profile = if ($null -ne $probe.PSObject.Properties['profile']) { [string]$probe.profile } else { 'version-output' }
            surface = [string]$probe.surface
            file = Get-SHFileIdentity ([string]$probe.path) $nativeDestination
            sha256 = Get-SHSha256 -Path ([string]$probe.path)
            arguments = @($probe.arguments)
            timeoutMilliseconds = if ($null -ne $probe.PSObject.Properties['timeoutMilliseconds']) { [int]$probe.timeoutMilliseconds } else { 3500 }
        })
    }
    $taskJson = $taskDefinition | ConvertTo-Json -Compress -Depth 10
    $manifest = [ordered]@{
        schemaVersion = 1
        installed = $true
        generation = $generation
        installedAt = [DateTimeOffset]::UtcNow.ToString('O')
        frameworkRoot = [IO.Path]::GetFullPath($frameworkRoot)
        matrixVersion = [string]$matrix.matrixVersion
        nativeAssembly = [ordered]@{ path = [IO.Path]::GetFullPath($nativeDestination); sha256 = $nativeHash }
        registry = [ordered]@{ path = [IO.Path]::GetFullPath($registryPath); sha256 = Get-SHSha256 -Path $registryPath }
        providers = $providerArtifacts
        diagnosticProbes = @($diagnosticProbes)
        runtimes = $manifestRuntimes
        hooks = $manifestHooks
        taskPolicy = [ordered]@{ id = 'lark-gateway-task-v1'; definition = $taskDefinition; sha256 = Get-SHSha256 -Text $taskJson }
    }
    $transaction = Install-SHHookTransaction -Targets @($targets) -StateRoot $StateRoot -Manifest $manifest
    $installationCommitted = $true
    [ordered]@{ installed = $transaction.Installed; generation = $generation; mode = 'warn-only'; activation = 'pending' } | ConvertTo-Json -Compress
} finally {
    if (-not $installationCommitted -and -not [string]::IsNullOrWhiteSpace($nativeDestination) -and
        (Test-Path -LiteralPath $nativeDestination -PathType Leaf)) {
        try {
            if ([string]::IsNullOrWhiteSpace($nativeHash) -or (Get-SHSha256 -Path $nativeDestination) -eq $nativeHash) {
                Remove-Item -LiteralPath $nativeDestination -Force
            }
        } catch { }
    }
    if (Test-Path -LiteralPath $stagingRoot -PathType Container) { Remove-Item -LiteralPath $stagingRoot -Recurse -Force }
}
