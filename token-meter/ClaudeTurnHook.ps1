$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Import-Module (Join-Path $PSScriptRoot 'TokenMeter.psm1') -Force
try {
    $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $record = Get-ClaudeTurnRecord $payload
    $result = Save-TMTurnRecord $record
    $paths = Initialize-TMDataDirectory
    Write-TMAtomicJson (Join-Path $paths.DataRoot 'hook-invoked-claude.json') ([ordered]@{cli='claude';state='hook_invoked';timestamp=[DateTimeOffset]::Now.ToString('o')})
    $message = Format-TMTurnSummary $result.Record
    [Console]::Out.WriteLine(([ordered]@{systemMessage=$message} | ConvertTo-Json -Compress))
}
catch {
    Write-TMError 'claude-hook' $_.Exception.Message
    [Console]::Out.WriteLine(([ordered]@{systemMessage='[UNAVAILABLE] Claude | token meter could not parse this turn'} | ConvertTo-Json -Compress))
}
exit 0
