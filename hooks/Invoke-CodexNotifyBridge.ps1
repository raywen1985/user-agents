[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$PayloadJson,
    [string]$UserProfilePath = $env:USERPROFILE,
    [string]$LocalAppDataPath = $env:LOCALAPPDATA,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function Get-CNBProperty
{
    param([object]$InputObject, [string]$Name)
    if ($null -eq $InputObject) { return $null }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Set-CNBProperty
{
    param([object]$InputObject, [string]$Name, [object]$Value)
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) { $InputObject | Add-Member -NotePropertyName $Name -NotePropertyValue $Value }
    else { $property.Value = $Value }
}

function Protect-CNBLogText
{
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return "" }
    $safe = $Text -replace '(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+', '$1[REDACTED]'
    $safe = $safe -replace '(?i)\bsk-[A-Za-z0-9_-]{8,}\b', '[REDACTED]'
    $safe = $safe -replace '(?i)((?:api[_-]?key|token|secret|password|recipientOpenId)\s*[:=]\s*)\S+', '$1[REDACTED]'
    return ($safe -replace '\s+', ' ').Trim()
}

function Write-CNBLog
{
    param([string]$LocalRoot, [string]$Message)
    try
    {
        $directory = Join-Path $LocalRoot "lark-notify"
        [IO.Directory]::CreateDirectory($directory) | Out-Null
        $safe = Protect-CNBLogText $Message
        if ($safe.Length -gt 500) { $safe = $safe.Substring(0, 500) }
        Add-Content -LiteralPath (Join-Path $directory "notify.log") `
            -Value ("{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $safe) -Encoding UTF8
    }
    catch {}
}

function ConvertTo-CNBCommandLineArgument
{
    param([AllowEmptyString()][string]$Argument)
    if ([string]::IsNullOrEmpty($Argument)) { return '""' }
    if ($Argument -notmatch '[\s"]') { return $Argument }
    $builder = [Text.StringBuilder]::new()
    [void]$builder.Append('"')
    $slashes = 0
    foreach ($character in $Argument.ToCharArray())
    {
        if ($character -eq [char]92) { $slashes++; continue }
        if ($character -eq [char]34)
        {
            [void]$builder.Append(([string]::new([char]92, ($slashes * 2) + 1)))
            [void]$builder.Append([char]34)
            $slashes = 0
            continue
        }
        if ($slashes -gt 0)
        {
            [void]$builder.Append(([string]::new([char]92, $slashes)))
            $slashes = 0
        }
        [void]$builder.Append($character)
    }
    if ($slashes -gt 0) { [void]$builder.Append(([string]::new([char]92, $slashes * 2))) }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Test-CNBPathWithinRoot
{
    param([string]$Path, [string]$Root)
    try
    {
        $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
        $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
        return [string]::Equals($fullPath, $fullRoot, [StringComparison]::OrdinalIgnoreCase) -or
            $fullPath.StartsWith($fullRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
    }
    catch { return $false }
}

function Find-CNBSessionEvidence
{
    param([string]$CodexHome, [string]$ThreadId)
    if ([string]::IsNullOrWhiteSpace($ThreadId)) { return $null }
    $indexPath = Join-Path $CodexHome "session_index.jsonl"
    $delays = @(0, 100, 200, 400, 800, 1500)
    foreach ($delay in $delays)
    {
        if ($delay -gt 0) { Start-Sleep -Milliseconds $delay }
        if (Test-Path -LiteralPath $indexPath -PathType Leaf)
        {
            $stream = $null
            $reader = $null
            try
            {
                $stream = [IO.FileStream]::new(
                    $indexPath,
                    [IO.FileMode]::Open,
                    [IO.FileAccess]::Read,
                    ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
                )
                $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $true)
                while (-not $reader.EndOfStream)
                {
                    $line = $reader.ReadLine()
                    try
                    {
                        $entry = $line | ConvertFrom-Json
                        if ([string](Get-CNBProperty $entry "id") -eq $ThreadId)
                        {
                            return [pscustomobject]@{ Reason = "session-index"; TranscriptPath = "" }
                        }
                    }
                    catch {}
                }
            }
            catch {}
            finally
            {
                if ($null -ne $reader) { $reader.Dispose() }
                elseif ($null -ne $stream) { $stream.Dispose() }
            }
        }
    }
    $sessionsRoot = Join-Path $CodexHome "sessions"
    if (Test-Path -LiteralPath $sessionsRoot -PathType Container)
    {
        try
        {
            $match = Get-ChildItem -LiteralPath $sessionsRoot -Filter "*$ThreadId*.jsonl" -File -Recurse -ErrorAction Stop |
                Where-Object { Test-CNBPathWithinRoot $_.FullName $sessionsRoot } |
                Sort-Object LastWriteTimeUtc -Descending |
                Select-Object -First 1
            if ($null -ne $match)
            {
                return [pscustomobject]@{ Reason = "session-transcript"; TranscriptPath = $match.FullName }
            }
        }
        catch {}
    }
    return $null
}

function Resolve-CNBNativeCommand
{
    param([string]$LocalRoot)
    $statePath = Join-Path $LocalRoot "lark-notify\codex-native-notify.json"
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { return @() }
    try
    {
        $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
        [string[]]$command = @(Get-CNBProperty $state "command")
        if ($command.Count -lt 2 -or $command[1] -cne "turn-ended") { return @() }
        $trustedRoot = Join-Path $LocalRoot "OpenAI\Codex\runtimes\cua_node"
        if (-not (Test-CNBPathWithinRoot $command[0] $trustedRoot)) { return @() }
        if ([IO.Path]::GetFileName($command[0]) -cne "codex-computer-use.exe") { return @() }
        if (-not (Test-Path -LiteralPath $command[0] -PathType Leaf)) { return @() }
        return $command
    }
    catch { return @() }
}

function Start-CNBProcess
{
    param([string]$FilePath, [string[]]$Arguments, [AllowEmptyString()][string]$StandardInput)
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FilePath
    $startInfo.Arguments = (@($Arguments | ForEach-Object { ConvertTo-CNBCommandLineArgument ([string]$_) }) -join " ")
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.RedirectStandardInput = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw "Failed to start notification subprocess." }
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not [string]::IsNullOrEmpty($StandardInput)) { $process.StandardInput.Write($StandardInput) }
    $process.StandardInput.Close()
    return [pscustomobject]@{ Process = $process; Stdout = $stdout; Stderr = $stderr; Started = [DateTime]::UtcNow }
}

function Complete-CNBProcess
{
    param([object]$Handle, [int]$TimeoutSeconds)
    $elapsed = [int]([DateTime]::UtcNow - $Handle.Started).TotalMilliseconds
    $remaining = [Math]::Max(0, ($TimeoutSeconds * 1000) - $elapsed)
    $completed = $Handle.Process.WaitForExit($remaining)
    if (-not $completed)
    {
        try { & taskkill.exe /PID $Handle.Process.Id /T /F 2>$null | Out-Null } catch {}
        try { $Handle.Process.WaitForExit(2000) | Out-Null } catch {}
        $Handle.Process.Dispose()
        return [pscustomobject]@{ State = "TimedOut"; ExitCode = $null; Detail = "timeout=${TimeoutSeconds}s" }
    }
    $exitCode = $Handle.Process.ExitCode
    $detail = if ($exitCode -eq 0) { "" } else { [string]$Handle.Stderr.Result }
    $Handle.Process.Dispose()
    return [pscustomobject]@{ State = if ($exitCode -eq 0) { "Completed" } else { "Failed" }; ExitCode = $exitCode; Detail = $detail }
}

function ConvertTo-CNBLarkPayload
{
    param([object]$Notification, [object]$Evidence)
    return [pscustomobject][ordered]@{
        hook_event_name = "Stop"
        session_id = [string](Get-CNBProperty $Notification "thread-id")
        turn_id = [string](Get-CNBProperty $Notification "turn-id")
        cwd = [string](Get-CNBProperty $Notification "cwd")
        last_assistant_message = [string](Get-CNBProperty $Notification "last-assistant-message")
        transcript_path = [string]$Evidence.TranscriptPath
        lark_ingress = "codex-notify"
    }
}

function Invoke-CodexNotifyBridge
{
    param(
        [string]$PayloadJson,
        [string]$UserProfilePath,
        [string]$LocalAppDataPath,
        [switch]$DryRun
    )
    if ([string]::IsNullOrWhiteSpace($PayloadJson))
    {
        Write-CNBLog $LocalAppDataPath "Codex notify bridge skipped: empty payload"
        return [pscustomobject]@{ Skipped = $true; Reason = "empty-payload" }
    }
    try { $notification = $PayloadJson | ConvertFrom-Json }
    catch
    {
        Write-CNBLog $LocalAppDataPath "Codex notify bridge skipped: invalid JSON"
        return [pscustomobject]@{ Skipped = $true; Reason = "invalid-json" }
    }
    if ([string](Get-CNBProperty $notification "type") -cne "agent-turn-complete")
    {
        Write-CNBLog $LocalAppDataPath "Codex notify bridge skipped: unsupported event"
        return [pscustomobject]@{ Skipped = $true; Reason = "unsupported-event" }
    }
    $threadId = [string](Get-CNBProperty $notification "thread-id")
    $codexHome = Join-Path $UserProfilePath ".codex"
    $evidence = Find-CNBSessionEvidence -CodexHome $codexHome -ThreadId $threadId
    if ($null -eq $evidence)
    {
        Write-CNBLog $LocalAppDataPath "Codex notify bridge skipped: unpersisted session"
        return [pscustomobject]@{ Skipped = $true; Reason = "unpersisted-codex-session" }
    }
    $larkPayload = ConvertTo-CNBLarkPayload $notification $evidence
    $larkPayloadJson = $larkPayload | ConvertTo-Json -Compress -Depth 20
    $nativeCommand = @(Resolve-CNBNativeCommand $LocalAppDataPath)
    $notifyScript = Join-Path $UserProfilePath ".agents\hooks\lark-notify.ps1"
    $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
    $larkArguments = @("-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $notifyScript, "-Source", "codex")
    if ($DryRun)
    {
        return [pscustomobject][ordered]@{
            Skipped = $false
            Evidence = $evidence.Reason
            LarkPayload = $larkPayload
            NativeCommand = $nativeCommand
            LarkCommand = @($powershell) + $larkArguments
        }
    }
    $nativeHandle = $null
    $larkHandle = $null
    try
    {
        if ($nativeCommand.Count -ge 2)
        {
            $nativeHandle = Start-CNBProcess -FilePath $nativeCommand[0] -Arguments (@($nativeCommand[1..($nativeCommand.Count - 1)]) + $PayloadJson) -StandardInput ""
        }
        if (Test-Path -LiteralPath $notifyScript -PathType Leaf)
        {
            $larkHandle = Start-CNBProcess -FilePath $powershell -Arguments $larkArguments -StandardInput $larkPayloadJson
        }
        $nativeResult = if ($null -eq $nativeHandle) { [pscustomobject]@{ State = "Unavailable"; Detail = "" } } else { Complete-CNBProcess $nativeHandle 10 }
        $larkResult = if ($null -eq $larkHandle) { [pscustomobject]@{ State = "Unavailable"; Detail = "" } } else { Complete-CNBProcess $larkHandle 30 }
        Write-CNBLog $LocalAppDataPath "Codex notify bridge complete: native=$($nativeResult.State) lark=$($larkResult.State) evidence=$($evidence.Reason)"
        return [pscustomobject]@{ Skipped = $false; Native = $nativeResult.State; Lark = $larkResult.State }
    }
    catch
    {
        Write-CNBLog $LocalAppDataPath "Codex notify bridge failed: $($_.Exception.Message)"
        return [pscustomobject]@{ Skipped = $false; Native = "Failed"; Lark = "Failed" }
    }
}

if ($MyInvocation.InvocationName -ne '.')
{
    try
    {
        $result = Invoke-CodexNotifyBridge -PayloadJson $PayloadJson -UserProfilePath $UserProfilePath -LocalAppDataPath $LocalAppDataPath -DryRun:$DryRun
        if ($DryRun) { [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 30)) }
        exit 0
    }
    catch
    {
        Write-CNBLog $LocalAppDataPath "Codex notify bridge failed: $($_.Exception.Message)"
        exit 0
    }
}
