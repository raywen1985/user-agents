$ErrorActionPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Import-Module (Join-Path $PSScriptRoot 'TokenMeter.psm1') -Force
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$sessionId = [string](Get-TMProperty $payload 'session_id')
$context = Get-TMProperty $payload 'context_window'
$percent = Get-TMProperty $context 'used_percentage'
$parts = @('Token')
if ($null -ne $percent) { $parts += ('ctx {0:n0}%' -f [double]$percent) }
$current = Get-TMProperty $context 'current_usage'
if ($null -ne $current) {
    $parts += ('last-call in {0:n0}+cacheR {1:n0}+cacheW {2:n0} out {3:n0}' -f [int64](Get-TMProperty $current 'input_tokens'),[int64](Get-TMProperty $current 'cache_read_input_tokens'),[int64](Get-TMProperty $current 'cache_creation_input_tokens'),[int64](Get-TMProperty $current 'output_tokens'))
}
if (-not [string]::IsNullOrWhiteSpace($sessionId)) {
    $paths = Get-TMPaths
    $latestPath = Join-Path (Join-Path $paths.Latest 'claude') (((Get-TMHash $sessionId).Substring(0,32)) + '.json')
    if (Test-Path -LiteralPath $latestPath) {
        try { $parts += (Format-TMTurnSummary (Get-Content -Raw $latestPath | ConvertFrom-Json) -Compact) } catch { }
    }
}
[Console]::Out.WriteLine($parts -join ' | ')
