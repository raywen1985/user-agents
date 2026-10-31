[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("codex", "claude")]
    [string]$Source,

    [switch]$DryRun
)

if ($env:LARK_GATEWAY_MANAGED -eq "1")
{
    [Console]::Out.WriteLine("{}")
    exit 0
}

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Get-PropertyValue
{
    param([object]$InputObject, [string]$Name)

    if ($null -eq $InputObject)
    {
        return $null
    }
    if ($InputObject -is [System.Collections.IDictionary])
    {
        if ($InputObject.Contains($Name))
        {
            return $InputObject[$Name]
        }
        return $null
    }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property)
    {
        return $null
    }
    return $property.Value
}

function Set-PropertyValue
{
    param([object]$InputObject, [string]$Name, [object]$Value)

    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property)
    {
        $InputObject | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
    }
    else
    {
        $property.Value = $Value
    }
}

function Protect-Text
{
    param([string]$Text)

    if ([string]::IsNullOrWhiteSpace($Text))
    {
        return ""
    }
    $protected = $Text -replace '(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+', '$1[REDACTED]'
    $protected = $protected -replace '(?i)\bsk-[A-Za-z0-9_-]{8,}\b', '[REDACTED]'
    $protected = $protected -replace '(?i)((?:api[_-]?key|token|secret|password)\s*[:=]\s*)\S+', '$1[REDACTED]'
    return ($protected -replace '\s+', ' ').Trim()
}

function ConvertTo-LarkMarkdownText
{
    param([string]$Text)

    $safe = [System.Net.WebUtility]::HtmlEncode((Protect-Text $Text))
    $safe = $safe.Replace("#", "&#35;")
    $safe = $safe.Replace("*", "&#42;").Replace("_", "&#95;")
    $safe = $safe.Replace("~", "&#126;")
    $safe = $safe.Replace("[", "&#91;").Replace("]", "&#93;")
    $safe = $safe.Replace("(", "&#40;").Replace(")", "&#41;")
    return $safe
}

function Get-EventSummary
{
    param([object]$Payload, [string]$EventName)

    $summary = ""
    switch ($EventName)
    {
        "Stop" { $summary = [string](Get-PropertyValue $Payload "last_assistant_message") }
        "StopFailure" {
            $summary = [string](Get-PropertyValue $Payload "last_assistant_message")
            if ([string]::IsNullOrWhiteSpace($summary))
            {
                $errorValue = Get-PropertyValue $Payload "error_details"
                if ($null -eq $errorValue)
                {
                    $errorValue = Get-PropertyValue $Payload "error"
                }
                if ($null -ne $errorValue)
                {
                    $summary = if ($errorValue -is [string]) {
                        [string]$errorValue
                    } else {
                        $errorValue | ConvertTo-Json -Compress -Depth 10
                    }
                }
            }
        }
        "PermissionRequest" {
            $toolInput = Get-PropertyValue $Payload "tool_input"
            $summary = [string](Get-PropertyValue $toolInput "description")
            if ([string]::IsNullOrWhiteSpace($summary))
            {
                $summary = "Tool approval requested: " + [string](Get-PropertyValue $Payload "tool_name")
            }
        }
        "Notification" {
            $summary = [string](Get-PropertyValue $Payload "message")
            if ([string]::IsNullOrWhiteSpace($summary))
            {
                $summary = [string](Get-PropertyValue $Payload "title")
            }
        }
        default { $summary = [string](Get-PropertyValue $Payload "last_assistant_message") }
    }

    if ([string]::IsNullOrWhiteSpace($summary))
    {
        if ($EventName -eq "StopFailure")
        {
            return "未提供错误详情"
        }
        return "未提供结果摘要"
    }
    return Protect-Text $summary
}

function Get-Sha256Text
{
    param([AllowEmptyString()][string]$Text)

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try
    {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        return ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
    }
    finally
    {
        $sha.Dispose()
    }
}

function ConvertTo-CanonicalFieldSequence
{
    param([AllowEmptyCollection()][object[]]$Fields)

    $builder = [System.Text.StringBuilder]::new()
    foreach ($field in $Fields)
    {
        $value = if ($null -eq $field) { "" } else { [string]$field }
        $byteLength = [System.Text.Encoding]::UTF8.GetByteCount($value)
        [void]$builder.Append($byteLength.ToString([System.Globalization.CultureInfo]::InvariantCulture))
        [void]$builder.Append(":")
        [void]$builder.Append($value)
    }
    return $builder.ToString()
}

function ConvertTo-NormalizedLocalPath
{
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path))
    {
        return $null
    }
    try
    {
        $candidate = $Path
        $uri = $null
        if ([Uri]::TryCreate($Path, [UriKind]::Absolute, [ref]$uri) -and $uri.IsFile)
        {
            $candidate = $uri.LocalPath
        }
        $fullPath = [System.IO.Path]::GetFullPath($candidate)
        $pathRoot = [System.IO.Path]::GetPathRoot($fullPath)
        if ([string]::Equals($fullPath, $pathRoot, [StringComparison]::OrdinalIgnoreCase))
        {
            return $fullPath
        }
        $trimChars = [char[]]@(
            [System.IO.Path]::DirectorySeparatorChar,
            [System.IO.Path]::AltDirectorySeparatorChar
        )
        return $fullPath.TrimEnd($trimChars)
    }
    catch
    {
        return $null
    }
}

function Test-PathWithinRoot
{
    param([string]$Path, [string]$Root)

    $normalizedPath = ConvertTo-NormalizedLocalPath $Path
    $normalizedRoot = ConvertTo-NormalizedLocalPath $Root
    if ([string]::IsNullOrWhiteSpace($normalizedPath) -or [string]::IsNullOrWhiteSpace($normalizedRoot))
    {
        return $false
    }
    if ([string]::Equals($normalizedPath, $normalizedRoot, [StringComparison]::OrdinalIgnoreCase))
    {
        return $true
    }
    $rootPrefix = $normalizedRoot
    if (-not $rootPrefix.EndsWith([string][System.IO.Path]::DirectorySeparatorChar))
    {
        $rootPrefix += [System.IO.Path]::DirectorySeparatorChar
    }
    return $normalizedPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)
}

function Get-CodexHome
{
    if (-not [string]::IsNullOrWhiteSpace($env:CODEX_HOME))
    {
        return $env:CODEX_HOME
    }
    return Join-Path $env:USERPROFILE ".codex"
}

