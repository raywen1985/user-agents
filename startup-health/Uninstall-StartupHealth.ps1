[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param([string]$StateRoot, [string]$UserHome, [switch]$Force)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($Force) { $ConfirmPreference = 'None' }
Import-Module (Join-Path $PSScriptRoot 'StartupHealth.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'StartupHealthInstaller.psm1') -Force

if ([string]::IsNullOrWhiteSpace($UserHome)) {
    $UserHome = [Environment]::GetFolderPath('UserProfile')
    if ([string]::IsNullOrWhiteSpace($UserHome)) { $UserHome = $env:USERPROFILE }
}
if ([string]::IsNullOrWhiteSpace($StateRoot)) {
    $localData = [Environment]::GetFolderPath('LocalApplicationData')
    if ([string]::IsNullOrWhiteSpace($localData)) { $localData = $env:LOCALAPPDATA }
    $StateRoot = Get-SHStateRoot $localData
}
$manifestPath = Join-Path $StateRoot 'install-manifest.json'
$manifest = Read-SHStateJson $manifestPath
if ($null -eq $manifest -or -not [bool]$manifest.installed) { throw 'Startup health is not installed.' }
if (-not $PSCmdlet.ShouldProcess('AIStartupHealthV1 hooks in Claude and Codex user configuration', 'Remove owned hooks and retain audit state')) { exit 0 }

$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$stagingRoot = Join-Path ([IO.Path]::GetTempPath()) ('startup-health-uninstall-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($stagingRoot) | Out-Null
try {
    $targets = [Collections.Generic.List[object]]::new()
    foreach ($hookKey in @('claude', 'codex')) {
        $hook = $manifest.hooks.PSObject.Properties[$hookKey].Value
        $configPath = [string]$hook.configPath
        $projection = Get-SHHookProjection $configPath
        if ($projection.Sha256 -ne [string]$hook.projectionSha256) { throw "Owned $hookKey hook drifted; refusing to remove a non-matching definition." }
        $candidatePath = Join-Path $stagingRoot ($hookKey + '-candidate.json')
        $summary = Invoke-SHConfigEditor -NodePath ([string]$node) -Action remove -InputPath $configPath -OutputPath $candidatePath -FrameworkRoot $PSScriptRoot
        if ([int]$summary.ownedHookCount -ne 0) { throw "Owned $hookKey hook remains in the uninstall candidate." }
        $targets.Add([pscustomobject]@{ configPath = $configPath; candidatePath = $candidatePath; sourceStamp = Get-SHFileStamp $configPath })
    }
    $uninstalledManifest = [ordered]@{}
    foreach ($property in @($manifest.PSObject.Properties)) { $uninstalledManifest[$property.Name] = $property.Value }
    $uninstalledManifest.installed = $false
    $uninstalledManifest.uninstalledAt = [DateTimeOffset]::UtcNow.ToString('O')
    $result = Install-SHHookTransaction -Targets @($targets) -StateRoot $StateRoot -Manifest $uninstalledManifest
    [ordered]@{
        uninstalled = $result.Installed
        retained = @('install-manifest.json', 'activation.json', 'start-attempts.json', 'last-notified.json', 'disabled', 'latest.json', 'runner.log')
    } | ConvertTo-Json -Compress
} finally {
    if ($stagingRoot.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $stagingRoot)) {
        Remove-Item -LiteralPath $stagingRoot -Recurse -Force
    }
}
