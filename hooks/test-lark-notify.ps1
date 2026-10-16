[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$notifyScript = Join-Path $PSScriptRoot "lark-notify.ps1"
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("lark-notify-tests-" + [guid]::NewGuid().ToString("N"))
$testUserProfile = Join-Path $testRoot "user"
$testLocalAppData = Join-Path $testRoot "local"
$testTokenData = Join-Path $testRoot "token-data"
$fakeCallsPath = Join-Path $testRoot "fake-calls.jsonl"
$originalEnvironment = @{
    USERPROFILE = $env:USERPROFILE
    CODEX_HOME = $env:CODEX_HOME
    LOCALAPPDATA = $env:LOCALAPPDATA
    TOKEN_METER_DATA_ROOT = $env:TOKEN_METER_DATA_ROOT
    TOKEN_METER_PRICE_TABLE_PATH = $env:TOKEN_METER_PRICE_TABLE_PATH
    LARK_NOTIFY_CLI_PATH = $env:LARK_NOTIFY_CLI_PATH
    LARK_NOTIFY_FAKE_CALLS = $env:LARK_NOTIFY_FAKE_CALLS
    LARK_NOTIFY_FAKE_MODE = $env:LARK_NOTIFY_FAKE_MODE
    LARK_GATEWAY_MANAGED = $env:LARK_GATEWAY_MANAGED
    HTTP_PROXY = $env:HTTP_PROXY
    HTTPS_PROXY = $env:HTTPS_PROXY
    ALL_PROXY = $env:ALL_PROXY
}
$assertionCount = 0

function Assert-True
{
    param([bool]$Condition, [string]$Case)

    $script:assertionCount++
    if (-not $Condition)
    {
        throw "$Case failed."
    }
}

function Assert-False
{
    param([bool]$Condition, [string]$Case)

    Assert-True -Condition (-not $Condition) -Case $Case
}

function Assert-Equals
{
    param([object]$Actual, [object]$Expected, [string]$Case)

    $script:assertionCount++
    if ([string]$Actual -cne [string]$Expected)
    {
        throw "$Case failed. Expected '$Expected', got '$Actual'."
    }
}

function Assert-NotEquals
{
    param([object]$Actual, [object]$Unexpected, [string]$Case)

    $script:assertionCount++
    if ([string]$Actual -ceq [string]$Unexpected)
    {
        throw "$Case failed. Did not expect '$Unexpected'."
    }
}

function Assert-Contains
{
    param([string]$Actual, [string]$Expected, [string]$Case)

    $script:assertionCount++
    if (-not $Actual.Contains($Expected))
    {
        throw "$Case failed. Expected '$Expected' in '$Actual'."
    }
}

function Assert-NotContains
{
    param([string]$Actual, [string]$Unexpected, [string]$Case)

    $script:assertionCount++
    if ($Actual.Contains($Unexpected))
    {
        throw "$Case failed. Did not expect '$Unexpected' in '$Actual'."
    }
}

function Assert-Matches
{
    param([string]$Actual, [string]$Pattern, [string]$Case)

    $script:assertionCount++
    if ($Actual -notmatch $Pattern)
    {
        throw "$Case failed. Expected '$Actual' to match '$Pattern'."
    }
}

function New-CodexHome
{
    param([string]$Name)

    $path = Join-Path $testRoot $Name
    [System.IO.Directory]::CreateDirectory($path) | Out-Null
    return $path
}

function Write-JsonLines
{
    param([string]$Path, [object[]]$Rows, [switch]$IncompleteTail)

    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
    $lines = @($Rows | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 20 })
    if ($IncompleteTail)
    {
        $lines += '{"incomplete":'
    }
    Set-Content -LiteralPath $Path -Value $lines -Encoding UTF8
}

