$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PidFile = Join-Path $ProjectRoot 'run\gateway.pid'
if (-not (Test-Path -LiteralPath $PidFile)) {
    Write-Output 'Gateway is not running.'
    exit 0
}
$GatewayPid = [int](Get-Content -Raw -LiteralPath $PidFile)
$Process = Get-Process -Id $GatewayPid -ErrorAction SilentlyContinue
if ($null -ne $Process) {
    Stop-Process -Id $GatewayPid
    $Process.WaitForExit(10000)
}
Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
Write-Output "Gateway stopped (PID=$GatewayPid)."
