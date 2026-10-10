[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$notifyScript = Join-Path $PSScriptRoot "lark-notify.ps1"
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("lark-notify-tests-" + [guid]::NewGuid().ToString("N"))
$testUserProfile = Join-Path $testRoot "user"
$testLocalAppData = Join-Path $testRoot "local"
$originalUserProfile = $env:USERPROFILE
$originalCodexHome = $env:CODEX_HOME
$originalLocalAppData = $env:LOCALAPPDATA
$assertionCount = 0

function Assert-Contains
{
    param(
        [string]$Actual,
        [string]$Expected,
        [string]$Case
    )

    $script:assertionCount++
    if (-not $Actual.Contains($Expected))
    {
        throw "$Case failed. Expected '$Expected' in: $Actual"
    }
}

function Assert-Equals
{
    param(
        [string]$Actual,
        [string]$Expected,
        [string]$Case
    )

    $script:assertionCount++
    if ($Actual -ne $Expected)
    {
        throw "$Case failed. Expected '$Expected', got '$Actual'."
    }
}

function New-CodexHome
{
    param([string]$Name)

    $path = Join-Path $testRoot $Name
    [System.IO.Directory]::CreateDirectory($path) | Out-Null
    return $path
}

function New-SessionTranscript
{
    param(
        [string]$CodexHome,
        [string]$SessionId
    )

    $sessionsDirectory = Join-Path $CodexHome "sessions\2026\10\09"
    [System.IO.Directory]::CreateDirectory($sessionsDirectory) | Out-Null
    $path = Join-Path $sessionsDirectory "rollout-2026-10-09T10-00-00-$SessionId.jsonl"
    Set-Content -LiteralPath $path -Value "{}" -Encoding UTF8
    return $path
}

function Set-SessionIndex
{
    param(
        [string]$CodexHome,
        [string[]]$Lines
    )

    Set-Content -LiteralPath (Join-Path $CodexHome "session_index.jsonl") -Value $Lines -Encoding UTF8
}

function Invoke-NotifyDryRun
{
    param(
        [string]$Source,
        [hashtable]$Payload
    )

    $json = $Payload | ConvertTo-Json -Compress -Depth 10
    $output = $json | & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $notifyScript -Source $Source -DryRun 2>&1
    if ($LASTEXITCODE -ne 0)
    {
        throw "Hook exited with code ${LASTEXITCODE}: $($output -join [Environment]::NewLine)"
    }

    return ($output -join "`n").Trim()
}

function Get-NotifyLog
{
    $path = Join-Path $testLocalAppData "lark-notify\notify.log"
    if (-not (Test-Path -LiteralPath $path))
    {
        return ""
    }

    return Get-Content -Raw -LiteralPath $path
}

try
{
    [System.IO.Directory]::CreateDirectory((Join-Path $testUserProfile ".agents")) | Out-Null
    [System.IO.Directory]::CreateDirectory($testLocalAppData) | Out-Null
    @{
        identity = "bot"
        recipientOpenId = "ou_test"
        summaryLength = 300
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $testUserProfile ".agents\lark-notify.json") -Encoding UTF8

    $env:USERPROFILE = $testUserProfile
    $env:LOCALAPPDATA = $testLocalAppData

    $sessionId = "01a20000-0000-7000-8000-000000000001"
    $env:CODEX_HOME = New-CodexHome "transcript-home"
    $transcript = New-SessionTranscript -CodexHome $env:CODEX_HOME -SessionId $sessionId
    $result = Invoke-NotifyDryRun -Source codex -Payload @{
        hook_event_name = "Stop"
        session_id = $sessionId
        transcript_path = ([Uri]$transcript).AbsoluteUri
        cwd = "D:\WA\unity_asset"
        last_assistant_message = "Transcript test"
    }
    Assert-Contains $result "[Codex] Turn finished" "valid transcript"

    $sessionId = "01a20000-0000-7000-8000-000000000002"
    $env:CODEX_HOME = New-CodexHome "index-home"
    Set-SessionIndex -CodexHome $env:CODEX_HOME -Lines @(
        "{bad-json"
        (@{ id = $sessionId; thread_name = "Indexed session" } | ConvertTo-Json -Compress)
    )
    $result = Invoke-NotifyDryRun -Source codex -Payload @{
        hook_event_name = "Stop"
        session_id = $sessionId
        cwd = "D:\WA\unity_asset"
        last_assistant_message = "Index test"
    }
    Assert-Contains $result "Session: Indexed session" "index entry after invalid line"

    $env:CODEX_HOME = New-CodexHome "ambient-home"
    $result = Invoke-NotifyDryRun -Source codex -Payload @{
        hook_event_name = "Stop"
        session_id = "01a20000-0000-7000-8000-000000000003"
        cwd = "D:\WA\unity_asset"
        last_assistant_message = '{"suggestions":[]}'
    }
    Assert-Equals $result "{}" "unpersisted ambient turn"
    Assert-Contains (Get-NotifyLog) "reason=unpersisted-codex-session" "ambient skip reason"

    $env:CODEX_HOME = New-CodexHome "bin-home"
    $codexBin = Join-Path $testLocalAppData "OpenAI\Codex\bin"
    $result = Invoke-NotifyDryRun -Source codex -Payload @{
        hook_event_name = "Stop"
        session_id = "01a20000-0000-7000-8000-000000000004"
        cwd = (Join-Path $codexBin "build-hash").ToUpperInvariant()
        last_assistant_message = '{"exclude":[]}'
    }
    Assert-Equals $result "{}" "Codex bin turn"
    Assert-Contains (Get-NotifyLog) "reason=codex-internal-directory" "Codex bin skip reason"

    $sessionId = "01a20000-0000-7000-8000-000000000005"
    Set-SessionIndex -CodexHome $env:CODEX_HOME -Lines @(
        @{ id = $sessionId; thread_name = "Persisted bin session" } | ConvertTo-Json -Compress
    )
    $result = Invoke-NotifyDryRun -Source codex -Payload @{
        hook_event_name = "Stop"
        session_id = $sessionId
        cwd = $codexBin
        last_assistant_message = "Persisted bin test"
    }
    Assert-Contains $result "Session: Persisted bin session" "persisted session in Codex bin"

    $env:CODEX_HOME = New-CodexHome "empty-session-home"
    $result = Invoke-NotifyDryRun -Source codex -Payload @{
        hook_event_name = "Stop"
        session_id = ""
        cwd = "D:\WA\unity_asset"
        last_assistant_message = "Empty id"
    }
    Assert-Equals $result "{}" "empty session id"

    $env:CODEX_HOME = New-CodexHome "similar-prefix-home"
    $result = Invoke-NotifyDryRun -Source codex -Payload @{
        hook_event_name = "Stop"
        session_id = "01a20000-0000-7000-8000-000000000006"
        cwd = (Join-Path $testLocalAppData "OpenAI\Codex\binary")
        last_assistant_message = "Similar prefix"
    }
    Assert-Equals $result "{}" "similar Codex bin prefix"
    Assert-Contains (Get-NotifyLog) "reason=unpersisted-codex-session" "similar prefix skip reason"

    $sessionId = "01a20000-0000-7000-8000-000000000007"
    $env:CODEX_HOME = New-CodexHome "locked-index-home"
    $transcript = New-SessionTranscript -CodexHome $env:CODEX_HOME -SessionId $sessionId
    $indexPath = Join-Path $env:CODEX_HOME "session_index.jsonl"
    Set-Content -LiteralPath $indexPath -Value "{}" -Encoding UTF8
    $lock = [System.IO.File]::Open($indexPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    try
    {
        $result = Invoke-NotifyDryRun -Source codex -Payload @{
            hook_event_name = "Stop"
            session_id = $sessionId
            transcript_path = $transcript
            cwd = "D:\WA\unity_asset"
            last_assistant_message = "Locked index with transcript"
        }
        Assert-Contains $result "[Codex] Turn finished" "locked index with valid transcript"

        $result = Invoke-NotifyDryRun -Source codex -Payload @{
            hook_event_name = "Stop"
            session_id = "01a20000-0000-7000-8000-000000000008"
            cwd = "D:\WA\unity_asset"
            last_assistant_message = "Locked index without transcript"
        }
        Assert-Equals $result "{}" "locked index without transcript"
        Assert-Contains (Get-NotifyLog) "reason=session-index-read-failed" "locked index skip reason"
    }
    finally
    {
        $lock.Dispose()
    }

    $sessionId = "01a20000-0000-7000-8000-000000000009"
    $env:CODEX_HOME = New-CodexHome "failure-home"
    Set-SessionIndex -CodexHome $env:CODEX_HOME -Lines @(
        @{ id = $sessionId; thread_name = "Failed turn" } | ConvertTo-Json -Compress
    )
    $result = Invoke-NotifyDryRun -Source codex -Payload @{
        hook_event_name = "StopFailure"
        session_id = $sessionId
        cwd = "D:\WA\unity_asset"
        last_assistant_message = "Failure test"
    }
    Assert-Contains $result "[Codex] Turn failed" "persisted StopFailure"

    $result = Invoke-NotifyDryRun -Source claude -Payload @{
        hook_event_name = "Stop"
        session_id = "claude-test"
        cwd = "D:\WA\unity_asset"
        last_assistant_message = "Claude stop test"
    }
    Assert-Contains $result "[Claude Code] Turn finished" "Claude Stop unchanged"

    $result = Invoke-NotifyDryRun -Source claude -Payload @{
        hook_event_name = "Notification"
        notification_type = "permission_prompt"
        session_id = "claude-test"
        cwd = "D:\WA\unity_asset"
        message = "Claude permission test"
    }
    Assert-Contains $result "[Claude Code] Needs your attention" "Claude notification unchanged"

    Write-Host "PASS: $assertionCount assertions"
}
finally
{
    $env:USERPROFILE = $originalUserProfile
    $env:CODEX_HOME = $originalCodexHome
    $env:LOCALAPPDATA = $originalLocalAppData

    if (Test-Path -LiteralPath $testRoot)
    {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