function Find-CodexSessionIndexEntry
{
    param([string]$SessionId, [string]$CodexHome)

    if ([string]::IsNullOrWhiteSpace($SessionId))
    {
        return [pscustomobject]@{ State = "NotFound"; SessionName = "" }
    }
    $indexPath = Join-Path $CodexHome "session_index.jsonl"
    if (-not (Test-Path -LiteralPath $indexPath -PathType Leaf))
    {
        return [pscustomobject]@{ State = "NotFound"; SessionName = "" }
    }
    for ($attempt = 0; $attempt -lt 3; $attempt++)
    {
        try
        {
            foreach ($line in [System.IO.File]::ReadLines($indexPath))
            {
                try
                {
                    $entry = $line | ConvertFrom-Json
                    if ([string](Get-PropertyValue $entry "id") -eq $SessionId)
                    {
                        return [pscustomobject]@{
                            State = "Found"
                            SessionName = [string](Get-PropertyValue $entry "thread_name")
                        }
                    }
                }
                catch
                {
                }
            }
            return [pscustomobject]@{ State = "NotFound"; SessionName = "" }
        }
        catch
        {
            if ($attempt -lt 2)
            {
                Start-Sleep -Milliseconds 50
            }
        }
    }
    return [pscustomobject]@{ State = "ReadFailed"; SessionName = "" }
}

function Test-CodexTranscript
{
    param([string]$TranscriptPath, [string]$SessionId, [string]$CodexHome)

    if ([string]::IsNullOrWhiteSpace($TranscriptPath) -or [string]::IsNullOrWhiteSpace($SessionId))
    {
        return $false
    }
    $normalizedPath = ConvertTo-NormalizedLocalPath $TranscriptPath
    if ([string]::IsNullOrWhiteSpace($normalizedPath) -or -not (Test-Path -LiteralPath $normalizedPath -PathType Leaf))
    {
        return $false
    }
    $sessionsRoot = Join-Path $CodexHome "sessions"
    if (-not (Test-PathWithinRoot -Path $normalizedPath -Root $sessionsRoot))
    {
        return $false
    }
    $fileName = [System.IO.Path]::GetFileName($normalizedPath)
    return $fileName.IndexOf($SessionId, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Get-CodexSessionInfo
{
    param([object]$Payload)

    $sessionId = [string](Get-PropertyValue $Payload "session_id")
    $transcriptPath = [string](Get-PropertyValue $Payload "transcript_path")
    $cwd = [string](Get-PropertyValue $Payload "cwd")
    $codexHome = Get-CodexHome
    $indexEntry = Find-CodexSessionIndexEntry -SessionId $sessionId -CodexHome $codexHome
    $hasTranscript = Test-CodexTranscript -TranscriptPath $transcriptPath -SessionId $sessionId -CodexHome $codexHome
    $shouldNotify = $indexEntry.State -eq "Found" -or $hasTranscript
    $codexBinRoot = if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        ""
    } else {
        Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin"
    }
    $isInternalDirectory = -not [string]::IsNullOrWhiteSpace($codexBinRoot) -and
        (Test-PathWithinRoot -Path $cwd -Root $codexBinRoot)
    $reason = if ($shouldNotify) {
        if ($indexEntry.State -eq "Found") { "session-index" } else { "session-transcript" }
    } elseif ($isInternalDirectory) {
        if ($indexEntry.State -eq "ReadFailed") {
            "codex-internal-directory+session-index-read-failed"
        } else {
            "codex-internal-directory"
        }
    } elseif ($indexEntry.State -eq "ReadFailed") {
        "session-index-read-failed"
    } else {
        "unpersisted-codex-session"
    }
    return [pscustomobject]@{
        ShouldNotify = $shouldNotify
        Reason = $reason
        SessionName = [string]$indexEntry.SessionName
    }
}

function Get-SessionName
{
    param([object]$Payload, [string]$Source, [string]$SessionId, [string]$CodexSessionName)

    $sessionName = [string](Get-PropertyValue $Payload "session_name")
    if ([string]::IsNullOrWhiteSpace($sessionName))
    {
        $sessionName = [string](Get-PropertyValue $Payload "title")
    }
    if ([string]::IsNullOrWhiteSpace($sessionName) -and $Source -eq "codex")
    {
        $sessionName = $CodexSessionName
    }
    if ([string]::IsNullOrWhiteSpace($sessionName) -and $Source -eq "claude")
    {
        $transcriptPath = [string](Get-PropertyValue $Payload "transcript_path")
        if (-not [string]::IsNullOrWhiteSpace($transcriptPath) -and (Test-Path -LiteralPath $transcriptPath -PathType Leaf))
        {
            foreach ($entry in @(Read-JsonLines $transcriptPath))
            {
                $entryType = [string](Get-PropertyValue $entry "type")
                if ($entryType -eq "custom-title")
                {
                    $sessionName = [string](Get-PropertyValue $entry "customTitle")
                }
                elseif ($entryType -eq "ai-title" -and [string]::IsNullOrWhiteSpace($sessionName))
                {
                    $sessionName = [string](Get-PropertyValue $entry "aiTitle")
                }
            }
        }
    }
    if ([string]::IsNullOrWhiteSpace($sessionName))
    {
        if ([string]::IsNullOrWhiteSpace($SessionId))
        {
            return "Unknown"
        }
        return $SessionId.Substring(0, [Math]::Min(8, $SessionId.Length))
    }
    $sessionName = Protect-Text $sessionName
    if ($sessionName.Length -gt 120)
    {
        $sessionName = $sessionName.Substring(0, 117) + "..."
    }
    return $sessionName
}

function Write-NotifyLog
{
    param([string]$Message)

    try
    {
        $logDirectory = Join-Path $env:LOCALAPPDATA "lark-notify"
        [System.IO.Directory]::CreateDirectory($logDirectory) | Out-Null
        $safeMessage = Protect-Text $Message
        if ($safeMessage.Length -gt 500)
        {
            $safeMessage = $safeMessage.Substring(0, 500)
        }
        $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $safeMessage
        Add-Content -LiteralPath (Join-Path $logDirectory "notify.log") -Value $line -Encoding UTF8
    }
    catch
    {
    }
}

function Test-ShouldNotify
{
    param([string]$Source, [string]$EventName, [string]$NotificationType, [object]$CodexSessionInfo)

    if ($EventName -in @("Stop", "StopFailure"))
    {
        if ($Source -eq "codex")
        {
            return $null -ne $CodexSessionInfo -and $CodexSessionInfo.ShouldNotify
        }
        return $true
    }
    if ($Source -eq "claude" -and $EventName -eq "Notification")
    {
        return $NotificationType -match '^(permission_prompt|idle_prompt|agent_needs_input)$'
    }
    # Codex PermissionRequest also fires before automatic review, so it does
    # not prove that the session is blocked waiting for the user.
    return $false
}

function Read-JsonLines
{
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf))
    {
        return @()
    }
    $lastError = ""
    for ($attempt = 0; $attempt -lt 5; $attempt++)
    {
        $stream = $null
        $reader = $null
        try
        {
            $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
            $stream = [System.IO.File]::Open(
                $Path,
                [System.IO.FileMode]::Open,
                [System.IO.FileAccess]::Read,
                $share)
            $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8, $true)
            $rows = [System.Collections.Generic.List[object]]::new()
            while (-not $reader.EndOfStream)
            {
                $line = $reader.ReadLine()
                if ([string]::IsNullOrWhiteSpace($line))
                {
                    continue
                }
                try
                {
                    $rows.Add(($line.TrimStart([char]0xfeff) | ConvertFrom-Json))
                }
                catch
                {
                    # A hook may race a transcript writer. Ignore incomplete rows.
                }
            }
            return $rows.ToArray()
        }
        catch
        {
            $lastError = $_.Exception.Message
        }
        finally
        {
            try
            {
                if ($null -ne $reader)
                {
                    $reader.Dispose()
                }
                elseif ($null -ne $stream)
                {
                    $stream.Dispose()
                }
            }
            catch
            {
            }
        }
        if ($attempt -lt 4)
        {
            Start-Sleep -Milliseconds (50 * [Math]::Pow(2, $attempt))
        }
    }
    Write-NotifyLog "Transcript read unavailable after retries: path=$Path error=$lastError"
    return @()
}

