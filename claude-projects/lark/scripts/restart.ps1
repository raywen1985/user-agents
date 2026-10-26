$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RunDirectory = Join-Path $ProjectRoot 'run'
$MarkerPath = Join-Path $RunDirectory 'restart-request.json'
$HealthPath = Join-Path $RunDirectory 'health.json'
$PidPath = Join-Path $RunDirectory 'gateway.pid'
$TaskName = 'LarkClaudeGateway'
$RequestedAt = [DateTime]::UtcNow.ToString('o')
$Nonce = [Guid]::NewGuid().ToString('N')
$TemporaryMarker = Join-Path $RunDirectory ('.restart-request-{0}.tmp' -f $Nonce)

New-Item -ItemType Directory -Path $RunDirectory -Force | Out-Null
if (-not (Test-Path -LiteralPath $PidPath)) { throw 'Gateway PID file was not found.' }
$OldPid = [int](Get-Content -Raw -LiteralPath $PidPath)
if ($OldPid -le 0 -or $null -eq (Get-Process -Id $OldPid -ErrorAction SilentlyContinue)) {
    throw 'Gateway process is not running.'
}
$Request = @{ requestedAt = $RequestedAt; nonce = $Nonce } | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText($TemporaryMarker, $Request, [System.Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $TemporaryMarker -Destination $MarkerPath -Force

$Deadline = [DateTime]::UtcNow.AddSeconds(45)
try {
    while ([DateTime]::UtcNow -lt $Deadline) {
        Start-Sleep -Milliseconds 500
        if (-not (Test-Path -LiteralPath $HealthPath)) { continue }
        try { $Health = Get-Content -Raw -LiteralPath $HealthPath | ConvertFrom-Json } catch { continue }
        if ($Health.restartDeferred -eq $true -and $Health.restartRequestedAt -eq $RequestedAt) {
            throw 'Gateway has active, waiting, or queued work. Restart was deferred without interrupting it.'
        }
        if ($Health.restartReady -ne $true -or $Health.restartRequestedAt -ne $RequestedAt) { continue }
        if ($null -ne (Get-Process -Id $OldPid -ErrorAction SilentlyContinue)) { continue }
        Remove-Item -LiteralPath $MarkerPath -Force -ErrorAction SilentlyContinue
        Start-ScheduledTask -TaskName $TaskName
        Write-Output "Gateway restart activated through scheduled task $TaskName."
        exit 0
    }
    throw 'Timed out waiting for the Gateway restart handshake.'
} finally {
    Remove-Item -LiteralPath $TemporaryMarker -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $MarkerPath) {
        try {
            $Current = Get-Content -Raw -LiteralPath $MarkerPath | ConvertFrom-Json
            if ($Current.nonce -eq $Nonce) { Remove-Item -LiteralPath $MarkerPath -Force -ErrorAction SilentlyContinue }
        } catch {
            Remove-Item -LiteralPath $MarkerPath -Force -ErrorAction SilentlyContinue
        }
    }
}
