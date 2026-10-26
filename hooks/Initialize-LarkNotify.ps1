[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [string]$UserProfilePath = $env:USERPROFILE,
    [string]$LocalAppDataPath = $env:LOCALAPPDATA,
    [string]$LarkCliPath
)

$ErrorActionPreference = "Stop"

function Get-LNProperty
{
    param([object]$InputObject, [string]$Name)

    if ($null -eq $InputObject) { return $null }
    if ($InputObject -is [System.Collections.IDictionary]) { return $InputObject[$Name] }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Set-LNProperty
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

function Remove-LNProperty
{
    param([object]$InputObject, [string]$Name)

    if ($null -ne $InputObject.PSObject.Properties[$Name])
    {
        $InputObject.PSObject.Properties.Remove($Name)
    }
}

function Get-LNSha256
{
    param([byte[]]$Bytes)

    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace("-", "") }
    finally { $sha.Dispose() }
}

function Protect-LNLogText
{
    param([string]$Text)

    if ([string]::IsNullOrWhiteSpace($Text)) { return "" }
    $safe = $Text -replace '(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+', '$1[REDACTED]'
    $safe = $safe -replace '(?i)\bsk-[A-Za-z0-9_-]{8,}\b', '[REDACTED]'
    $safe = $safe -replace '(?i)((?:api[_-]?key|token|secret|password|recipientOpenId)\s*[:=]\s*)\S+', '$1[REDACTED]'
    return ($safe -replace '\s+', ' ').Trim()
}