function ConvertTo-DateTimeOffsetValue
{
    param([object]$Value)

    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value))
    {
        return $null
    }
    $parsed = [DateTimeOffset]::MinValue
    $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
    if ([DateTimeOffset]::TryParse([string]$Value, [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$parsed))
    {
        return $parsed
    }
    return $null
}

function Test-ClaudeHumanUserRow
{
    param([object]$Row)

    if ([string](Get-PropertyValue $Row "type") -ne "user" -or (Get-PropertyValue $Row "isSidechain") -eq $true)
    {
        return $false
    }
    $message = Get-PropertyValue $Row "message"
    $content = Get-PropertyValue $message "content"
    if ($null -eq $content)
    {
        return $false
    }
    if ($content -is [string])
    {
        return -not [string]::IsNullOrWhiteSpace($content)
    }
    $nonTool = @($content | Where-Object { [string](Get-PropertyValue $_ "type") -notin @("tool_result", "tool_use") })
    return $nonTool.Count -gt 0
}

function Get-TurnDuration
{
    param([object]$Payload, [string]$Source)

    $transcriptPath = [string](Get-PropertyValue $Payload "transcript_path")
    $rows = @(Read-JsonLines $transcriptPath)
    if ($rows.Count -eq 0)
    {
        return $null
    }
    $start = $null
    $end = $null
    if ($Source -eq "claude")
    {
        $userIndex = -1
        for ($index = 0; $index -lt $rows.Count; $index++)
        {
            if (Test-ClaudeHumanUserRow $rows[$index])
            {
                $userIndex = $index
            }
        }
        if ($userIndex -lt 0)
        {
            return $null
        }
        $start = ConvertTo-DateTimeOffsetValue (Get-PropertyValue $rows[$userIndex] "timestamp")
        $assistantRow = $null
        for ($index = $userIndex + 1; $index -lt $rows.Count; $index++)
        {
            $candidate = $rows[$index]
            if ([string](Get-PropertyValue $candidate "type") -eq "assistant" -and
                (Get-PropertyValue $candidate "isSidechain") -ne $true)
            {
                $assistantRow = $candidate
            }
        }
        if ($null -ne $assistantRow)
        {
            $end = ConvertTo-DateTimeOffsetValue (Get-PropertyValue $assistantRow "timestamp")
        }
    }
    else
    {
        $turnId = [string](Get-PropertyValue $Payload "turn_id")
        if ([string]::IsNullOrWhiteSpace($turnId))
        {
            return $null
        }
        $matches = @($rows | Where-Object {
            $rowPayload = Get-PropertyValue $_ "payload"
            [string](Get-PropertyValue $rowPayload "turn_id") -eq $turnId
        })
        if ($matches.Count -eq 0)
        {
            return $null
        }
        $start = ConvertTo-DateTimeOffsetValue (Get-PropertyValue $matches[0] "timestamp")
        $end = ConvertTo-DateTimeOffsetValue (Get-PropertyValue $matches[$matches.Count - 1] "timestamp")
    }
    if ($null -eq $start -or $null -eq $end -or $end -lt $start)
    {
        return $null
    }
    return $end - $start
}

function Format-Duration
{
    param([object]$Duration)

    if ($null -eq $Duration)
    {
        return "--"
    }
    $durationValue = [TimeSpan]$Duration
    $seconds = [Math]::Floor($durationValue.TotalSeconds)
    if ($seconds -lt 60)
    {
        return "{0}s" -f $seconds
    }
    if ($seconds -lt 3600)
    {
        return "{0}m{1}s" -f [Math]::Floor($seconds / 60), ($seconds % 60)
    }
    return "{0}h{1}m" -f [Math]::Floor($seconds / 3600), ([Math]::Floor($seconds / 60) % 60)
}

function Format-CompactTokenCount
{
    param([object]$Value)

    if ($null -eq $Value -or [int64]$Value -lt 0)
    {
        return "--"
    }
    $numericValue = [int64]$Value
    $culture = [Globalization.CultureInfo]::InvariantCulture
    if ($numericValue -ge 1000000)
    {
        return ([decimal]$numericValue / 1000000).ToString("0.##", $culture) + "M"
    }
    if ($numericValue -ge 1000)
    {
        return ([decimal]$numericValue / 1000).ToString("0.##", $culture) + "k"
    }
    return $numericValue.ToString($culture)
}