function New-ClaudeTranscript
{
    param([string]$Name = "claude.jsonl", [switch]$IncompleteTail)

    $path = Join-Path $testRoot $Name
    $rows = @(
        [ordered]@{
            type = "user"; uuid = "old-turn"; timestamp = "2026-10-13T01:00:00Z"
            message = [ordered]@{ content = "Earlier request" }
        },
        [ordered]@{
            type = "assistant"; timestamp = "2026-10-13T01:00:05Z"
            message = [ordered]@{ id = "old-message"; content = @([ordered]@{ type = "text"; text = "Earlier response" }) }
        },
        [ordered]@{
            type = "user"; uuid = "claude-turn-42"; timestamp = "2026-10-13T02:00:00Z"
            message = [ordered]@{ content = "Implement the notification" }
        },
        [ordered]@{
            type = "assistant"; isSidechain = $true; timestamp = "2026-10-13T02:20:00Z"
            message = [ordered]@{ id = "sidechain"; content = @([ordered]@{ type = "text"; text = "Ignore me" }) }
        },
        [ordered]@{
            type = "assistant"; timestamp = "2026-10-13T02:04:43Z"
            message = [ordered]@{
                id = "claude-message-42"
                model = "deepseek-v4-1-flash"
                usage = [ordered]@{
                    input_tokens = 1000
                    cache_read_input_tokens = 9000
                    cache_creation_input_tokens = 0
                    output_tokens = 500
                }
                content = @([ordered]@{ type = "text"; text = "Implemented" })
            }
        },
        [ordered]@{ type = "custom-title"; customTitle = "Notification work" }
    )
    Write-JsonLines -Path $path -Rows $rows -IncompleteTail:$IncompleteTail
    return $path
}

function New-CodexTranscript
{
    param([string]$CodexHome, [string]$SessionId, [string]$TurnId = "turn-42", [switch]$IncompleteTail)

    $directory = Join-Path $CodexHome "sessions\2026\10\13"
    $path = Join-Path $directory "rollout-2026-10-13T10-00-00-$SessionId.jsonl"
    $rows = @(
        [ordered]@{
            type = "turn_context"; ordinal = 1; timestamp = "2026-10-13T03:00:00Z"
            payload = [ordered]@{ turn_id = $TurnId; model = "deepseek-v4-1-flash" }
        },
        [ordered]@{
            type = "event_msg"; ordinal = 2; timestamp = "2026-10-13T03:00:30Z"
            payload = [ordered]@{ turn_id = $TurnId; message = "working" }
        },
        [ordered]@{
            type = "token_usage_record"; ordinal = 3; timestamp = "2026-10-13T03:01:05Z"
            payload = [ordered]@{
                turn_id = $TurnId
                model = "deepseek-v4-1-flash"
                turn_token_usage = [ordered]@{
                    input_tokens = 20000
                    cached_input_tokens = 18000
                    cache_write_input_tokens = 0
                    output_tokens = 1000
                    reasoning_output_tokens = 200
                    total_tokens = 21000
                }
            }
        },
        [ordered]@{
            type = "event_msg"; ordinal = 4; timestamp = "2026-10-13T04:00:00Z"
            payload = [ordered]@{ turn_id = "another-turn"; message = "ignore" }
        }
    )
    Write-JsonLines -Path $path -Rows $rows -IncompleteTail:$IncompleteTail
    return $path
}

function Set-SessionIndex
{
    param([string]$CodexHome, [string[]]$Lines)

    Set-Content -LiteralPath (Join-Path $CodexHome "session_index.jsonl") -Value $Lines -Encoding UTF8
}

function Invoke-Notify
{
    param([string]$Source, [hashtable]$Payload, [switch]$DryRun)

    $json = $Payload | ConvertTo-Json -Compress -Depth 20
    $arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $notifyScript, "-Source", $Source)
    if ($DryRun)
    {
        $arguments += "-DryRun"
    }
    $output = $json | & powershell.exe @arguments 2>&1
    $exitCode = $LASTEXITCODE
    $text = ($output | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
    if ($exitCode -ne 0)
    {
        throw "Hook exited with code ${exitCode}: $text"
    }
    return $text.Trim()
}

