$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Import-Module (Join-Path $PSScriptRoot 'TokenMeter.psm1') -Force
try {
    $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $deadline = [DateTime]::UtcNow.AddMilliseconds(1500)
    do {
        $record = Get-CodexTurnRecord $payload
        if ($record.quality -ne 'UNAVAILABLE') { break }
        Start-Sleep -Milliseconds 75
    } while ([DateTime]::UtcNow -lt $deadline)
    $result = Save-TMTurnRecord $record
    $paths = Initialize-TMDataDirectory
    Write-TMAtomicJson (Join-Path $paths.DataRoot 'hook-invoked-codex.json') ([ordered]@{cli='codex';state='hook_invoked';timestamp=[DateTimeOffset]::Now.ToString('o')})
    $message = Format-TMTurnSummary $result.Record
    [Console]::Out.WriteLine(([ordered]@{systemMessage=$message} | ConvertTo-Json -Compress))
}
catch {
    Write-TMError 'codex-hook' $_.Exception.Message
    [Console]::Out.WriteLine(([ordered]@{systemMessage='[UNAVAILABLE] Codex | token meter could not parse this turn'} | ConvertTo-Json -Compress))
}
exit 0
