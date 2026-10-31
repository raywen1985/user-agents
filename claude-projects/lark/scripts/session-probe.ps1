# Compatibility entry; resolve the shared helper from the repository layout.
$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "../../../skills/session-mgr/scripts/discovery/session-probe.ps1")