function Get-TurnStatistics
{
    param([object]$Payload, [string]$Source)

    $result = [ordered]@{
        Duration = Format-Duration (Get-TurnDuration -Payload $Payload -Source $Source)
        TokenCount = "--"
        CacheHitRate = "--"
        Cost = "--"
        LogicalTurnId = ""
    }
    $modulePath = Join-Path (Split-Path -Parent $PSScriptRoot) "token-meter\TokenMeter.psm1"
    if (-not (Test-Path -LiteralPath $modulePath -PathType Leaf))
    {
        return [pscustomobject]$result
    }
    try
    {
        Import-Module $modulePath -Force -DisableNameChecking
        $record = if ($Source -eq "claude") {
            Get-ClaudeTurnRecord -HookPayload $Payload
        } else {
            Get-CodexTurnRecord -HookPayload $Payload
        }
        $result.LogicalTurnId = [string](Get-PropertyValue $record "turn_id")
        $quality = [string](Get-PropertyValue $record "quality")
        if ($quality -notin @("PROVIDER_REPORTED", "DERIVED_REPORTED"))
        {
            return [pscustomobject]$result
        }
        $usage = Get-PropertyValue $record "normalized_usage"
        if ($null -eq $usage)
        {
            return [pscustomobject]$result
        }
        $effective = [int64](Get-PropertyValue $usage "effective_input_tokens")
        $output = [int64](Get-PropertyValue $usage "generated_output_tokens")
        $cacheRead = [int64](Get-PropertyValue $usage "cache_read_tokens")
        if ($effective -lt 0 -or $output -lt 0 -or $cacheRead -lt 0 -or $cacheRead -gt $effective)
        {
            return [pscustomobject]$result
        }
        $result.TokenCount = Format-CompactTokenCount ([int64]($effective + $output))
        if ($effective -gt 0)
        {
            $percentage = [Math]::Round((100.0 * $cacheRead / $effective), 0, [MidpointRounding]::AwayFromZero)
            $result.CacheHitRate = "{0}%" -f $percentage
        }
        $cost = Get-TMEstimatedCost -Record $record
        if ([string](Get-PropertyValue $cost "status") -eq "estimated")
        {
            $totalUsd = [decimal]0
            if ([decimal]::TryParse(
                [string](Get-PropertyValue $cost "total_usd"),
                [Globalization.NumberStyles]::Number,
                [Globalization.CultureInfo]::InvariantCulture,
                [ref]$totalUsd))
            {
                $result.Cost = '$' + $totalUsd.ToString("0.0000", [Globalization.CultureInfo]::InvariantCulture)
            }
        }
    }
    catch
    {
        Write-NotifyLog "Turn statistics unavailable: source=$Source error=$($_.Exception.Message)"
    }
    return [pscustomobject]$result
}

function Get-NotificationPresentation
{
    param([string]$Source, [string]$EventName, [string]$NotificationType)

    $sourceName = if ($Source -eq "codex") { "Codex" } else { "Claude Code" }
    $needsAction = $EventName -eq "Notification" -and
        $NotificationType -match '^(permission_prompt|idle_prompt|agent_needs_input)$'
    if ($needsAction)
    {
        return [pscustomobject]@{
            Key = "needs_action"; SourceName = $sourceName; Title = "等待你的操作"; Label = "待处理"
            SummaryLabel = "需要确认"; Template = "orange"; TagColor = "orange"
            Accent = "orange"; Background = "orange-50"
        }
    }
    if ($EventName -eq "StopFailure")
    {
        return [pscustomobject]@{
            Key = "failed"; SourceName = $sourceName; Title = "会话失败"; Label = "失败"
            SummaryLabel = "失败原因"; Template = "red"; TagColor = "red"
            Accent = "red"; Background = "red-50"
        }
    }
    if ($EventName -eq "Stop")
    {
        return [pscustomobject]@{
            Key = "complete"; SourceName = $sourceName; Title = "会话已完成"; Label = "完成"
            SummaryLabel = "执行结果"; Template = "green"; TagColor = "green"
            Accent = "green"; Background = "green-50"
        }
    }
    return [pscustomobject]@{
        Key = "ordinary"; SourceName = $sourceName; Title = "通知"; Label = "通知"
        SummaryLabel = "消息"; Template = "default"; TagColor = "neutral"
        Accent = "grey"; Background = "grey-50"
    }
}

function Get-TruncatedTextElements
{
    param([string]$Text, [int]$Maximum = 12)

    if ([string]::IsNullOrEmpty($Text) -or $Maximum -lt 1)
    {
        return ""
    }
    $elements = [System.Collections.Generic.List[string]]::new()
    $enumerator = [Globalization.StringInfo]::GetTextElementEnumerator($Text)
    while ($enumerator.MoveNext())
    {
        $elements.Add([string]$enumerator.GetTextElement())
    }
    if ($elements.Count -le $Maximum)
    {
        return $Text
    }
    return (($elements.GetRange(0, $Maximum - 1) -join "") + "…")
}

function Get-CompletionSummary
{
    param([string]$Summary)

    $candidate = (Protect-Text $Summary).Trim()
    $candidate = ($candidate -replace '^(?:(?:#{1,6}|[-*+>])\s+|\d+[.)]\s+)+', '').Trim()
    if ([string]::IsNullOrWhiteSpace($candidate))
    {
        return "已完成"
    }

    $sentence = [regex]::Match($candidate, '^.*?(?:[。！？!?]|\.(?:\s|$))')
    if ($sentence.Success)
    {
        $candidate = $sentence.Value.Trim()
    }
    if ($candidate -notmatch '^已(?:完成|修复|新增|更新|实现|调整|移除|解决|优化|配置|支持)')
    {
        $candidate = "已完成：$candidate"
    }
    return Get-TruncatedTextElements -Text $candidate -Maximum 40
}

function New-Field
{
    param([string]$Label, [string]$Value, [bool]$IsShort = $true)

    return [ordered]@{
        is_short = $IsShort
        text = [ordered]@{
            tag = "lark_md"
            content = "**$Label**`n$(ConvertTo-LarkMarkdownText $Value)"
        }
    }
}

function New-MetricColumn
{
    param([string]$Label, [string]$Value)

    return [ordered]@{
        tag = "column"
        width = "weighted"
        weight = 1
        padding = "4px 2px"
        vertical_spacing = "2px"
        elements = @(
            [ordered]@{
                tag = "div"
                text = [ordered]@{
                    tag = "plain_text"
                    content = $Label
                    text_size = "notation"
                    text_color = "grey"
                    text_align = "center"
                    lines = 1
                }
            },
            [ordered]@{
                tag = "div"
                text = [ordered]@{
                    tag = "plain_text"
                    content = $Value
                    text_size = "normal"
                    text_align = "center"
                    lines = 1
                }
            }
        )
    }
}

