[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$bridgeScript = Join-Path $PSScriptRoot "Invoke-CodexNotifyBridge.ps1"
. $bridgeScript

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("codex-notify-bridge-tests-" + [guid]::NewGuid().ToString("N"))
$profile = Join-Path $testRoot "user"
$local = Join-Path $testRoot "local"
$codexHome = Join-Path $profile ".codex"
$assertions = 0

function Assert-True
{
    param([bool]$Condition, [string]$Case)
    $script:assertions++
    if (-not $Condition) { throw "$Case failed." }
}

function Assert-Equals
{
    param([object]$Actual, [object]$Expected, [string]$Case)
    $script:assertions++
    if ([string]$Actual -cne [string]$Expected) { throw "$Case failed. Expected '$Expected', got '$Actual'." }
}

try
{
    [IO.Directory]::CreateDirectory($codexHome) | Out-Null
    [IO.Directory]::CreateDirectory((Join-Path $profile ".agents\hooks")) | Out-Null
    [IO.Directory]::CreateDirectory((Join-Path $local "lark-notify")) | Out-Null
    $capturePath = Join-Path $testRoot "captured.json"
    $fakeLark = Join-Path $profile ".agents\hooks\lark-notify.ps1"
    @'
param([string]$Source)
$value = [Console]::In.ReadToEnd()
[IO.File]::WriteAllText($env:CNB_CAPTURE_PATH, $value, [Text.UTF8Encoding]::new($false))
exit 0
'@ | Set-Content -LiteralPath $fakeLark -Encoding UTF8
    $env:CNB_CAPTURE_PATH = $capturePath

    $nativePath = Join-Path $local "OpenAI\Codex\runtimes\cua_node\test\bin\node_modules\@oai\sky\bin\windows\codex-computer-use.exe"
    [IO.Directory]::CreateDirectory((Split-Path -Parent $nativePath)) | Out-Null
    Copy-Item -LiteralPath "$env:SystemRoot\System32\where.exe" -Destination $nativePath
    [pscustomobject]@{ command = @($nativePath, "turn-ended") } |
        ConvertTo-Json -Depth 5 |
        Set-Content -LiteralPath (Join-Path $local "lark-notify\codex-native-notify.json") -Encoding UTF8

    $threadId = "01a-test-thread"
    $turnId = "01a-test-turn"
    [pscustomobject]@{ id = $threadId; thread_name = "Bridge test" } |
        ConvertTo-Json -Compress |
        Set-Content -LiteralPath (Join-Path $codexHome "session_index.jsonl") -Encoding UTF8
    $payload = [pscustomobject][ordered]@{
        type = "agent-turn-complete"
        'thread-id' = $threadId
        'turn-id' = $turnId
        cwd = "C:\work\demo"
        'input-messages' = @("secret user input")
        'last-assistant-message' = "Completed the repair"
    } | ConvertTo-Json -Compress

    $dry = Invoke-CodexNotifyBridge -PayloadJson $payload -UserProfilePath $profile -LocalAppDataPath $local -DryRun
    Assert-True (-not $dry.Skipped) "persisted event accepted"
    Assert-Equals $dry.Evidence "session-index" "session evidence"
    Assert-Equals $dry.LarkPayload.hook_event_name "Stop" "event converted"
    Assert-Equals $dry.LarkPayload.session_id $threadId "thread converted"
    Assert-Equals $dry.LarkPayload.turn_id $turnId "turn converted"
    Assert-Equals $dry.LarkPayload.lark_ingress "codex-notify" "ingress marked"
    Assert-Equals $dry.LarkPayload.last_assistant_message "Completed the repair" "summary converted"
    Assert-Equals $dry.NativeCommand[0] $nativePath "native command loaded"

    $live = Invoke-CodexNotifyBridge -PayloadJson $payload -UserProfilePath $profile -LocalAppDataPath $local
    Assert-Equals $live.Native "Failed" "native failure isolated"
    Assert-Equals $live.Lark "Completed" "lark branch completes"
    Assert-True (Test-Path -LiteralPath $capturePath) "lark payload captured"
    $captured = Get-Content -Raw -LiteralPath $capturePath | ConvertFrom-Json
    Assert-Equals $captured.session_id $threadId "live thread converted"
    Assert-Equals $captured.lark_ingress "codex-notify" "live ingress converted"

    $invalid = Invoke-CodexNotifyBridge -PayloadJson "{broken" -UserProfilePath $profile -LocalAppDataPath $local -DryRun
    Assert-Equals $invalid.Reason "invalid-json" "invalid JSON skipped"
    $unsupportedPayload = $payload | ConvertFrom-Json
    $unsupportedPayload.type = "other-event"
    $unsupported = Invoke-CodexNotifyBridge -PayloadJson ($unsupportedPayload | ConvertTo-Json -Compress) -UserProfilePath $profile -LocalAppDataPath $local -DryRun
    Assert-Equals $unsupported.Reason "unsupported-event" "unsupported event skipped"

    $missingPayload = $payload | ConvertFrom-Json
    $missingPayload.'thread-id' = "missing-thread"
    $missing = Invoke-CodexNotifyBridge -PayloadJson ($missingPayload | ConvertTo-Json -Compress) -UserProfilePath $profile -LocalAppDataPath $local -DryRun
    Assert-Equals $missing.Reason "unpersisted-codex-session" "unpersisted event skipped"

    $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
    $blocked = Start-CNBProcess -FilePath $powershell -Arguments @("-NoProfile", "-Command", "Start-Sleep -Seconds 10") -StandardInput ""
    $timeout = Complete-CNBProcess $blocked 1
    Assert-Equals $timeout.State "TimedOut" "blocked subprocess times out"

    $log = Get-Content -Raw -LiteralPath (Join-Path $local "lark-notify\notify.log")
    Assert-True (-not $log.Contains("secret user input")) "log excludes user input"
    Assert-True (-not $log.Contains("Completed the repair")) "log excludes assistant message"

    Write-Host "PASS: $assertions assertions"
}
finally
{
    Remove-Item Env:CNB_CAPTURE_PATH -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
