[CmdletBinding(SupportsShouldProcess=$true)]
param([switch]$CodexOnly)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'TokenMeter.psm1') -Force
$profile = [Environment]::GetFolderPath('UserProfile')
$sessions = Join-Path $profile '.codex\sessions'
$added = 0; $duplicate = 0; $failed = 0
if (Test-Path -LiteralPath $sessions) {
    foreach ($file in Get-ChildItem -LiteralPath $sessions -Recurse -Filter '*.jsonl' -File -ErrorAction SilentlyContinue) {
        $rows = @(Read-TMJsonLines $file.FullName -ContainsAny @('"type":"session_meta"', '"type": "session_meta"', '"type":"token_usage_record"', '"type": "token_usage_record"'))
        $meta = $rows | Where-Object { [string](Get-TMProperty $_.Object 'type') -eq 'session_meta' } | Select-Object -First 1
        if($null -eq $meta){continue}
        $metaPayload=Get-TMProperty $meta.Object 'payload'
        if(-not (Test-TMCodexSessionEligible $metaPayload)){continue}
        $sessionId = [string](Get-TMProperty $metaPayload 'id')
        if ([string]::IsNullOrWhiteSpace($sessionId)) { continue }
        $turnIds = @($rows | Where-Object { [string](Get-TMProperty $_.Object 'type') -eq 'token_usage_record' } | ForEach-Object { [string](Get-TMProperty (Get-TMProperty $_.Object 'payload') 'turn_id') } | Where-Object { $_ } | Sort-Object -Unique)
        foreach ($turnId in $turnIds) {
            try {
                $payload = [pscustomobject]@{session_id=$sessionId;turn_id=$turnId;transcript_path=$file.FullName}
                $record = Get-CodexTurnRecord $payload
                if ($PSCmdlet.ShouldProcess("$sessionId/$turnId", 'Append repaired token revision')) {
                    $result = Save-TMTurnRecord $record
                    if ($result.Action -eq 'appended') { $added++ } else { $duplicate++ }
                }
            }
            catch { $failed++; Write-TMError 'repair-codex' $_.Exception.Message }
        }
    }
}
[pscustomobject]@{Added=$added;AlreadyPresent=$duplicate;Failed=$failed} | Format-List
