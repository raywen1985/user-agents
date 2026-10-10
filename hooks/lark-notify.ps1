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
    param(
        [object]$InputObject,
        [string]$Name
    )

    if ($null -eq $InputObject)
    {
        return $null
    }

    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property)
    {
        return $null
    }

    return $property.Value
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

function Get-EventSummary
{
    param(
        [object]$Payload,
        [string]$EventName
    )

    $summary = ""
    switch ($EventName)
    {
        "Stop" {
            $summary = [string](Get-PropertyValue $Payload "last_assistant_message")
        }
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
        default {
            $summary = [string](Get-PropertyValue $Payload "last_assistant_message")
        }
    }

    if ([string]::IsNullOrWhiteSpace($summary))
    {
        return "No additional summary was provided."
    }

    return Protect-Text $summary
}

function Get-Sha256Text
{
    param([string]$Text)

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

        $trimChars = [char[]]@(
            [System.IO.Path]::DirectorySeparatorChar,
            [System.IO.Path]::AltDirectorySeparatorChar
        )
        return [System.IO.Path]::GetFullPath($candidate).TrimEnd($trimChars)
    }
    catch
    {
        return $null
    }
}

function Test-PathWithinRoot
{
    param(
        [string]$Path,
        [string]$Root
    )

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

    $rootPrefix = $normalizedRoot + [System.IO.Path]::DirectorySeparatorChar
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
    param(
        [string]$SessionId,
        [string]$CodexHome
    )

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
    param(
        [string]$TranscriptPath,
        [string]$SessionId,
        [string]$CodexHome
    )

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
    param(
        [object]$Payload,
        [string]$Source,
        [string]$SessionId,
        [string]$CodexSessionName
    )

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
        if (-not [string]::IsNullOrWhiteSpace($transcriptPath) -and (Test-Path -LiteralPath $transcriptPath))
        {
            foreach ($line in [System.IO.File]::ReadLines($transcriptPath))
            {
                try
                {
                    $entry = $line | ConvertFrom-Json
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
                catch
                {
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
    param(
        [string]$Source,
        [string]$EventName,
        [string]$NotificationType,
        [object]$CodexSessionInfo
    )

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

try
{
    $rawInput = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($rawInput))
    {
        throw "Hook input was empty."
    }

    $payload = $rawInput | ConvertFrom-Json

    $eventName = [string](Get-PropertyValue $payload "hook_event_name")
    if ([string]::IsNullOrWhiteSpace($eventName))
    {
        $eventName = "Unknown"
    }

    $notificationType = [string](Get-PropertyValue $payload "notification_type")
    $codexSessionInfo = if ($Source -eq "codex" -and $eventName -in @("Stop", "StopFailure")) {
        Get-CodexSessionInfo -Payload $payload
    } else {
        $null
    }
    if (-not (Test-ShouldNotify -Source $Source -EventName $eventName -NotificationType $notificationType -CodexSessionInfo $codexSessionInfo))
    {
        $skipReason = if ($null -eq $codexSessionInfo) { "event-filter" } else { $codexSessionInfo.Reason }
        Write-NotifyLog "Notification skipped: source=$Source event=$eventName notificationType=$notificationType reason=$skipReason"
        [Console]::Out.WriteLine("{}")
        exit 0
    }

    $configPath = Join-Path $env:USERPROFILE ".agents\lark-notify.json"
    $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json

    $sessionId = [string](Get-PropertyValue $payload "session_id")
    $codexSessionName = if ($null -eq $codexSessionInfo) { "" } else { [string]$codexSessionInfo.SessionName }
    $sessionName = Get-SessionName -Payload $payload -Source $Source -SessionId $sessionId -CodexSessionName $codexSessionName
    $cwd = [string](Get-PropertyValue $payload "cwd")
    if ([string]::IsNullOrWhiteSpace($cwd))
    {
        $cwd = "Unknown"
    }

    $project = if ($cwd -eq "Unknown") { "Unknown" } else { Split-Path -Leaf $cwd }
    $summary = Get-EventSummary -Payload $payload -EventName $eventName
    $summaryLength = [int]$config.summaryLength
    if ($summaryLength -lt 50)
    {
        $summaryLength = 300
    }
    if ($summary.Length -gt $summaryLength)
    {
        $summary = $summary.Substring(0, $summaryLength - 3) + "..."
    }

    $needsAction = $eventName -eq "Notification" -and
        $notificationType -match '^(permission_prompt|idle_prompt|agent_needs_input)$'
    $status = if ($needsAction) { "Needs your attention" } elseif ($eventName -eq "StopFailure") { "Turn failed" } else { "Turn finished" }
    $sourceName = if ($Source -eq "codex") { "Codex" } else { "Claude Code" }
    $typeLine = if ([string]::IsNullOrWhiteSpace($notificationType)) { $eventName } else { "$eventName/$notificationType" }

    $message = @(
        "[$sourceName] $status"
        "Session: $sessionName"
        "Project: $project"
        "Directory: $cwd"
        "Event: $typeLine"
        "Summary: $summary"
        "Time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
    ) -join "`n"

    if ($DryRun)
    {
        [Console]::Out.WriteLine($message)
        exit 0
    }

    $turnId = [string](Get-PropertyValue $payload "turn_id")
    $promptId = [string](Get-PropertyValue $payload "prompt_id")
    $eventId = if ($Source -eq "claude") { $promptId } else { $turnId }
    if ([string]::IsNullOrWhiteSpace($eventId))
    {
        $eventId = [guid]::NewGuid().ToString("N")
    }
    $seed = "$Source|$sessionId|$eventId|$eventName|$notificationType|$summary"
    $idempotencyKey = (Get-Sha256Text $seed).Substring(0, 40)

    $larkCliCandidates = @(
        (Join-Path $env:APPDATA "npm\node_modules\@larksuite\cli\bin\lark-cli.exe")
        (Join-Path $env:APPDATA "npm\lark-cli.cmd")
    )
    $larkCli = $larkCliCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ([string]::IsNullOrWhiteSpace($larkCli))
    {
        throw "Global lark-cli binary was not found."
    }

    $cliOutput = & $larkCli im +messages-send `
        --as ([string]$config.identity) `
        --user-id ([string]$config.recipientOpenId) `
        --text $message `
        --idempotency-key $idempotencyKey `
        --format json 2>&1

    if ($LASTEXITCODE -ne 0)
    {
        throw ($cliOutput | Out-String)
    }

    Write-NotifyLog "Notification sent: source=$Source event=$typeLine project=$project"
}
catch
{
    Write-NotifyLog "Notification failed: $($_.Exception.Message)"
}

# Both Codex and Claude accept an empty JSON result for observational hooks.
[Console]::Out.WriteLine("{}")
exit 0