function Write-LNBootstrapLog
{
    param([string]$LocalRoot, [string]$Message)

    try
    {
        $directory = Join-Path $LocalRoot "lark-notify"
        [IO.Directory]::CreateDirectory($directory) | Out-Null
        $safe = Protect-LNLogText $Message
        if ($safe.Length -gt 800) { $safe = $safe.Substring(0, 800) }
        Add-Content -LiteralPath (Join-Path $directory "bootstrap.log") `
            -Value ("{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $safe) -Encoding UTF8
    }
    catch {}
}

function Resolve-LNLarkCli
{
    param([string]$RequestedPath, [string]$ProfilePath)

    if (-not [string]::IsNullOrWhiteSpace($RequestedPath) -and
        (Test-Path -LiteralPath $RequestedPath -PathType Leaf))
    {
        return [IO.Path]::GetFullPath($RequestedPath)
    }
    $roaming = if ($ProfilePath -eq $env:USERPROFILE) { $env:APPDATA } else { Join-Path $ProfilePath "AppData\Roaming" }
    $candidates = @(
        (Join-Path $roaming "npm\node_modules\@larksuite\cli\bin\lark-cli.exe"),
        (Join-Path $roaming "npm\lark-cli.ps1"),
        (Join-Path $roaming "npm\lark-cli.cmd")
    )
    $found = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if ($found) { return [IO.Path]::GetFullPath($found) }
    return $null
}

function Get-LNDecodedCommand
{
    param([string]$Command)

    $match = [regex]::Match($Command, '(?i)-(?:EncodedCommand|enc)\s+(?:"([^"]+)"|''([^'']+)''|(\S+))')
    if (-not $match.Success) { return $Command }
    $encoded = @($match.Groups[1].Value, $match.Groups[2].Value, $match.Groups[3].Value) |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 1
    try { return [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encoded)) }
    catch { return $Command }
}

function Test-LNOwnedCommand
{
    param([string]$Command, [string]$Source, [string]$NotifyScriptPath)

    if ([string]::IsNullOrWhiteSpace($Command)) { return $false }
    $decoded = Get-LNDecodedCommand $Command
    if ($decoded -notmatch "(?i)-Source\s+[`"']?$([regex]::Escape($Source))(?:[`"']?)(?:\s|$)") { return $false }
    $pathMatch = [regex]::Match(
        $decoded,
        '(?i)(?:"(?<path>[^"]*lark-notify\.ps1)"|''(?<path>[^'']*lark-notify\.ps1)''|(?<path>[^\s;&|]*lark-notify\.ps1))')
    if (-not $pathMatch.Success) { return $false }
    try
    {
        $candidate = [IO.Path]::GetFullPath($pathMatch.Groups['path'].Value)
        $expected = [IO.Path]::GetFullPath($NotifyScriptPath)
        return [string]::Equals($candidate, $expected, [StringComparison]::OrdinalIgnoreCase)
    }
    catch { return $false }
}

function New-LNCanonicalCommand
{
    param([string]$NotifyScriptPath, [string]$Source)

    $escaped = $NotifyScriptPath.Replace('"', '\"')
    if ($Source -eq "codex")
    {
        return "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$escaped`" -Source codex"
    }
    return "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$escaped`" -Source $Source"
}

function New-LNNoOpHook
{
    return [pscustomobject][ordered]@{
        type = "command"
        command = 'powershell.exe -NoLogo -NoProfile -NonInteractive -Command "exit 0"'
        timeout = 30
    }
}

function Set-LNCanonicalHook
{
    param(
        [object]$Entry,
        [object]$Hook,
        [string]$EventName,
        [string]$Source,
        [string]$NotifyScriptPath,
        [switch]$PreserveCommand
    )

    Set-LNProperty $Hook "type" "command"
    if (-not $PreserveCommand)
    {
        Set-LNProperty $Hook "command" (New-LNCanonicalCommand $NotifyScriptPath $Source)
    }
    Set-LNProperty $Hook "timeout" 30
    if ($EventName -eq "Notification")
    {
        Set-LNProperty $Hook "async" $true
        Set-LNProperty $Entry "matcher" "permission_prompt|idle_prompt|agent_needs_input"
    }
    else
    {
        Remove-LNProperty $Hook "async"
        Remove-LNProperty $Entry "matcher"
    }
}

function New-LNCanonicalEntry
{
    param([string]$EventName, [string]$Source, [string]$NotifyScriptPath)

    $entry = [pscustomobject][ordered]@{ hooks = @([pscustomobject][ordered]@{}) }
    Set-LNCanonicalHook $entry $entry.hooks[0] $EventName $Source $NotifyScriptPath
    return $entry
}

function Merge-LNEventHook
{
    param([object]$Document, [string]$EventName, [string]$Source, [string]$NotifyScriptPath)

    $changed = $false
    $hooksRoot = Get-LNProperty $Document "hooks"
    if ($null -eq $hooksRoot)
    {
        $hooksRoot = [pscustomobject][ordered]@{}
        Set-LNProperty $Document "hooks" $hooksRoot
        $changed = $true
    }
    $entriesValue = Get-LNProperty $hooksRoot $EventName
    [object[]]$entries = if ($null -eq $entriesValue) { @() } else { @($entriesValue) }
    $owned = [Collections.Generic.List[object]]::new()
    for ($entryIndex = 0; $entryIndex -lt $entries.Count; $entryIndex++)
    {
        $entry = $entries[$entryIndex]
        [object[]]$entryHooks = @(Get-LNProperty $entry "hooks")
        for ($hookIndex = 0; $hookIndex -lt $entryHooks.Count; $hookIndex++)
        {
            $command = [string](Get-LNProperty $entryHooks[$hookIndex] "command")
            if (Test-LNOwnedCommand $command $Source $NotifyScriptPath)
            {
                $owned.Add([pscustomobject]@{
                    EntryIndex = $entryIndex
                    HookIndex = $hookIndex
                    Entry = $entry
                    Hook = $entryHooks[$hookIndex]
                    IsSole = $entryHooks.Count -eq 1
                })
            }
        }
    }

    $primary = $owned | Where-Object { $_.IsSole } | Select-Object -First 1
    if ($null -ne $primary)
    {
        $before = $primary.Entry | ConvertTo-Json -Compress -Depth 30
        Set-LNCanonicalHook `
            $primary.Entry `
            $primary.Hook `
            $EventName `
            $Source `
            $NotifyScriptPath `
            -PreserveCommand:($owned.Count -eq 1)
        if (($primary.Entry | ConvertTo-Json -Compress -Depth 30) -cne $before) { $changed = $true }
    }
    else
    {
        $entries += New-LNCanonicalEntry $EventName $Source $NotifyScriptPath
        $changed = $true
    }

    foreach ($record in $owned)
    {
        if ($null -ne $primary -and
            $record.EntryIndex -eq $primary.EntryIndex -and
            $record.HookIndex -eq $primary.HookIndex)
        {
            continue
        }
        [object[]]$entryHooks = @(Get-LNProperty $record.Entry "hooks")
        $entryHooks[$record.HookIndex] = New-LNNoOpHook
        Set-LNProperty $record.Entry "hooks" $entryHooks
        $changed = $true
    }

    if ($null -eq $entriesValue -or $changed)
    {
        Set-LNProperty $hooksRoot $EventName @($entries)
    }
    return $changed
}

function Merge-LNClaudeConfig
{
    param([object]$Document, [string]$NotifyScriptPath)

    $changed = $false
    foreach ($eventName in @("Stop", "StopFailure", "Notification"))
    {
        if (Merge-LNEventHook $Document $eventName "claude" $NotifyScriptPath) { $changed = $true }
    }
    return $changed
}

function Merge-LNCodexConfig
{
    param([object]$Document, [string]$NotifyScriptPath)

    $hooksRoot = Get-LNProperty $Document "hooks"
    if ($null -eq $hooksRoot) { return $false }
    $entriesValue = Get-LNProperty $hooksRoot "Stop"
    if ($null -eq $entriesValue) { return $false }
    [object[]]$entries = @($entriesValue)
    $changed = $false
    foreach ($entry in $entries)
    {
        [object[]]$entryHooks = @(Get-LNProperty $entry "hooks")
        for ($hookIndex = 0; $hookIndex -lt $entryHooks.Count; $hookIndex++)
        {
            $command = [string](Get-LNProperty $entryHooks[$hookIndex] "command")
            if (Test-LNOwnedCommand $command "codex" $NotifyScriptPath)
            {
                $entryHooks[$hookIndex] = New-LNNoOpHook
                $changed = $true
            }
        }
        if ($changed) { Set-LNProperty $entry "hooks" @($entryHooks) }
    }
    if ($changed) { Set-LNProperty $hooksRoot "Stop" @($entries) }
    return $changed
}

function Test-LNJsonFile
{
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    try { [void]((Get-Content -Raw -LiteralPath $Path) | ConvertFrom-Json); return $true }
    catch { return $false }
}

function Set-LNRestrictedAcl
{
    param([string]$Path)

    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $security = [Security.AccessControl.FileSecurity]::new()
    $security.SetOwner($currentSid)
    $security.SetAccessRuleProtection($true, $false)
    foreach ($sidValue in @($currentSid.Value, "S-1-5-18", "S-1-5-32-544"))
    {
        $sid = [Security.Principal.SecurityIdentifier]::new($sidValue)
        $rule = [Security.AccessControl.FileSystemAccessRule]::new(
            $sid,
            [Security.AccessControl.FileSystemRights]::FullControl,
            [Security.AccessControl.AccessControlType]::Allow)
        $security.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $security
}

function Copy-LNAcl
{
    param([string]$SourcePath, [string]$DestinationPath)
    Set-Acl -LiteralPath $DestinationPath -AclObject (Get-Acl -LiteralPath $SourcePath)
}

function Update-LNJsonFile
{
    param(
        [string]$Path,
        [scriptblock]$Merge,
        [switch]$CheckOnly,
        [scriptblock]$BeforeReplace
    )

    $parent = Split-Path -Parent $Path
    $tempPath = "$Path.lark-notify.bootstrap.tmp"
    $backupPath = "$Path.lark-notify.bootstrap.bak"
    [IO.Directory]::CreateDirectory($parent) | Out-Null

    if (Test-Path -LiteralPath $tempPath)
    {
        if (Test-LNJsonFile $Path)
        {
            Remove-Item -LiteralPath $tempPath -Force
        }
        else
        {
            throw "Recovery required: target or missing target is invalid while a stale temp exists: target=$Path temp=$tempPath backup=$backupPath"
        }
    }

    for ($attempt = 1; $attempt -le 3; $attempt++)
    {
        $exists = Test-Path -LiteralPath $Path -PathType Leaf
        if ($exists)
        {
            $originalBytes = [IO.File]::ReadAllBytes($Path)
            $originalHash = Get-LNSha256 $originalBytes
            try { $document = ([Text.Encoding]::UTF8.GetString($originalBytes).TrimStart([char]0xFEFF)) | ConvertFrom-Json }
            catch { throw "Invalid JSON: $Path ($($_.Exception.Message))" }
        }
        else
        {
            $originalHash = $null
            $document = [pscustomobject][ordered]@{}
        }

        $changed = [bool](& $Merge $document)
        if (-not $changed)
        {
            return [pscustomobject]@{ Path = $Path; Changed = $false; WouldChange = $false; Created = $false }
        }
        if ($CheckOnly)
        {
            return [pscustomobject]@{ Path = $Path; Changed = $false; WouldChange = $true; Created = -not $exists }
        }

        $json = $document | ConvertTo-Json -Depth 100
        try
        {
            [IO.File]::WriteAllText($tempPath, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
            [void]((Get-Content -Raw -LiteralPath $tempPath) | ConvertFrom-Json)
            if ($exists) { Copy-LNAcl $Path $tempPath } else { Set-LNRestrictedAcl $tempPath }

            if ($null -ne $BeforeReplace) { & $BeforeReplace $Path $attempt }

            $currentExists = Test-Path -LiteralPath $Path -PathType Leaf
            $currentHash = if ($currentExists) { Get-LNSha256 ([IO.File]::ReadAllBytes($Path)) } else { $null }
            if ($currentExists -ne $exists -or $currentHash -cne $originalHash)
            {
                Remove-Item -LiteralPath $tempPath -Force
                if ($attempt -eq 3) { throw "Concurrent edits prevented bootstrap update after 3 attempts: $Path" }
                continue
            }

            if ($exists)
            {
                if (Test-Path -LiteralPath $backupPath) { Remove-Item -LiteralPath $backupPath -Force }
                [IO.File]::Replace($tempPath, $Path, $backupPath, $true)
                Copy-LNAcl $Path $backupPath
            }
            else
            {
                [IO.File]::Move($tempPath, $Path)
            }
            return [pscustomobject]@{ Path = $Path; Changed = $true; WouldChange = $true; Created = -not $exists }
        }
        catch
        {
            if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue }
            throw
        }
    }
}

function ConvertFrom-LNTomlStringArray
{
    param([string]$Value)

    $text = $Value.Trim()
    if ($text.Length -lt 2 -or $text[0] -ne '[' -or $text[$text.Length - 1] -ne ']')
    {
        throw "notify must be a TOML string array."
    }
    $items = [Collections.Generic.List[string]]::new()
    $index = 1
    while ($index -lt $text.Length - 1)
    {
        while ($index -lt $text.Length - 1 -and [char]::IsWhiteSpace($text[$index])) { $index++ }
        if ($index -ge $text.Length - 1) { break }
        if ($items.Count -gt 0)
        {
            if ($text[$index] -ne ',') { throw "notify contains an invalid array separator." }
            $index++
            while ($index -lt $text.Length - 1 -and [char]::IsWhiteSpace($text[$index])) { $index++ }
        }
        if ($index -ge $text.Length - 1) { break }
        $quote = $text[$index]
        if ($quote -notin @([char]34, [char]39)) { throw "notify contains a non-string value." }
        $start = $index
        $index++
        $escaped = $false
        while ($index -lt $text.Length - 1)
        {
            $character = $text[$index]
            if ($quote -eq [char]34 -and -not $escaped -and $character -eq [char]92)
            {
                $escaped = $true
                $index++
                continue
            }
            if (-not $escaped -and $character -eq $quote) { break }
            $escaped = $false
            $index++
        }
        if ($index -ge $text.Length - 1 -or $text[$index] -ne $quote) { throw "notify contains an unterminated string." }
        $token = $text.Substring($start, $index - $start + 1)
        if ($quote -eq [char]34)
        {
            try { $items.Add([string]($token | ConvertFrom-Json)) }
            catch { throw "notify contains an invalid basic string." }
        }
        else
        {
            $items.Add($token.Substring(1, $token.Length - 2))
        }
        $index++
    }
    if ($items.Count -eq 0) { throw "notify must not be empty." }
    return $items.ToArray()
}

function Get-LNTomlNotifyInfo
{
    param([string]$Text)

    $firstTable = [regex]::Match($Text, '(?m)^[ \t]*\[')
    $prefixLength = if ($firstTable.Success) { $firstTable.Index } else { $Text.Length }
    $prefix = $Text.Substring(0, $prefixLength)
    $lineMatches = [regex]::Matches($prefix, '(?m)^[ \t]*notify[ \t]*=[^\r\n]*(?:\r?\n|$)')
    if ($lineMatches.Count -gt 1) { throw "config.toml contains duplicate top-level notify keys." }
    if ($lineMatches.Count -eq 0)
    {
        return [pscustomobject]@{ Exists = $false; Command = @(); Start = $prefixLength; Length = 0 }
    }
    $lineMatch = $lineMatches[0]
    $line = $lineMatch.Value.TrimEnd("`r", "`n")
    $valueMatch = [regex]::Match(
        $line,
        '^[ \t]*notify[ \t]*=[ \t]*(?<value>\[(?:[^\]"'']|"(?:\\.|[^"\\])*"|''[^'']*'')*\])[ \t]*(?:#.*)?$')
    if (-not $valueMatch.Success) { throw "Unsupported top-level notify syntax in config.toml." }
    $command = @(ConvertFrom-LNTomlStringArray $valueMatch.Groups['value'].Value)
    return [pscustomobject]@{
        Exists = $true
        Command = $command
        Start = $lineMatch.Index
        Length = $lineMatch.Length
    }
}

function Test-LNPathWithinRoot
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

function Test-LNOfficialNativeNotify
{
    param([string[]]$Command, [string]$LocalRoot)
    if ($Command.Count -lt 2 -or $Command[1] -cne "turn-ended") { return $false }
    if ([IO.Path]::GetFileName($Command[0]) -cne "codex-computer-use.exe") { return $false }
    $trustedRoot = Join-Path $LocalRoot "OpenAI\Codex\runtimes\cua_node"
    return (Test-LNPathWithinRoot $Command[0] $trustedRoot) -and
        (Test-Path -LiteralPath $Command[0] -PathType Leaf)
}

function Test-LNOfficialCodexNotify
{
    param([string[]]$Command, [string]$LocalRoot)
    return $Command.Count -eq 2 -and (Test-LNOfficialNativeNotify $Command $LocalRoot)
}

function Test-LNChainedCodexNotify
{
    param([string[]]$Command, [string]$LocalRoot, [string]$BridgePath)
    if ($Command.Count -ne 4 -or $Command[2] -cne "--previous-notify") { return $false }
    if (-not (Test-LNOfficialNativeNotify $Command $LocalRoot)) { return $false }
    try { $previous = $Command[3] | ConvertFrom-Json }
    catch { return $false }
    if ($null -eq $previous) { return $false }
    return Test-LNCodexNotifyBridge ([string[]]@($previous)) $BridgePath
}

function Test-LNCodexNotifyBridge
{
    param([string[]]$Command, [string]$BridgePath)
    if ($Command.Count -lt 2) { return $false }
    $fileIndex = -1
    for ($index = 0; $index -lt $Command.Count - 1; $index++)
    {
        if ($Command[$index] -ieq "-File") { $fileIndex = $index; break }
    }
    if ($fileIndex -lt 0 -or $fileIndex + 1 -ge $Command.Count) { return $false }
    try
    {
        return [string]::Equals(
            [IO.Path]::GetFullPath($Command[$fileIndex + 1]),
            [IO.Path]::GetFullPath($BridgePath),
            [StringComparison]::OrdinalIgnoreCase)
    }
    catch { return $false }
}

function Find-LNLatestNativeNotify
{
    param([string]$LocalRoot)
    $trustedRoot = Join-Path $LocalRoot "OpenAI\Codex\runtimes\cua_node"
    if (-not (Test-Path -LiteralPath $trustedRoot -PathType Container)) { return @() }
    $matches = Get-ChildItem -LiteralPath $trustedRoot -Filter "codex-computer-use.exe" -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object {
            (Test-LNPathWithinRoot $_.FullName $trustedRoot) -and
            $_.FullName -match '(?i)[\\/]bin[\\/]node_modules[\\/]@oai[\\/]sky[\\/]bin[\\/]windows[\\/]codex-computer-use\.exe$'
        } |
        Sort-Object @{ Expression = { $_.LastWriteTimeUtc }; Descending = $true }, @{ Expression = { $_.FullName }; Descending = $true }
    $match = $matches | Select-Object -First 1
    if ($null -eq $match) { return @() }
    return @($match.FullName, "turn-ended")
}

function New-LNBridgeNotifyCommand
{
    param([string]$BridgePath)
    return @(
        "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive",
        "-ExecutionPolicy", "Bypass", "-File", $BridgePath
    )
}

function ConvertTo-LNTomlArray
{
    param([string[]]$Values)
    return ($Values | ConvertTo-Json -Compress)
}

function Update-LNTomlNotifyFile
{
    param(
        [string]$Path,
        [string]$BridgePath,
        [string]$LocalRoot,
        [switch]$CheckOnly,
        [scriptblock]$BeforeReplace
    )
    $parent = Split-Path -Parent $Path
    $tempPath = "$Path.lark-notify.bootstrap.tmp"
    $backupPath = "$Path.lark-notify.bootstrap.bak"
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    if (Test-Path -LiteralPath $tempPath)
    {
        try { [void](Get-LNTomlNotifyInfo ([IO.File]::ReadAllText($Path))); Remove-Item -LiteralPath $tempPath -Force }
        catch { throw "Recovery required: invalid TOML target while a stale temp exists: target=$Path temp=$tempPath backup=$backupPath" }
    }
    for ($attempt = 1; $attempt -le 3; $attempt++)
    {
        $exists = Test-Path -LiteralPath $Path -PathType Leaf
        $originalBytes = if ($exists) { [IO.File]::ReadAllBytes($Path) } else { [byte[]]@() }
        $originalHash = if ($exists) { Get-LNSha256 $originalBytes } else { $null }
        $hasBom = $originalBytes.Length -ge 3 -and $originalBytes[0] -eq 0xEF -and $originalBytes[1] -eq 0xBB -and $originalBytes[2] -eq 0xBF
        $text = if ($exists) { [Text.Encoding]::UTF8.GetString($originalBytes).TrimStart([char]0xFEFF) } else { "" }
        $info = Get-LNTomlNotifyInfo $text
        $isBridge = Test-LNCodexNotifyBridge $info.Command $BridgePath
        $isChained = Test-LNChainedCodexNotify $info.Command $LocalRoot $BridgePath
        if ($info.Exists -and ($isBridge -or $isChained))
        {
            $nativeCommand = if ($isChained) { @($info.Command[0], $info.Command[1]) } else { @() }
            return [pscustomobject]@{
                Path = $Path; Changed = $false; WouldChange = $false; Created = $false
                NativeCommand = $nativeCommand; Chained = $isChained
            }
        }
        if ($info.Exists -and -not (Test-LNOfficialCodexNotify $info.Command $LocalRoot))
        {
            throw "Refusing to overwrite unknown Codex notify command in $Path."
        }
        $nativeCommand = if ($info.Exists) { @($info.Command) } else { @(Find-LNLatestNativeNotify $LocalRoot) }
        if ($nativeCommand.Count -lt 2) { throw "Codex native notify command was not found under the trusted runtime root." }
        $desiredLine = "notify = " + (ConvertTo-LNTomlArray (New-LNBridgeNotifyCommand $BridgePath))
        $newline = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
        if ($info.Exists)
        {
            $oldLine = $text.Substring($info.Start, $info.Length)
            $lineEnding = if ($oldLine.EndsWith("`r`n")) { "`r`n" } elseif ($oldLine.EndsWith("`n")) { "`n" } else { "" }
            $candidate = $text.Substring(0, $info.Start) + $desiredLine + $lineEnding + $text.Substring($info.Start + $info.Length)
        }
        else
        {
            $insertion = $desiredLine + $newline
            if ($info.Start -gt 0 -and -not $text.Substring(0, $info.Start).EndsWith("`n")) { $insertion = $newline + $insertion }
            $candidate = $text.Substring(0, $info.Start) + $insertion + $text.Substring($info.Start)
        }
        [void](Get-LNTomlNotifyInfo $candidate)
        if ($CheckOnly)
        {
            return [pscustomobject]@{ Path = $Path; Changed = $false; WouldChange = $true; Created = -not $exists; NativeCommand = $nativeCommand; Chained = $false }
        }
        try
        {
            $encoding = [Text.UTF8Encoding]::new($hasBom)
            [IO.File]::WriteAllText($tempPath, $candidate, $encoding)
            [void](Get-LNTomlNotifyInfo ([IO.File]::ReadAllText($tempPath)))
            if ($exists) { Copy-LNAcl $Path $tempPath } else { Set-LNRestrictedAcl $tempPath }
            if ($null -ne $BeforeReplace) { & $BeforeReplace $Path $attempt }
            $currentExists = Test-Path -LiteralPath $Path -PathType Leaf
            $currentHash = if ($currentExists) { Get-LNSha256 ([IO.File]::ReadAllBytes($Path)) } else { $null }
            if ($currentExists -ne $exists -or $currentHash -cne $originalHash)
            {
                Remove-Item -LiteralPath $tempPath -Force
                if ($attempt -eq 3) { throw "Concurrent edits prevented bootstrap update after 3 attempts: $Path" }
                continue
            }
            if ($exists)
            {
                if (Test-Path -LiteralPath $backupPath) { Remove-Item -LiteralPath $backupPath -Force }
                [IO.File]::Replace($tempPath, $Path, $backupPath, $true)
                Copy-LNAcl $Path $backupPath
            }
            else { [IO.File]::Move($tempPath, $Path) }
            return [pscustomobject]@{ Path = $Path; Changed = $true; WouldChange = $true; Created = -not $exists; NativeCommand = $nativeCommand; Chained = $false }
        }
        catch
        {
            if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue }
            throw
        }
    }
}

function Update-LNNativeNotifyState
{
    param([string]$Path, [string[]]$Command, [switch]$CheckOnly, [scriptblock]$BeforeReplace)
    return Update-LNJsonFile -Path $Path -CheckOnly:$CheckOnly -BeforeReplace $BeforeReplace -Merge {
        param($document)
        [string[]]$existing = @(Get-LNProperty $document "command")
        if (($existing | ConvertTo-Json -Compress) -ceq ($Command | ConvertTo-Json -Compress)) { return $false }
        Set-LNProperty $document "command" @($Command)
        return $true
    }
}

function Restore-LNTomlSnapshot
{
    param(
        [string]$Path,
        [bool]$OriginalExists,
        [byte[]]$OriginalBytes,
        [string]$ExpectedCurrentHash
    )

    $currentExists = Test-Path -LiteralPath $Path -PathType Leaf
    if (-not $currentExists) { return -not $OriginalExists }
    $currentHash = Get-LNSha256 ([IO.File]::ReadAllBytes($Path))
    if ($currentHash -cne $ExpectedCurrentHash) { return $false }
    if (-not $OriginalExists)
    {
        Remove-Item -LiteralPath $Path -Force
        return $true
    }

    $tempPath = "$Path.lark-notify.rollback.tmp"
    $backupPath = "$Path.lark-notify.rollback.bak"
    try
    {
        [IO.File]::WriteAllBytes($tempPath, $OriginalBytes)
        [void](Get-LNTomlNotifyInfo ([IO.File]::ReadAllText($tempPath)))
        Copy-LNAcl $Path $tempPath
        if (Test-Path -LiteralPath $backupPath) { Remove-Item -LiteralPath $backupPath -Force }
        [IO.File]::Replace($tempPath, $Path, $backupPath, $true)
        Copy-LNAcl $Path $backupPath
        return $true
    }
    finally
    {
        if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue }
    }
}