function New-NotificationCard
{
    param(
        [object]$Presentation,
        [string]$Project,
        [string]$Summary,
        [object]$Statistics,
        [string]$SessionName,
        [string]$Directory,
        [string]$EventType,
        [DateTimeOffset]$Timestamp = [DateTimeOffset]::Now
    )

    $projectDisplayName = Get-TruncatedTextElements -Text $Project -Maximum 12
    $sessionDisplayName = Get-TruncatedTextElements -Text $SessionName -Maximum 20
    $title = "{0} · {1}" -f $Presentation.SourceName, $Presentation.Title
    $subtitle = "{0} · {1}" -f $projectDisplayName, $sessionDisplayName
    $cardSummary = if ($Presentation.Key -eq "complete") {
        Get-CompletionSummary -Summary $Summary
    } else {
        $Summary
    }
    $detailFields = @()
    if ($Presentation.Key -eq "complete")
    {
        $detailFields += New-Field -Label "完整结果" -Value $Summary -IsShort $false
    }
    $detailFields += New-Field -Label "目录" -Value $Directory -IsShort $false
    $detailFields += New-Field -Label "事件" -Value $EventType -IsShort $false
    return [ordered]@{
        schema = "2.0"
        config = [ordered]@{
            update_multi = $true
            width_mode = "default"
            summary = [ordered]@{ content = $title }
        }
        header = [ordered]@{
            title = [ordered]@{ tag = "plain_text"; content = $title }
            subtitle = [ordered]@{ tag = "plain_text"; content = $subtitle }
            template = [string]$Presentation.Template
            icon = [ordered]@{ tag = "standard_icon"; token = "ai-common_colorful" }
            text_tag_list = @(
                [ordered]@{
                    tag = "text_tag"
                    text = [ordered]@{ tag = "plain_text"; content = [string]$Presentation.Label }
                    color = [string]$Presentation.TagColor
                },
                [ordered]@{
                    tag = "text_tag"
                    text = [ordered]@{ tag = "plain_text"; content = $Timestamp.ToLocalTime().ToString("HH:mm") }
                    color = "neutral"
                }
            )
        }
        body = [ordered]@{
            direction = "vertical"
            padding = "8px 12px 12px 12px"
            elements = @(
                [ordered]@{
                    tag = "column_set"
                    flex_mode = "none"
                    margin = "0px 0px 8px 0px"
                    columns = @(
                        [ordered]@{
                            tag = "column"
                            width = "weighted"
                            weight = 1
                            background_style = [string]$Presentation.Background
                            padding = "8px"
                            vertical_spacing = "4px"
                            elements = @(
                                [ordered]@{
                                    tag = "markdown"
                                    content = "**<font color='$($Presentation.Accent)'>$($Presentation.SummaryLabel)</font>**"
                                },
                                [ordered]@{
                                    tag = "div"
                                    text = [ordered]@{
                                        tag = "plain_text"
                                        content = $cardSummary
                                        lines = 4
                                    }
                                }
                            )
                        }
                    )
                },
                [ordered]@{
                    tag = "column_set"
                    flex_mode = "none"
                    horizontal_spacing = "small"
                    margin = "0px 0px 8px 0px"
                    columns = @(
                        (New-MetricColumn -Label "耗时" -Value ([string]$Statistics.Duration))
                        (New-MetricColumn -Label "Token" -Value ([string]$Statistics.TokenCount))
                        (New-MetricColumn -Label "命中率" -Value ([string]$Statistics.CacheHitRate))
                        (New-MetricColumn -Label "花费" -Value ([string]$Statistics.Cost))
                    )
                },
                [ordered]@{
                    tag = "collapsible_panel"
                    expanded = $false
                    background_color = "grey-50"
                    padding = "4px 8px 8px 8px"
                    margin = "0px"
                    header = [ordered]@{
                        title = [ordered]@{ tag = "plain_text"; content = "详细信息" }
                        width = "fill"
                    }
                    elements = @(
                        [ordered]@{
                            tag = "div"
                            fields = $detailFields
                        }
                    )
                }
            )
        }
    }
}

function Assert-NotificationCard
{
    param([object]$Card)

    if ([string](Get-PropertyValue $Card "schema") -ne "2.0")
    {
        throw "Card schema must be 2.0."
    }
    $header = Get-PropertyValue $Card "header"
    if ($null -eq $header -or [string]::IsNullOrWhiteSpace([string](Get-PropertyValue (Get-PropertyValue $header "title") "content")))
    {
        throw "Card header title is required."
    }
    $elements = @(Get-PropertyValue (Get-PropertyValue $Card "body") "elements")
    if ($elements.Count -ne 3)
    {
        throw "Card body must contain the summary, metrics, and details blocks."
    }
    if (@($elements | Where-Object { [string](Get-PropertyValue $_ "tag") -eq "collapsible_panel" }).Count -ne 1)
    {
        throw "Card must contain one collapsible details block."
    }
}

function New-FallbackMessage
{
    param(
        [object]$Presentation,
        [string]$SessionName,
        [string]$Project,
        [string]$Directory,
        [string]$EventType,
        [string]$Summary,
        [object]$Statistics,
        [DateTimeOffset]$Timestamp = [DateTimeOffset]::Now
    )

    return @(
        "[$($Presentation.Title)]"
        "项目: $Project"
        "耗时: $($Statistics.Duration)"
        "Token: $($Statistics.TokenCount)"
        "命中率: $($Statistics.CacheHitRate)"
        "花费: $($Statistics.Cost)"
        "摘要: $Summary"
        "会话: $SessionName"
        "目录: $Directory"
        "事件: $EventType"
        "时间: $($Timestamp.ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss zzz'))"
    ) -join "`n"
}

function Get-IdempotencyKeys
{
    param(
        [string]$Source,
        [string]$SessionId,
        [string]$PrimaryEventId,
        [string]$LogicalTurnId,
        [string]$TranscriptPath,
        [string]$EventName,
        [string]$NotificationType,
        [string]$Summary
    )

    $eventIdentity = $PrimaryEventId
    if ([string]::IsNullOrWhiteSpace($eventIdentity))
    {
        $eventIdentity = $LogicalTurnId
    }
    if ([string]::IsNullOrWhiteSpace($eventIdentity))
    {
        $fallbackFields = ConvertTo-CanonicalFieldSequence @(
            $Source, $SessionId, $TranscriptPath, $EventName, $NotificationType, $Summary
        )
        $eventIdentity = Get-Sha256Text $fallbackFields
    }
    $seed = ConvertTo-CanonicalFieldSequence @(
        $Source, $SessionId, $eventIdentity, $EventName, $NotificationType
    )
    return [pscustomobject]@{
        Card = (Get-Sha256Text ($seed + "|card")).Substring(0, 40)
        Fallback = (Get-Sha256Text ($seed + "|fallback")).Substring(0, 40)
    }
}

