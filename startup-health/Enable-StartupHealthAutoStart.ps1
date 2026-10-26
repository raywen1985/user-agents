[CmdletBinding(SupportsShouldProcess = $true)]
param([string]$StateRoot)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'StartupHealth.psm1') -Force

if ([string]::IsNullOrWhiteSpace($StateRoot)) {
    $localData = [Environment]::GetFolderPath('LocalApplicationData')
    if ([string]::IsNullOrWhiteSpace($localData)) { $localData = $env:LOCALAPPDATA }
    $StateRoot = Get-SHStateRoot $localData
}
if (Test-Path -LiteralPath (Join-Path $StateRoot 'disabled') -PathType Leaf) { throw 'Startup health is disabled by the kill switch.' }

$mutex = Enter-SHMutex -WaitMilliseconds 10000
if (-not $mutex.Acquired) { throw 'Another startup-health runner or control command owns the mutex.' }
try {
    $manifestPath = Join-Path $StateRoot 'install-manifest.json'
    $manifest = Read-SHStateJson $manifestPath
    if ($null -eq $manifest -or [int]$manifest.schemaVersion -ne 1 -or -not [bool]$manifest.installed) { throw 'Startup health is not installed.' }
    $manifestSha = Get-SHSha256 -Path $manifestPath
    $registry = Read-SHRegistry ([string]$manifest.registry.path)
    if (-not (Test-SHManifestArtifacts $manifest $registry)) { throw 'Registry or provider identity drifted; reinstall startup health.' }
    if ((Get-SHSha256 -Path ([string]$manifest.nativeAssembly.path)) -ne [string]$manifest.nativeAssembly.sha256) { throw 'Native helper identity drifted.' }
    foreach ($runtime in @($manifest.runtimes)) {
        $actual = Get-SHFileIdentity ([string]$runtime.file.CanonicalPath) ([string]$manifest.nativeAssembly.path)
        if (-not (Test-SHFileIdentity $runtime.file $actual)) { throw "Runtime identity drifted: $($runtime.surface)" }
        if ([string]$runtime.surface -eq 'desktop') {
            $asarActual = Get-SHFileIdentity ([string]$runtime.appAsar.file.CanonicalPath) ([string]$manifest.nativeAssembly.path)
            if (-not (Test-SHFileIdentity $runtime.appAsar.file $asarActual)) { throw 'Codex desktop app identity drifted.' }
            $build = Read-SHAsarPackageVersionAt ([string]$runtime.appAsar.file.CanonicalPath) ([int64]$runtime.appAsar.dataOffset) ([int64]$runtime.appAsar.packageOffset) ([int64]$runtime.appAsar.packageSize)
            if ($build -ne [string]$runtime.appAsar.internalBuild) { throw 'Codex desktop internal build drifted.' }
        }
    }
    foreach ($hookKey in @('claude', 'codex')) {
        $hook = $manifest.hooks.PSObject.Properties[$hookKey].Value
        $projection = Get-SHHookProjection ([string]$hook.configPath)
        if ($projection.Sha256 -ne [string]$hook.projectionSha256) { throw "Owned $hookKey hook drifted." }
    }
    $activation = Read-SHStateJson (Join-Path $StateRoot 'activation.json')
    if (-not (Test-SHActivationComplete $activation $manifest $manifestSha)) { throw 'Warning-only canary evidence is incomplete or stale. Start or resume every installed surface first.' }
    $task = Get-SHGatewayTaskDefinition
    $installedTask = $manifest.taskPolicy.definition
    $expected = [pscustomobject]@{ execute = [string]$installedTask.actions[0].execute; arguments = [string]$installedTask.actions[0].arguments; workingDirectory = [string]$installedTask.actions[0].workingDirectory; userSid = [string]$installedTask.userSid }
    if ($null -eq $task -or -not (Test-SHGatewayTaskDefinition $task $expected)) { throw 'LarkClaudeGateway task definition drifted.' }
    $gatewaySource = Join-Path (Split-Path -Parent ([string]$manifest.frameworkRoot)) 'claude-projects\lark\src\gateway-health.mjs'
    if ((Get-Content -Raw -LiteralPath $gatewaySource) -notmatch '\bprocessStartedAt\b') { throw 'Gateway processStartedAt health contract is unavailable.' }
    if ($PSCmdlet.ShouldProcess((Join-Path $StateRoot 'mode.json'), 'Enable fixed-policy gateway auto-start')) {
        Write-SHAtomicJson (Join-Path $StateRoot 'mode.json') ([ordered]@{ schemaVersion = 1; autoStart = 'enabled'; generation = [string]$manifest.generation; enabledAt = [DateTimeOffset]::UtcNow.ToString('O') })
    }
    [ordered]@{ enabled = $true; generation = [string]$manifest.generation; policy = 'lark-gateway-task-v1' } | ConvertTo-Json -Compress
} finally { Exit-SHMutex $mutex }