function Invoke-LarkNotifyBootstrap
{
    [CmdletBinding()]
    param(
        [switch]$CheckOnly,
        [string]$UserProfilePath = $env:USERPROFILE,
        [string]$LocalAppDataPath = $env:LOCALAPPDATA,
        [string]$LarkCliPath,
        [scriptblock]$BeforeReplace
    )

    $notifyScript = Join-Path $UserProfilePath ".agents\hooks\lark-notify.ps1"
    $bridgeScript = Join-Path $UserProfilePath ".agents\hooks\Invoke-CodexNotifyBridge.ps1"
    $notifyConfig = Join-Path $UserProfilePath ".agents\lark-notify.json"
    if (-not (Test-Path -LiteralPath $notifyScript -PathType Leaf)) { throw "Notification script not found: $notifyScript" }
    if (-not (Test-Path -LiteralPath $bridgeScript -PathType Leaf)) { throw "Codex notify bridge not found: $bridgeScript" }
    if (-not (Test-Path -LiteralPath $notifyConfig -PathType Leaf)) { throw "Notification config not found: $notifyConfig" }
    try { $config = Get-Content -Raw -LiteralPath $notifyConfig | ConvertFrom-Json }
    catch { throw "Invalid notification config JSON: $notifyConfig" }
    $recipient = [string](Get-LNProperty $config "recipientOpenId")
    $identity = [string](Get-LNProperty $config "identity")
    if ([string]::IsNullOrWhiteSpace($recipient)) { throw "Notification config recipientOpenId is missing." }
    if ($identity -notin @("bot", "user")) { throw "Notification config identity must be bot or user." }
    $resolvedCli = Resolve-LNLarkCli $LarkCliPath $UserProfilePath
    if ([string]::IsNullOrWhiteSpace($resolvedCli)) { throw "lark-cli was not found." }

    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $mutexHash = Get-LNSha256 ([Text.Encoding]::UTF8.GetBytes($sid))
    $mutex = [Threading.Mutex]::new($false, "Local\LarkNotifyBootstrap-$($mutexHash.Substring(0, 16))")
    $acquired = $false
    try
    {
        try { $acquired = $mutex.WaitOne([TimeSpan]::FromSeconds(30)) }
        catch [Threading.AbandonedMutexException] { $acquired = $true }
        if (-not $acquired) { throw "Another bootstrap instance did not finish within 30 seconds." }

        $claudePath = Join-Path $UserProfilePath ".claude\settings.json"
        $codexPath = Join-Path $UserProfilePath ".codex\hooks.json"
        $codexTomlPath = Join-Path $UserProfilePath ".codex\config.toml"
        $nativeStatePath = Join-Path $LocalAppDataPath "lark-notify\codex-native-notify.json"
        $claudeResult = Update-LNJsonFile -Path $claudePath -CheckOnly:$CheckOnly -BeforeReplace $BeforeReplace -Merge {
            param($document)
            Merge-LNClaudeConfig $document $notifyScript
        }
        $tomlPlan = Update-LNTomlNotifyFile `
            -Path $codexTomlPath `
            -BridgePath $bridgeScript `
            -LocalRoot $LocalAppDataPath `
            -CheckOnly `
            -BeforeReplace $BeforeReplace
        $nativeCommand = if ($tomlPlan.NativeCommand.Count -ge 2) {
            @($tomlPlan.NativeCommand)
        } else {
            @(Find-LNLatestNativeNotify $LocalAppDataPath)
        }
        if ($nativeCommand.Count -lt 2) { throw "Codex native notify command is unavailable." }
        $nativeStateResult = Update-LNNativeNotifyState `
            -Path $nativeStatePath `
            -Command $nativeCommand `
            -CheckOnly:$CheckOnly `
            -BeforeReplace $BeforeReplace
        $tomlBeforeExists = Test-Path -LiteralPath $codexTomlPath -PathType Leaf
        [byte[]]$tomlBeforeBytes = if ($tomlBeforeExists) { [IO.File]::ReadAllBytes($codexTomlPath) } else { [byte[]]@() }
        $tomlResult = if ($CheckOnly) {
            $tomlPlan
        } else {
            Update-LNTomlNotifyFile `
                -Path $codexTomlPath `
                -BridgePath $bridgeScript `
                -LocalRoot $LocalAppDataPath `
                -BeforeReplace $BeforeReplace
        }
        $tomlWrittenHash = if (-not $CheckOnly -and $tomlResult.Changed) {
            Get-LNSha256 ([IO.File]::ReadAllBytes($codexTomlPath))
        } else { "" }
        $codexResult = [pscustomobject]@{ Path = $codexPath; Changed = $false; WouldChange = $false; Created = $false }
        if (Test-Path -LiteralPath $codexPath -PathType Leaf)
        {
            try
            {
                $codexResult = Update-LNJsonFile -Path $codexPath -CheckOnly:$CheckOnly -BeforeReplace $BeforeReplace -Merge {
                    param($document)
                    Merge-LNCodexConfig $document $notifyScript
                }
            }
            catch
            {
                $rollbackState = "not-required"
                if (-not $CheckOnly -and $tomlResult.Changed)
                {
                    try
                    {
                        $rolledBack = Restore-LNTomlSnapshot `
                            -Path $codexTomlPath `
                            -OriginalExists $tomlBeforeExists `
                            -OriginalBytes $tomlBeforeBytes `
                            -ExpectedCurrentHash $tomlWrittenHash
                        $rollbackState = if ($rolledBack) { "completed" } else { "skipped-concurrent-change" }
                    }
                    catch { $rollbackState = "failed: $($_.Exception.Message)" }
                }
                throw "Codex hook migration failed; TOML rollback=$rollbackState. $($_.Exception.Message)"
            }
        }
        $requiresTrust = [bool]($codexResult.Changed -or $codexResult.WouldChange -or
            $tomlResult.Changed -or $tomlResult.WouldChange)
        $summary = [pscustomobject][ordered]@{
            Healthy = if ($CheckOnly) {
                -not ($claudeResult.WouldChange -or $codexResult.WouldChange -or
                    $tomlResult.WouldChange -or $nativeStateResult.WouldChange)
            } else {
                $true
            }
            CheckOnly = [bool]$CheckOnly
            ClaudeChanged = [bool]$claudeResult.Changed
            CodexChanged = [bool]$codexResult.Changed
            CodexNotifyChanged = [bool]$tomlResult.Changed
            CodexNotifyChained = [bool]$tomlResult.Chained
            NativeNotifyChanged = [bool]$nativeStateResult.Changed
            RequiresCodexTrustConfirmation = $requiresTrust
            LarkCli = $resolvedCli
        }
        Write-LNBootstrapLog $LocalAppDataPath (
            "Bootstrap complete: checkOnly=$([bool]$CheckOnly) claudeChanged=$($summary.ClaudeChanged) " +
            "codexChanged=$($summary.CodexChanged) codexNotifyChanged=$($summary.CodexNotifyChanged) " +
            "codexNotifyChained=$($summary.CodexNotifyChained) nativeNotifyChanged=$($summary.NativeNotifyChanged) requiresCodexTrust=$requiresTrust")
        return $summary
    }
    finally
    {
        if ($acquired) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

if ($MyInvocation.InvocationName -ne '.')
{
    try
    {
        $result = Invoke-LarkNotifyBootstrap `
            -CheckOnly:$CheckOnly `
            -UserProfilePath $UserProfilePath `
            -LocalAppDataPath $LocalAppDataPath `
            -LarkCliPath $LarkCliPath
        $result | ConvertTo-Json -Compress
        if ($CheckOnly -and -not $result.Healthy) { exit 2 }
        exit 0
    }
    catch
    {
        Write-LNBootstrapLog $LocalAppDataPath "Bootstrap failed: $($_.Exception.Message)"
        [Console]::Error.WriteLine($_.Exception.Message)
        exit 1
    }
}
