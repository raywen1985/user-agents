[CmdletBinding()]
param([ValidateSet('Check')][string]$Action = 'Check', [Parameter(Mandatory = $true)][string]$ContextPath)

$ErrorActionPreference = 'Stop'
$context = Get-Content -Raw -LiteralPath $ContextPath | ConvertFrom-Json
$surface = [string]$context.surface
if ($surface -notin @('claude', 'codex', 'desktop')) { throw 'Model proxy context surface is invalid.' }
$endpoint = [string]$context.modelProxy.endpoint
$reachable = $false; $loopback = $false
if ([string]::IsNullOrWhiteSpace($endpoint)) { $status = 'warn'; $reason = 'model-proxy-unconfigured' }
else {
    try {
        $uri = [Uri]$endpoint
        $addresses = @([Net.Dns]::GetHostAddresses($uri.DnsSafeHost))
        $loopback = $addresses.Count -gt 0 -and @($addresses | Where-Object { -not [Net.IPAddress]::IsLoopback($_) }).Count -eq 0
        if (-not $loopback) { $status = 'warn'; $reason = 'model-proxy-not-loopback' }
        else {
            $port = if ($uri.Port -gt 0) { $uri.Port } elseif ($uri.Scheme -eq 'https') { 443 } else { 80 }
            $perAddressMilliseconds = 250
            foreach ($address in $addresses) {
                $client = [Net.Sockets.TcpClient]::new()
                try {
                    $pending = $client.BeginConnect($address, $port, $null, $null)
                    if ($pending.AsyncWaitHandle.WaitOne($perAddressMilliseconds)) {
                        $client.EndConnect($pending)
                        if ($client.Connected) { $reachable = $true; break }
                    }
                } catch { } finally { $client.Dispose() }
            }
            if ($reachable) { $status = 'ok'; $reason = 'model-proxy-ready' }
            else { $status = 'warn'; $reason = 'model-proxy-unreachable' }
        }
    } catch { $status = 'warn'; $reason = 'model-proxy-unreachable' }
}
[ordered]@{
    schemaVersion = 1; id = 'model-proxy'; surface = $surface; status = $status; reasonCode = $reason
    guidanceId = if ($status -eq 'ok') { $null } else { 'review-model-proxy' }
    startEligibility = 'not-needed'; dependencyReady = ($status -eq 'ok')
    facts = [ordered]@{ configured = -not [string]::IsNullOrWhiteSpace($endpoint); loopback = $loopback; reachable = $reachable }
} | ConvertTo-Json -Compress
