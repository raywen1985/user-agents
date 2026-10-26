[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('AIStartupHealthV1')][string]$Owner,
    [string]$StateRoot,
    [string]$ManifestPath
)

$ErrorActionPreference = 'Stop'
$exitCode = 0
try {
    if ([string]::IsNullOrWhiteSpace($StateRoot)) {
        $local = [Environment]::GetFolderPath('LocalApplicationData')
        if ([string]::IsNullOrWhiteSpace($local)) { exit 0 }
        $StateRoot = Join-Path $local 'ai-startup-health'
    }
    if (Test-Path -LiteralPath (Join-Path $StateRoot 'disabled') -PathType Leaf) { exit 0 }
    if ([string]::IsNullOrWhiteSpace($ManifestPath)) { $ManifestPath = Join-Path $StateRoot 'install-manifest.json' }
    $manifestItem = Get-Item -LiteralPath $ManifestPath -ErrorAction Stop
    if ($manifestItem.Length -gt 1048576) { throw 'Install manifest exceeds 1 MiB.' }
    Import-Module (Join-Path $PSScriptRoot 'StartupHealth.psm1') -Force
    $manifest = Get-Content -Raw -LiteralPath $ManifestPath | ConvertFrom-Json
    $nativePath = [string]$manifest.nativeAssembly.path
    if (-not (Test-Path -LiteralPath $nativePath -PathType Leaf) -or (Get-SHSha256 -Path $nativePath) -ne [string]$manifest.nativeAssembly.sha256) {
        throw 'Native helper identity mismatch.'
    }
    $null = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($nativePath))
    $ancestors = @([StartupHealth.RuntimeIdentity]::GetAncestors($PID, 12) | ForEach-Object { $_.ExecutablePath })
    $guard = Test-SHEntryGuardEvidence -Manifest $manifest -AncestorPaths $ancestors -OriginatorOverride $env:CODEX_INTERNAL_ORIGINATOR_OVERRIDE -MaximumMilliseconds 500
    if (-not $guard.Approved) {
        $reason = [string]$guard.Reason
        $notifyPath = Join-Path $StateRoot 'last-notified.json'
        $ledger = Read-SHStateJson $notifyPath
        if (Test-SHShouldNotifyGuard $ledger $reason) {
            try { Update-SHGuardNotification $ledger $reason $notifyPath } catch { }
            [Console]::Out.WriteLine((@{ systemMessage = "AI health: startup-health=warn($reason)" } | ConvertTo-Json -Compress))
        }
        exit 0
    }
    $runner = Get-Command Invoke-SHRunner -ErrorAction SilentlyContinue
    if ($null -ne $runner) { Invoke-SHRunner -Manifest $manifest -Surface $guard.Surface -StateRoot $StateRoot }
} catch {
    try { [Console]::Out.WriteLine((@{ systemMessage = 'AI health: startup-health=warn(compatibility-guard-failed)' } | ConvertTo-Json -Compress)) } catch { }
} finally {
    $global:LASTEXITCODE = 0
}
exit $exitCode