function Get-LarkCliPath
{
    if (-not [string]::IsNullOrWhiteSpace($env:LARK_NOTIFY_CLI_PATH) -and
        (Test-Path -LiteralPath $env:LARK_NOTIFY_CLI_PATH -PathType Leaf))
    {
        return $env:LARK_NOTIFY_CLI_PATH
    }
    $larkCliCandidates = @(
        (Join-Path $env:APPDATA "npm\node_modules\@larksuite\cli\bin\lark-cli.exe")
        (Join-Path $env:APPDATA "npm\lark-cli.ps1")
        (Join-Path $env:APPDATA "npm\lark-cli.cmd")
    )
    return $larkCliCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}

function ConvertTo-WindowsCommandLineArgument
{
    param([AllowEmptyString()][string]$Argument)

    if ([string]::IsNullOrEmpty($Argument))
    {
        return '""'
    }
    if ($Argument -notmatch '[\s"]')
    {
        return $Argument
    }

    $builder = [System.Text.StringBuilder]::new()
    [void]$builder.Append('"')
    $backslashCount = 0
    foreach ($character in $Argument.ToCharArray())
    {
        if ($character -eq [char]92)
        {
            $backslashCount++
            continue
        }
        if ($character -eq [char]34)
        {
            [void]$builder.Append(([string]::new([char]92, ($backslashCount * 2) + 1)))
            [void]$builder.Append([char]34)
            $backslashCount = 0
            continue
        }
        if ($backslashCount -gt 0)
        {
            [void]$builder.Append(([string]::new([char]92, $backslashCount)))
            $backslashCount = 0
        }
        [void]$builder.Append($character)
    }
    if ($backslashCount -gt 0)
    {
        [void]$builder.Append(([string]::new([char]92, $backslashCount * 2)))
    }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Invoke-LarkCliProcess
{
    param([string]$CliPath, [string[]]$Arguments)

    $extension = [System.IO.Path]::GetExtension($CliPath)
    if ([string]::Equals($extension, ".cmd", [StringComparison]::OrdinalIgnoreCase))
    {
        throw "The lark-cli .cmd shim is unsupported; install the executable or PowerShell shim."
    }

    $processArguments = @($Arguments)
    $fileName = $CliPath
    if ([string]::Equals($extension, ".ps1", [StringComparison]::OrdinalIgnoreCase))
    {
        $fileName = (Get-Command powershell.exe -ErrorAction Stop).Source
        $processArguments = @(
            "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $CliPath
        ) + $processArguments
    }

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $fileName
    $startInfo.Arguments = (@($processArguments | ForEach-Object {
        ConvertTo-WindowsCommandLineArgument ([string]$_)
    }) -join " ")
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($name in @("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"))
    {
        [void]$startInfo.EnvironmentVariables.Remove($name)
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try
    {
        if (-not $process.Start())
        {
            throw "Failed to start lark-cli."
        }
        $standardOutputTask = $process.StandardOutput.ReadToEndAsync()
        $standardErrorTask = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        return [pscustomobject]@{
            ExitCode = $process.ExitCode
            StandardOutput = $standardOutputTask.Result
            StandardError = $standardErrorTask.Result
        }
    }
    finally
    {
        $process.Dispose()
    }
}

function Get-CliEnvelopeResult
{
    param([int]$ExitCode, [string]$OutputText)

    $envelope = $null
    try
    {
        if (-not [string]::IsNullOrWhiteSpace($OutputText))
        {
            $envelope = $OutputText | ConvertFrom-Json
        }
    }
    catch
    {
        $envelope = $null
    }
    if ($ExitCode -eq 0 -and $null -ne $envelope -and (Get-PropertyValue $envelope "ok") -eq $true)
    {
        $data = Get-PropertyValue $envelope "data"
        return [pscustomobject]@{
            State = "Sent"; Detail = ""
            MessageId = [string](Get-PropertyValue $data "message_id")
            ChatId = [string](Get-PropertyValue $data "chat_id")
        }
    }
    if ($ExitCode -ne 0 -and $null -ne $envelope -and (Get-PropertyValue $envelope "ok") -eq $false)
    {
        $errorObject = Get-PropertyValue $envelope "error"
        $errorType = [string](Get-PropertyValue $errorObject "type")
        $detail = [string](Get-PropertyValue $errorObject "message")
        if ($errorType -in @("validation", "api", "authorization"))
        {
            return [pscustomobject]@{ State = "DefinitiveFailure"; Detail = "$errorType`: $detail" }
        }
        return [pscustomobject]@{ State = "AmbiguousFailure"; Detail = "$errorType`: $detail" }
    }
    return [pscustomobject]@{ State = "AmbiguousFailure"; Detail = $OutputText }
}

function Get-NotificationProjectEvidence
{
    param([object]$Payload, [string]$Source, [string]$SessionId)
    try
    {
        $transcript = ConvertTo-NormalizedLocalPath ([string](Get-PropertyValue $Payload 'transcript_path'))
        $nativeRoot = if ($Source -eq 'codex') { Join-Path (Get-CodexHome) 'sessions' } else {
            $claudeRoot = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }
            Join-Path $claudeRoot 'projects'
        }
        if (-not $transcript -or -not (Test-PathWithinRoot -Path $transcript -Root $nativeRoot)) { return $null }
        $file = Get-Item -LiteralPath $transcript -Force
        if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $null }
        foreach ($line in (Get-Content -LiteralPath $transcript -TotalCount 64 -Encoding UTF8))
        {
            try { $entry = $line | ConvertFrom-Json } catch { continue }
            $envelope = if ($Source -eq 'codex') {
                if ((Get-PropertyValue $entry 'type') -ne 'session_meta') { continue }
                Get-PropertyValue $entry 'payload'
            } else { $entry }
            $id = if ($Source -eq 'codex') { Get-PropertyValue $envelope 'id' } else { Get-PropertyValue $envelope 'sessionId' }
            if ([string]$id -ne $SessionId) { continue }
            $cwd = ConvertTo-NormalizedLocalPath ([string](Get-PropertyValue $envelope 'cwd'))
            if (-not $cwd -or -not (Test-Path -LiteralPath $cwd -PathType Container)) { continue }
            foreach ($checkPath in @($cwd, (Split-Path -Parent $transcript))) {
                $current = Get-Item -LiteralPath $checkPath -Force
                while ($null -ne $current) {
                    if ($current.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $null }
                    $current = $current.Parent
                }
            }
            return [pscustomobject]@{ projectPath = $cwd; projectAlias = (Split-Path -Leaf $cwd); sourcePath = $transcript }
        }
    } catch { return $null }
    return $null
}

