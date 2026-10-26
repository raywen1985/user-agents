$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LocalConfigPath = Join-Path $ProjectRoot 'config\gateway.local.json'
if (-not (Test-Path -LiteralPath $LocalConfigPath -PathType Leaf)) {
    throw 'Local gateway configuration is missing. Run scripts/install-task.ps1 first.'
}
$Config = Get-Content -Raw -LiteralPath $LocalConfigPath | ConvertFrom-Json
$Node = [string]$Config.executables.node
if ([string]::IsNullOrWhiteSpace($Node)) { throw 'Local Node path is missing. Run scripts/install-task.ps1 first.' }
if (-not [System.IO.Path]::IsPathRooted($Node)) { $Node = Join-Path $ProjectRoot $Node }
$Node = (Resolve-Path -LiteralPath $Node -ErrorAction Stop).Path
$Item = Get-Item -LiteralPath $Node -Force
if ($Item.PSIsContainer -or $Item.Extension -ine '.exe') { throw "Local Node path is not an executable file: $Node" }
for ($CurrentPath = $Node; -not [string]::IsNullOrWhiteSpace($CurrentPath); $CurrentPath = Split-Path -Parent $CurrentPath) {
    $Current = Get-Item -LiteralPath $CurrentPath -Force
    if (($Current.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Local Node path crosses a reparse point: $($Current.FullName)"
    }
    $ParentPath = Split-Path -Parent $CurrentPath
    if ([string]::IsNullOrWhiteSpace($ParentPath) -or $ParentPath -eq $CurrentPath) { break }
}
$Entry = Join-Path $ProjectRoot 'src\gateway.mjs'
$Arguments = @($Entry)
$Generation = [string]$Config.installationGeneration
if (-not [string]::IsNullOrWhiteSpace($Generation)) {
    if ($Generation -notmatch '^[a-fA-F0-9]{32}$') { throw 'Local installation generation is invalid.' }
    $Arguments += @('--installation-generation', $Generation)
}
& $Node @Arguments
exit $LASTEXITCODE
