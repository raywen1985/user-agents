$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Config = Get-Content -Raw (Join-Path $ProjectRoot 'config\gateway.json') | ConvertFrom-Json
$Node = $Config.executables.node
$Entry = Join-Path $ProjectRoot 'src\gateway.mjs'
& $Node $Entry
exit $LASTEXITCODE