function Invoke-NotifyDryRun
{
    param([string]$Source, [hashtable]$Payload)

    $text = Invoke-Notify -Source $Source -Payload $Payload -DryRun
    return $text | ConvertFrom-Json
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

function Reset-FakeCalls
{
    if (Test-Path -LiteralPath $fakeCallsPath)
    {
        Remove-Item -LiteralPath $fakeCallsPath -Force
    }
}

function Get-FakeCalls
{
    if (-not (Test-Path -LiteralPath $fakeCallsPath))
    {
        return @()
    }
    $calls = [System.Collections.Generic.List[object]]::new()
    foreach ($line in [System.IO.File]::ReadLines($fakeCallsPath))
    {
        $parsed = $line | ConvertFrom-Json
        $parsedValue = $parsed.PSObject.Properties["value"]
        $arguments = if ($null -eq $parsedValue) { @($parsed) } else { @($parsedValue.Value) }
        $proxyValuesProperty = $parsed.PSObject.Properties["proxyValues"]
        $proxyValues = if ($null -eq $proxyValuesProperty) { @() } else { @($proxyValuesProperty.Value) }
        $calls.Add([pscustomobject]@{
            Arguments = $arguments
            ProxyValues = $proxyValues
        })
    }
    return $calls.ToArray()
}

function Get-ArgumentValue
{
    param([object[]]$Arguments, [string]$Name)

    for ($index = 0; $index -lt $Arguments.Count - 1; $index++)
    {
        if ([string]$Arguments[$index] -ceq $Name)
        {
            return [string]$Arguments[$index + 1]
        }
    }
    return $null
}

try
{
    [System.IO.Directory]::CreateDirectory((Join-Path $testUserProfile ".agents")) | Out-Null
    [System.IO.Directory]::CreateDirectory($testLocalAppData) | Out-Null
    [System.IO.Directory]::CreateDirectory($testTokenData) | Out-Null
    @{
        identity = "bot"
        recipientOpenId = "ou_test"
        summaryLength = 300
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $testUserProfile ".agents\lark-notify.json") -Encoding UTF8

    $env:USERPROFILE = $testUserProfile
    $env:LOCALAPPDATA = $testLocalAppData
    $env:TOKEN_METER_DATA_ROOT = $testTokenData
    $env:TOKEN_METER_PRICE_TABLE_PATH = $null
    $env:LARK_GATEWAY_MANAGED = $null

    $fakeCli = Join-Path $testRoot "fake-lark-cli.ps1"
    @'
[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$RemainingArguments)

$proxyValues = @(
    $env:HTTP_PROXY, $env:HTTPS_PROXY, $env:ALL_PROXY,
    $env:http_proxy, $env:https_proxy, $env:all_proxy
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
$line = [ordered]@{
    value = @($RemainingArguments)
    proxyValues = @($proxyValues)
} | ConvertTo-Json -Compress
[IO.File]::AppendAllText($env:LARK_NOTIFY_FAKE_CALLS, $line + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
$count = @([IO.File]::ReadLines($env:LARK_NOTIFY_FAKE_CALLS)).Count
$mode = $env:LARK_NOTIFY_FAKE_MODE
if ($mode -eq "ambiguous")
{
    Write-Output "gateway timeout"
    $global:LASTEXITCODE = 1
}
elseif ($mode -eq "definitive_then_success" -and $count -eq 1)
{
    Write-Output '{"ok":false,"error":{"type":"validation","message":"card rejected"}}'
    $global:LASTEXITCODE = 2
}
elseif ($mode -eq "always_definitive")
{
    Write-Output '{"ok":false,"error":{"type":"api","message":"rejected"}}'
    $global:LASTEXITCODE = 1
}
elseif ($mode -eq "multiline_definitive")
{
    Write-Output '{'
    Write-Output '  "ok": false,'
    Write-Output '  "error": {'
    Write-Output '    "type": "validation",'
    Write-Output '    "message": "multiline rejection"'
    Write-Output '  }'
    Write-Output '}'
    $global:LASTEXITCODE = 2
}
elseif ($mode -eq "stderr_definitive_then_success" -and $count -eq 1)
{
    [Console]::Error.WriteLine('{')
    [Console]::Error.WriteLine('  "ok": false,')
    [Console]::Error.WriteLine('  "error": {')
    [Console]::Error.WriteLine('    "type": "validation",')
    [Console]::Error.WriteLine('    "message": "stderr rejection"')
    [Console]::Error.WriteLine('  }')
    [Console]::Error.WriteLine('}')
    $global:LASTEXITCODE = 2
}
else
{
    Write-Output '{"ok":true,"data":{"message_id":"om_test"}}'
    $global:LASTEXITCODE = 0
}
exit $global:LASTEXITCODE
'@ | Set-Content -LiteralPath $fakeCli -Encoding UTF8
    $env:LARK_NOTIFY_CLI_PATH = $fakeCli
    $env:LARK_NOTIFY_FAKE_CALLS = $fakeCallsPath

    # Load pure functions without running the hook body.
    . $notifyScript -Source claude

    $ordinary = Get-NotificationPresentation -Source claude -EventName Unknown -NotificationType ""
    Assert-Equals $ordinary.Template "default" "ordinary header is neutral"
    Assert-Equals $ordinary.TagColor "neutral" "ordinary tag is neutral"
    Assert-Equals (Format-Duration ([TimeSpan]::FromSeconds(42))) "42s" "duration seconds format"
    Assert-Equals (Format-Duration ([TimeSpan]::FromSeconds(283))) "4m43s" "duration minutes format"
    Assert-Equals (Format-Duration ([TimeSpan]::FromSeconds(5025))) "1h23m" "duration hours format"
    Assert-Equals `
        (Get-TruncatedTextElements -Text "一二三四五六七八九十甲乙丙" -Maximum 12) `
        "一二三四五六七八九十甲…" `
        "CJK project display truncation"
    Assert-Equals `
        (Get-TruncatedTextElements -Text "short-name" -Maximum 12) `
        "short-name" `
        "short project display preserved"
    Assert-Equals `
        (Get-TruncatedTextElements -Text "一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子" -Maximum 20) `
        "一二三四五六七八九十甲乙丙丁戊己庚辛壬…" `
        "CJK session display truncation"
    Assert-Equals (Get-CompletionSummary "已修复飞书通知。其余内容") "已修复飞书通知。" "recognized completion verb"
    Assert-Equals (Get-CompletionSummary "## 修复飞书通知。其余内容") "已完成：修复飞书通知。" "completion markdown and first sentence"
    Assert-Equals `
        (Get-CompletionSummary "已完成一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥天地玄黄宇宙") `
        "已完成一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥天地玄黄…" `
        "completion summary text element limit"

    foreach ($type in @("validation", "api", "authorization"))
    {
        $envelope = @{ ok = $false; error = @{ type = $type; message = "rejected" } } | ConvertTo-Json -Compress
        $classified = Get-CliEnvelopeResult -ExitCode 1 -OutputText $envelope
        Assert-Equals $classified.State "DefinitiveFailure" "definitive classifier $type"
    }
    foreach ($type in @("network", "transport", "unknown"))
    {
        $envelope = @{ ok = $false; error = @{ type = $type; message = "uncertain" } } | ConvertTo-Json -Compress
        $classified = Get-CliEnvelopeResult -ExitCode 1 -OutputText $envelope
        Assert-Equals $classified.State "AmbiguousFailure" "ambiguous classifier $type"
    }
    Assert-Equals (Get-CliEnvelopeResult -ExitCode 1 -OutputText "not-json").State "AmbiguousFailure" "malformed output classifier"
    Assert-Equals (Get-CliEnvelopeResult -ExitCode 1 -OutputText "").State "AmbiguousFailure" "empty output classifier"
    $multilineEnvelope = @'
{
  "ok": false,
  "error": {
    "type": "validation",
    "message": "multiline rejection"
  }
}
'@
    $multilineClassified = Get-CliEnvelopeResult -ExitCode 2 -OutputText $multilineEnvelope
    Assert-Equals $multilineClassified.State "DefinitiveFailure" "multiline JSON classifier"
    Assert-Equals $multilineClassified.Detail "validation: multiline rejection" "multiline JSON detail"

    $claudeTranscript = New-ClaudeTranscript -IncompleteTail
    $claudePayload = @{
        hook_event_name = "Stop"
        prompt_id = "prompt-shared"
        session_id = "claude-session"
        session_name = "Card work"
        transcript_path = ([Uri]$claudeTranscript).AbsoluteUri
        cwd = "D:\WA\unity_asset"
        last_assistant_message = "## Implemented card api_key=secret-value. Detailed validation passed."
    }
    $claude = Invoke-NotifyDryRun -Source claude -Payload $claudePayload
    Assert-False $claude.Skipped "Claude Stop is sent"
    Assert-Equals $claude.Card.schema "2.0" "Card 2.0 schema"
    Assert-Equals $claude.Card.config.width_mode "default" "default card width"
    Assert-Equals $claude.Card.header.title.content "Claude Code · 会话已完成" "Claude title"
    Assert-Equals $claude.Card.config.summary.content "Claude Code · 会话已完成" "Claude system summary"
    Assert-Equals $claude.Card.header.subtitle.content "unity_asset · Card work" "Claude subtitle order"
    Assert-Equals ($claude.Card.header.subtitle.content -split ' · ')[0] "unity_asset" "Claude subtitle starts with project"
    Assert-Equals $claude.Card.header.text_tag_list.Count 2 "status and time tag count"
    Assert-Equals $claude.Card.header.text_tag_list[0].text.content "完成" "status tag first"
    Assert-Equals $claude.Card.header.text_tag_list[0].color "green" "status tag color"
    Assert-Equals $claude.Card.header.text_tag_list[1].color "neutral" "time tag neutral"
    Assert-Matches $claude.Card.header.text_tag_list[1].text.content '^\d{2}:\d{2}$' "time tag format"
    Assert-NotContains $claude.Card.header.subtitle.content $claude.Card.header.text_tag_list[1].text.content "time excluded from subtitle"
    Assert-NotContains $claude.Card.body.elements[0].columns[0].elements[0].content "Claude Code" "summary label excludes source"
    Assert-Equals $claude.Card.header.template "green" "completion color"
    Assert-Equals $claude.Card.body.padding "8px 12px 12px 12px" "compact body padding"
    Assert-Equals $claude.Card.body.elements.Count 3 "three body blocks"
    Assert-Equals $claude.Card.body.elements[2].tag "collapsible_panel" "details panel"
    Assert-False $claude.Card.body.elements[2].expanded "details collapsed"
    Assert-Equals $claude.Statistics.Duration "4m43s" "Claude duration"
    Assert-Equals $claude.Statistics.TokenCount "10.5k" "Claude token count"
    Assert-Equals $claude.Statistics.CacheHitRate "90%" "Claude cache hit rate"
    Assert-NotEquals $claude.Statistics.Cost "--" "Claude estimated cost"
    Assert-Contains $claude.Statistics.Cost '$' "Claude USD cost"
    Assert-Contains $claude.Card.body.elements[0].columns[0].elements[1].text.content "已完成：Implemented" "completion summary prefix"
    Assert-Contains $claude.Card.body.elements[0].columns[0].elements[1].text.content "[REDACTED]" "summary redaction"
    Assert-NotContains ($claude | ConvertTo-Json -Depth 30) "请展开详细信息查看项目目录与会话上下文" "removed detail hint"

    $claudeDetailsJson = $claude.Card.body.elements[2].elements[0].fields | ConvertTo-Json -Depth 20
    Assert-Contains $claudeDetailsJson "完整结果" "completion details contain full result"
    Assert-Contains $claudeDetailsJson "Detailed validation passed" "completion details preserve description"
    Assert-Contains $claudeDetailsJson "目录" "details contain directory"
    Assert-Contains $claudeDetailsJson "事件" "details contain event"
    Assert-NotContains $claudeDetailsJson "会话" "details omit session"
    Assert-NotContains $claudeDetailsJson "Card work" "session name only in subtitle"

    $metrics = $claude.Card.body.elements[1]
    Assert-Equals $metrics.tag "column_set" "metric container"
    Assert-Equals $metrics.flex_mode "none" "metric flex mode"
    Assert-Equals $metrics.horizontal_spacing "small" "metric spacing"
    Assert-Equals $metrics.columns.Count 4 "metric column count"
    $labels = @($metrics.columns | ForEach-Object { $_.elements[0].text.content })
    Assert-Equals ($labels -join "|") "耗时|Token|命中率|花费" "metric field order"
    foreach ($column in $metrics.columns)
    {
        Assert-Equals $column.width "weighted" "metric weighted width"
        Assert-Equals $column.weight 1 "metric equal weight"
        Assert-Equals $column.padding "4px 2px" "metric column padding"
        Assert-Equals $column.vertical_spacing "2px" "metric vertical spacing"
        Assert-Equals $column.elements[0].text.text_size "notation" "metric label size"
        Assert-Equals $column.elements[0].text.text_color "grey" "metric label color"
        Assert-Equals $column.elements[0].text.lines 1 "metric label single line"
        Assert-Equals $column.elements[1].text.text_size "normal" "metric value size"
        Assert-Equals $column.elements[1].text.lines 1 "metric value single line"
    }
    Assert-NotContains ($metrics | ConvertTo-Json -Depth 20) "项目" "project removed from metrics"

    $claudeRetry = Invoke-NotifyDryRun -Source claude -Payload $claudePayload
    Assert-Equals $claudeRetry.CardIdempotencyKey $claude.CardIdempotencyKey "same event stable card key"
    Assert-Equals $claudeRetry.FallbackIdempotencyKey $claude.FallbackIdempotencyKey "same event stable fallback key"
    Assert-NotEquals $claude.CardIdempotencyKey $claude.FallbackIdempotencyKey "card and fallback keys differ"

    $claudeLock = [System.IO.File]::Open(
        $claudeTranscript,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None)
    try
    {
        $claudeLocked = Invoke-NotifyDryRun -Source claude -Payload $claudePayload.Clone()
        Assert-False $claudeLocked.Skipped "locked Claude transcript still notifies"
        Assert-Equals $claudeLocked.Statistics.Duration "--" "locked Claude duration placeholder"
        Assert-Equals $claudeLocked.Statistics.TokenCount "--" "locked Claude token placeholder"
        Assert-Equals $claudeLocked.Card.header.title.content "Claude Code · 会话已完成" "locked Claude card constructed"
    }
    finally
    {
        $claudeLock.Dispose()
    }

    $needsPayload = $claudePayload.Clone()
    $needsPayload.hook_event_name = "Notification"
    $needsPayload.notification_type = "permission_prompt"
    $needsPayload.message = "Approval required"
    $needs = Invoke-NotifyDryRun -Source claude -Payload $needsPayload
    Assert-Equals $needs.Card.header.template "orange" "needs-action color"
    Assert-Equals $needs.Card.header.title.content "Claude Code · 等待你的操作" "needs-action title"
    Assert-Equals $needs.Card.body.elements[0].columns[0].elements[1].text.content "Approval required" "needs-action summary unchanged"
    Assert-NotContains (($needs.Card.body.elements[2].elements[0].fields | ConvertTo-Json -Depth 20)) "Approval required" "needs-action details do not repeat summary"
    Assert-NotEquals $needs.CardIdempotencyKey $claude.CardIdempotencyKey "same prompt different event key"

    $failurePayload = $claudePayload.Clone()
    $failurePayload.hook_event_name = "StopFailure"
    $failurePayload.Remove("last_assistant_message")
    $failurePayload.error_details = "Compiler failed at line 42"
    $failure = Invoke-NotifyDryRun -Source claude -Payload $failurePayload
    Assert-Equals $failure.Card.header.template "red" "failure color"
    Assert-Equals $failure.Card.header.title.content "Claude Code · 会话失败" "failure title"
    Assert-Equals $failure.Card.body.elements[0].columns[0].elements[1].text.content "Compiler failed at line 42" "failure actual error"
    Assert-NotContains (($failure.Card.body.elements[2].elements[0].fields | ConvertTo-Json -Depth 20)) "Compiler failed at line 42" "failure details do not repeat summary"

    $sessionId = "01a20000-0000-7000-8000-000000000101"
    $turnId = "codex-turn-101"
    $env:CODEX_HOME = New-CodexHome "codex-home"
    $codexHome = $env:CODEX_HOME
    $codexTranscript = New-CodexTranscript -CodexHome $env:CODEX_HOME -SessionId $sessionId -TurnId $turnId -IncompleteTail
    Set-SessionIndex -CodexHome $env:CODEX_HOME -Lines @(
        "{bad-json",
        (@{ id = $sessionId; thread_name = "Codex notification work" } | ConvertTo-Json -Compress)
    )
    $codexPayload = @{
        hook_event_name = "Stop"
        session_id = $sessionId
        turn_id = $turnId
        transcript_path = ([Uri]$codexTranscript).AbsoluteUri
        cwd = "D:\WA\unity_asset"
        last_assistant_message = "Codex complete"
    }
    $codex = Invoke-NotifyDryRun -Source codex -Payload $codexPayload
    Assert-False $codex.Skipped "Codex Stop is sent"
    Assert-Equals $codex.Card.header.title.content "Codex · 会话已完成" "Codex title"
    Assert-Equals $codex.Card.config.summary.content "Codex · 会话已完成" "Codex system summary"
    Assert-Equals $codex.Card.header.subtitle.content "unity_asset · Codex notification …" "Codex subtitle order"
    Assert-Equals ($codex.Card.header.subtitle.content -split ' · ')[0] "unity_asset" "Codex subtitle starts with project"
    Assert-Equals $codex.Card.header.text_tag_list.Count 2 "Codex status and time tag count"
    Assert-Equals $codex.Card.header.text_tag_list[1].color "neutral" "Codex time tag neutral"
    Assert-Matches $codex.Card.header.text_tag_list[1].text.content '^\d{2}:\d{2}$' "Codex time tag format"
    Assert-Equals $codex.Statistics.Duration "1m5s" "Codex duration"
    Assert-Equals $codex.Statistics.TokenCount "21k" "Codex token count"
    Assert-Equals $codex.Statistics.CacheHitRate "90%" "Codex cache hit rate"
    Assert-NotEquals $codex.Statistics.Cost "--" "Codex estimated cost"

    $codexLock = [System.IO.File]::Open(
        $codexTranscript,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None)
    try
    {
        $codexLocked = Invoke-NotifyDryRun -Source codex -Payload $codexPayload.Clone()
        Assert-False $codexLocked.Skipped "locked Codex transcript still notifies"
        Assert-Equals $codexLocked.Statistics.Duration "--" "locked Codex duration placeholder"
        Assert-Equals $codexLocked.Statistics.TokenCount "--" "locked Codex token placeholder"
        Assert-Equals $codexLocked.Card.header.title.content "Codex · 会话已完成" "locked Codex card constructed"
    }
    finally
    {
        $codexLock.Dispose()
    }

    $missingPricePath = Join-Path $testRoot "missing-prices.json"
    $env:TOKEN_METER_PRICE_TABLE_PATH = $missingPricePath
    $codexNoPrice = Invoke-NotifyDryRun -Source codex -Payload $codexPayload
    Assert-Equals $codexNoPrice.Statistics.Cost "--" "missing price table placeholder"
    Assert-Equals $codexNoPrice.Statistics.TokenCount "21k" "tokens survive missing price table"
    $env:TOKEN_METER_PRICE_TABLE_PATH = $null
    $historyFiles = @(Get-ChildItem -LiteralPath $testTokenData -Recurse -Filter "history.jsonl" -File -ErrorAction SilentlyContinue)
    Assert-Equals $historyFiles.Count 0 "notification does not write token history"

    $ambientHome = New-CodexHome "ambient-home"
    $env:CODEX_HOME = $ambientHome
    $ambient = Invoke-NotifyDryRun -Source codex -Payload @{
        hook_event_name = "Stop"
        session_id = "01a20000-0000-7000-8000-000000000102"
        cwd = "D:\WA\unity_asset"
        last_assistant_message = '{"suggestions":[]}'
    }
    Assert-True $ambient.Skipped "unpersisted Codex session skipped"
    Assert-Equals $ambient.Reason "unpersisted-codex-session" "ambient skip reason"

    $binHome = New-CodexHome "bin-home"
    $env:CODEX_HOME = $binHome
    $codexBin = Join-Path $testLocalAppData "OpenAI\Codex\bin"
    $internal = Invoke-NotifyDryRun -Source codex -Payload @{
        hook_event_name = "Stop"
        session_id = "01a20000-0000-7000-8000-000000000103"
        cwd = (Join-Path $codexBin "build-hash").ToUpperInvariant()
        last_assistant_message = '{"exclude":[]}'
    }
    Assert-True $internal.Skipped "Codex internal session skipped"
    Assert-Equals $internal.Reason "codex-internal-directory" "Codex internal reason"

    # Restore the persisted Codex home for send-path tests.
    $env:CODEX_HOME = $codexHome

    Reset-FakeCalls
    $env:LARK_NOTIFY_FAKE_MODE = "success"
    Assert-Equals (Invoke-Notify -Source claude -Payload $claudePayload) "{}" "successful hook output"
    $calls = @(Get-FakeCalls)
    Assert-Equals $calls.Count 1 "one successful card call"
    Assert-Equals (Get-ArgumentValue $calls[0].Arguments "--msg-type") "interactive" "interactive message type"
    Assert-Equals (Get-ArgumentValue $calls[0].Arguments "--format") "json" "typed JSON output requested"
    $sentCard = (Get-ArgumentValue $calls[0].Arguments "--content") | ConvertFrom-Json
    Assert-Equals $sentCard.schema "2.0" "sent Card 2.0 JSON"

    Reset-FakeCalls
    foreach ($name in @("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"))
    {
        [Environment]::SetEnvironmentVariable($name, "http://127.0.0.1:9", "Process")
    }
    $env:LARK_NOTIFY_FAKE_MODE = "success"
    Assert-Equals (Invoke-Notify -Source claude -Payload $claudePayload) "{}" "proxy-isolated hook output"
    $calls = @(Get-FakeCalls)
    Assert-Equals $calls.Count 1 "proxy-isolated call count"
    Assert-Equals $calls[0].ProxyValues.Count 0 "proxy variables excluded from lark-cli"
    Assert-Equals $env:HTTP_PROXY "http://127.0.0.1:9" "caller proxy environment preserved"
    foreach ($name in @("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"))
    {
        [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], "Process")
    }

    Reset-FakeCalls
    $env:LARK_NOTIFY_FAKE_MODE = "multiline_definitive"
    Assert-Equals (Invoke-Notify -Source claude -Payload $claudePayload) "{}" "multiline failure hook output"
    Assert-Equals (@(Get-FakeCalls)).Count 2 "multiline definitive failure sends fallback"

    Reset-FakeCalls
    $env:LARK_NOTIFY_FAKE_MODE = "stderr_definitive_then_success"
    Assert-Equals (Invoke-Notify -Source claude -Payload $claudePayload) "{}" "stderr multiline hook output"
    Assert-Equals (@(Get-FakeCalls)).Count 2 "stderr multiline failure sends fallback"

    Reset-FakeCalls
    $env:LARK_NOTIFY_FAKE_MODE = "success"
    $codexSendLock = [System.IO.File]::Open(
        $codexTranscript,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None)
    try
    {
        Assert-Equals (Invoke-Notify -Source codex -Payload $codexPayload) "{}" "locked transcript hook output"
    }
    finally
    {
        $codexSendLock.Dispose()
    }
    $calls = @(Get-FakeCalls)
    Assert-Equals $calls.Count 1 "locked transcript still sends one card"
    Assert-Equals (Get-ArgumentValue $calls[0].Arguments "--msg-type") "interactive" "locked transcript sends card"
    $lockedSentCard = (Get-ArgumentValue $calls[0].Arguments "--content") | ConvertFrom-Json
    $lockedMetricValues = @($lockedSentCard.body.elements[1].columns | ForEach-Object { $_.elements[1].text.content })
    Assert-Equals ($lockedMetricValues -join "|") "--|--|--|--" "locked transcript sends placeholder metrics"

    Reset-FakeCalls
    $env:LARK_NOTIFY_FAKE_MODE = "definitive_then_success"
    Assert-Equals (Invoke-Notify -Source codex -Payload $codexPayload) "{}" "definitive rejection hook output"
    $calls = @(Get-FakeCalls)
    Assert-Equals $calls.Count 2 "definitive rejection sends one fallback"
    Assert-Equals (Get-ArgumentValue $calls[0].Arguments "--msg-type") "interactive" "first call is card"
    Assert-True ($calls[1].Arguments -contains "--text") "second call is text"
    Assert-NotEquals (Get-ArgumentValue $calls[0].Arguments "--idempotency-key") (Get-ArgumentValue $calls[1].Arguments "--idempotency-key") "send-path keys differ"

    Reset-FakeCalls
    $env:LARK_NOTIFY_FAKE_MODE = "ambiguous"
    Assert-Equals (Invoke-Notify -Source claude -Payload $claudePayload) "{}" "ambiguous failure hook output"
    Assert-Equals (@(Get-FakeCalls)).Count 1 "ambiguous failure has no fallback"

    Reset-FakeCalls
    $env:LARK_NOTIFY_FAKE_MODE = "always_definitive"
    Assert-Equals (Invoke-Notify -Source claude -Payload $claudePayload) "{}" "double failure hook output"
    Assert-Equals (@(Get-FakeCalls)).Count 2 "card and fallback each attempted once"

    Reset-FakeCalls
    $env:LARK_NOTIFY_FAKE_MODE = "success"
    $originalCardBuilder = ${function:New-NotificationCard}
    try
    {
        Set-Item -Path Function:New-NotificationCard -Value { throw "forced local card failure" }
        $directPayload = $claudePayload | ConvertTo-Json -Depth 20 | ConvertFrom-Json
        $localFailure = Invoke-LarkNotification -Payload $directPayload -Source claude
        Assert-Equals $localFailure.State "Sent" "local card failure fallback succeeds"
        $calls = @(Get-FakeCalls)
        Assert-Equals $calls.Count 1 "local card failure sends only fallback"
        Assert-True ($calls[0].Arguments -contains "--text") "local card failure uses text"
    }
    finally
    {
        Set-Item -Path Function:New-NotificationCard -Value $originalCardBuilder
    }

    Assert-Contains (Get-NotifyLog) "Card send failed" "send failures logged"
    Write-Host "PASS: $assertionCount assertions"
}
finally
{
    foreach ($name in $originalEnvironment.Keys)
    {
        [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], "Process")
    }
    if (Test-Path -LiteralPath $testRoot)
    {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