function Save-NotificationBinding
{
    param([object]$Result, [object]$Config, [string]$Source, [string]$SessionId, [object]$Payload = $null)

    if ($Result.State -ne "Sent" -or (Get-PropertyValue $Config "identity") -ne "bot") { return }
    $messageId = [string](Get-PropertyValue $Result "MessageId")
    $chatId = [string](Get-PropertyValue $Result "ChatId")
    $recipient = [string](Get-PropertyValue $Config "recipientOpenId")
    if ($messageId -cnotmatch '^om_[A-Za-z0-9_-]{1,128}$' -or
        $SessionId -notmatch '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or
        $Source -cnotin @("codex", "claude") -or
        $recipient -cnotmatch '^ou_[A-Za-z0-9_-]{1,128}$' -or
        ($chatId -and $chatId -cnotmatch '^oc_[A-Za-z0-9_-]{1,128}$'))
    {
        Write-NotifyLog "Notification reply binding skipped: invalid or missing identity"
        return
    }
    $directory = Join-Path $env:USERPROFILE ".agents\claude-projects\lark\data\notification-bindings"
    $temporaryPath = $null
    try
    {
        [IO.Directory]::CreateDirectory($directory) | Out-Null
        $current = Get-Item -LiteralPath $directory -Force
        while ($null -ne $current) {
            if ($current.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'unsafe binding directory' }
            $current = $current.Parent
        }
        $record = [ordered]@{
            version = 1; messageId = $messageId; executor = $Source
            nativeId = $SessionId.ToLowerInvariant(); recipientOpenId = $recipient
            chatId = $chatId; createdAt = [DateTimeOffset]::UtcNow.ToString('o')
        }
        $projectEvidence = Get-NotificationProjectEvidence -Payload $Payload -Source $Source -SessionId $SessionId
        if ($null -ne $projectEvidence) {
            $record.version = 2
            $record.projectPath = $projectEvidence.projectPath
            $record.projectAlias = $projectEvidence.projectAlias
            $record.projectSourcePath = $projectEvidence.sourcePath
        }
        $target = Join-Path $directory "$messageId.json"
        $temporaryPath = Join-Path $directory (".{0}.tmp" -f [Guid]::NewGuid().ToString('N'))
        [IO.File]::WriteAllText($temporaryPath, ($record | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
        try { [IO.File]::Move($temporaryPath, $target) }
        catch
        {
            if (-not [IO.File]::Exists($target)) { throw }
            $existing = [IO.File]::ReadAllText($target) | ConvertFrom-Json
            foreach ($key in @("version", "messageId", "executor", "nativeId", "recipientOpenId", "chatId"))
            {
                if ([string](Get-PropertyValue $existing $key) -cne [string]$record[$key]) { throw 'binding conflict' }
            }
        }
    }
    catch { Write-NotifyLog "Notification reply binding failed: source=$Source messageId=$messageId" }
    finally
    {
        try
        {
            if ($temporaryPath -and [IO.File]::Exists($temporaryPath)) { [IO.File]::Delete($temporaryPath) }
        }
        catch { Write-NotifyLog "Notification reply binding temporary file cleanup failed" }
    }
}

function Invoke-LarkMessage
{
    param(
        [string]$CliPath,
        [object]$Config,
        [ValidateSet("interactive", "text")]
        [string]$MessageType,
        [string]$Content,
        [string]$IdempotencyKey
    )

    try
    {
        $arguments = @(
            "im", "+messages-send",
            "--as", [string](Get-PropertyValue $Config "identity"),
            "--user-id", [string](Get-PropertyValue $Config "recipientOpenId")
        )
        if ($MessageType -eq "interactive")
        {
            $arguments += @("--msg-type", "interactive", "--content", $Content)
        }
        else
        {
            $arguments += @("--text", $Content)
        }
        $arguments += @("--idempotency-key", $IdempotencyKey, "--format", "json")
        $processResult = Invoke-LarkCliProcess -CliPath $CliPath -Arguments $arguments
        $outputText = if ($processResult.ExitCode -eq 0) {
            [string]$processResult.StandardOutput
        } elseif (-not [string]::IsNullOrWhiteSpace([string]$processResult.StandardError)) {
            [string]$processResult.StandardError
        } else {
            [string]$processResult.StandardOutput
        }
        return Get-CliEnvelopeResult -ExitCode $processResult.ExitCode -OutputText $outputText.Trim()
    }
    catch
    {
        return [pscustomobject]@{ State = "AmbiguousFailure"; Detail = $_.Exception.Message }
    }
}

function Invoke-LarkNotification
{
    param([object]$Payload, [string]$Source, [switch]$DryRun)

    $ingress = [string](Get-PropertyValue $Payload "lark_ingress")
    if ([string]::IsNullOrWhiteSpace($ingress))
    {
        $ingress = if ($Source -eq "codex") { "codex-hook" } else { "claude-hook" }
    }
    $eventName = [string](Get-PropertyValue $Payload "hook_event_name")
    if ([string]::IsNullOrWhiteSpace($eventName))
    {
        $eventName = "Unknown"
    }
    $notificationType = [string](Get-PropertyValue $Payload "notification_type")
    $transcriptPath = ConvertTo-NormalizedLocalPath ([string](Get-PropertyValue $Payload "transcript_path"))
    if (-not [string]::IsNullOrWhiteSpace($transcriptPath))
    {
        Set-PropertyValue -InputObject $Payload -Name "transcript_path" -Value $transcriptPath
    }
    $normalizedCwd = ConvertTo-NormalizedLocalPath ([string](Get-PropertyValue $Payload "cwd"))
    if (-not [string]::IsNullOrWhiteSpace($normalizedCwd))
    {
        Set-PropertyValue -InputObject $Payload -Name "cwd" -Value $normalizedCwd
    }
    $codexSessionInfo = if ($Source -eq "codex" -and $eventName -in @("Stop", "StopFailure")) {
        Get-CodexSessionInfo -Payload $Payload
    } else {
        $null
    }
    if (-not (Test-ShouldNotify -Source $Source -EventName $eventName -NotificationType $notificationType -CodexSessionInfo $codexSessionInfo))
    {
        $skipReason = if ($null -eq $codexSessionInfo) { "event-filter" } else { $codexSessionInfo.Reason }
        Write-NotifyLog "Notification skipped: source=$Source ingress=$ingress event=$eventName notificationType=$notificationType reason=$skipReason"
        return [pscustomobject]@{ Skipped = $true; Reason = $skipReason }
    }
    $configPath = Join-Path $env:USERPROFILE ".agents\lark-notify.json"
    $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
    $sessionId = [string](Get-PropertyValue $Payload "session_id")
    $codexSessionName = if ($null -eq $codexSessionInfo) { "" } else { [string]$codexSessionInfo.SessionName }
    $sessionName = Get-SessionName -Payload $Payload -Source $Source -SessionId $sessionId -CodexSessionName $codexSessionName
    $cwd = [string](Get-PropertyValue $Payload "cwd")
    if ([string]::IsNullOrWhiteSpace($cwd))
    {
        $cwd = "Unknown"
    }
    $project = if ($cwd -eq "Unknown") { "Unknown" } else { Split-Path -Leaf $cwd }
    $summary = Get-EventSummary -Payload $Payload -EventName $eventName
    $summaryLength = [int](Get-PropertyValue $config "summaryLength")
    if ($summaryLength -lt 50)
    {
        $summaryLength = 300
    }
    if ($summary.Length -gt $summaryLength)
    {
        $summary = $summary.Substring(0, $summaryLength - 3) + "..."
    }
    $typeLine = if ([string]::IsNullOrWhiteSpace($notificationType)) { $eventName } else { "$eventName/$notificationType" }
    $presentation = Get-NotificationPresentation -Source $Source -EventName $eventName -NotificationType $notificationType
    $statistics = Get-TurnStatistics -Payload $Payload -Source $Source
    $primaryEventId = if ($Source -eq "claude") {
        [string](Get-PropertyValue $Payload "prompt_id")
    } else {
        [string](Get-PropertyValue $Payload "turn_id")
    }
    $keys = Get-IdempotencyKeys `
        -Source $Source `
        -SessionId $sessionId `
        -PrimaryEventId $primaryEventId `
        -LogicalTurnId ([string]$statistics.LogicalTurnId) `
        -TranscriptPath $transcriptPath `
        -EventName $eventName `
        -NotificationType $notificationType `
        -Summary $summary
    $timestamp = [DateTimeOffset]::Now
    $fallbackMessage = New-FallbackMessage `
        -Presentation $presentation `
        -SessionName $sessionName `
        -Project $project `
        -Directory $cwd `
        -EventType $typeLine `
        -Summary $summary `
        -Statistics $statistics `
        -Timestamp $timestamp
    $card = $null
    $cardJson = $null
    try
    {
        $card = New-NotificationCard `
            -Presentation $presentation `
            -Project $project `
            -Summary $summary `
            -Statistics $statistics `
            -SessionName $sessionName `
            -Directory $cwd `
            -EventType $typeLine `
            -Timestamp $timestamp
        Assert-NotificationCard $card
        $cardJson = $card | ConvertTo-Json -Compress -Depth 20
    }
    catch
    {
        Write-NotifyLog "Card construction failed: source=$Source ingress=$ingress event=$typeLine error=$($_.Exception.Message)"
    }
    if ($DryRun)
    {
        return [pscustomobject][ordered]@{
            Skipped = $false
            Source = $Source
            Event = $typeLine
            Status = [string]$presentation.Key
            CardIdempotencyKey = [string]$keys.Card
            FallbackIdempotencyKey = [string]$keys.Fallback
            Statistics = $statistics
            Card = $card
            FallbackText = $fallbackMessage
        }
    }
    $larkCli = Get-LarkCliPath
    if ([string]::IsNullOrWhiteSpace($larkCli))
    {
        Write-NotifyLog "Notification failed: global lark-cli binary was not found."
        return [pscustomobject]@{ Skipped = $false; State = "AmbiguousFailure" }
    }
    if ($null -eq $cardJson)
    {
        $fallbackResult = Invoke-LarkMessage -CliPath $larkCli -Config $config -MessageType text -Content $fallbackMessage -IdempotencyKey $keys.Fallback
        Save-NotificationBinding -Result $fallbackResult -Config $config -Source $Source -SessionId $sessionId -Payload $Payload
        Write-NotifyLog "Text fallback result: source=$Source ingress=$ingress event=$typeLine state=$($fallbackResult.State) detail=$($fallbackResult.Detail)"
        return [pscustomobject]@{ Skipped = $false; State = $fallbackResult.State }
    }
    $cardResult = Invoke-LarkMessage -CliPath $larkCli -Config $config -MessageType interactive -Content $cardJson -IdempotencyKey $keys.Card
    if ($cardResult.State -eq "Sent")
    {
        Save-NotificationBinding -Result $cardResult -Config $config -Source $Source -SessionId $sessionId -Payload $Payload
        Write-NotifyLog "Notification sent: source=$Source ingress=$ingress event=$typeLine project=$project"
        return [pscustomobject]@{ Skipped = $false; State = "Sent" }
    }
    Write-NotifyLog "Card send failed: source=$Source ingress=$ingress event=$typeLine state=$($cardResult.State) detail=$($cardResult.Detail)"
    if ($cardResult.State -ne "DefinitiveFailure")
    {
        return [pscustomobject]@{ Skipped = $false; State = $cardResult.State }
    }
    $fallbackResult = Invoke-LarkMessage -CliPath $larkCli -Config $config -MessageType text -Content $fallbackMessage -IdempotencyKey $keys.Fallback
    Save-NotificationBinding -Result $fallbackResult -Config $config -Source $Source -SessionId $sessionId -Payload $Payload
    Write-NotifyLog "Text fallback result: source=$Source ingress=$ingress event=$typeLine state=$($fallbackResult.State) detail=$($fallbackResult.Detail)"
    return [pscustomobject]@{ Skipped = $false; State = $fallbackResult.State }
}

if ($MyInvocation.InvocationName -eq ".")
{
    return
}

try
{
    $rawInput = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($rawInput))
    {
        throw "Hook input was empty."
    }
    $payload = $rawInput | ConvertFrom-Json
    $result = Invoke-LarkNotification -Payload $payload -Source $Source -DryRun:$DryRun
    if ($DryRun)
    {
        [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 30))
    }
    else
    {
        [Console]::Out.WriteLine("{}")
    }
}
catch
{
    Write-NotifyLog "Notification failed: $($_.Exception.Message)"
    [Console]::Out.WriteLine("{}")
}

# Both Codex and Claude accept an empty JSON result for observational hooks.
exit 0
