[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Position=0, Mandatory)][ValidateSet('collect','diff','install','watch','check','recover')][string]$Mode,
    [ValidateSet('PreferLocal','PreferSource')][string]$ResolveConflict,
    [switch]$Rebaseline,
    [string]$TransactionId,
    [string]$UserHome,
    [string]$CodexRoot,
    [string]$TempRoot,
    [switch]$Once
)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$cliPath = Join-Path $PSScriptRoot 'tools\cli.mjs'
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'tools\node_modules\smol-toml\package.json'))) {
    throw 'Dependencies missing. Run npm ci --ignore-scripts --prefix ./config-sync/tools first.'
}
$arguments = @($cliPath, $Mode, '--agents-root', (Split-Path -Parent $PSScriptRoot))
if ($ResolveConflict) { $arguments += @('--resolve-conflict', $ResolveConflict) }
if ($Rebaseline) { $arguments += '--rebaseline' }
if ($TransactionId) { $arguments += @('--transaction-id', $TransactionId) }
if ($UserHome) { $arguments += @('--user-home', $UserHome) }
if ($CodexRoot) { $arguments += @('--codex-root', $CodexRoot) }
if ($TempRoot) { $arguments += @('--temp-root', $TempRoot) }
if ($Once) { $arguments += '--once' }
if ($WhatIfPreference) { $arguments += '--what-if' }
elseif ($Mode -notin @('diff','check') -and -not $PSCmdlet.ShouldProcess('agent configuration', $Mode)) { return }
& $node @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
