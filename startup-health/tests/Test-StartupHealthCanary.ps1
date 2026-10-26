[CmdletBinding()]
param([string]$InventoryPath, [string]$DesktopAppAsarPath)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$frameworkRoot = Split-Path -Parent $PSScriptRoot
Import-Module (Join-Path $frameworkRoot 'StartupHealth.psm1') -Force
$installer = Join-Path $frameworkRoot 'Install-StartupHealth.ps1'
$arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installer, '-Mode', 'Preflight')
if (-not [string]::IsNullOrWhiteSpace($InventoryPath)) { $arguments += @('-InventoryPath', $InventoryPath) }
if (-not [string]::IsNullOrWhiteSpace($DesktopAppAsarPath)) { $arguments += @('-DesktopAppAsarPath', $DesktopAppAsarPath) }
$powershell = [string](Get-Command powershell.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$process = Invoke-SHIsolatedProcess -Executable $powershell -Arguments $arguments -WorkingDirectory (Split-Path -Parent $frameworkRoot) -TimeoutMilliseconds 30000 -MaximumBytes 131072
if ($process.TimedOut -or $process.ExitCode -ne 0) { throw "Startup-health preflight failed: $($process.Stderr)" }
$report = ([string]$process.Stdout).Trim() | ConvertFrom-Json
[ordered]@{
    schemaVersion = 1
    readOnly = $true
    readyForInstall = [bool]$report.approved
    matrixVersion = [string]$report.matrixVersion
    runtimes = @($report.runtimes)
    blockers = @($report.issues)
} | ConvertTo-Json -Depth 10
