[CmdletBinding()]
param([switch]$ReplaceClaudeStatusLine, [switch]$SkipCodexValidation)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'TokenMeter.psm1') -Force

function Add-NotePropertyIfMissing([object]$Object,[string]$Name,[object]$Value) {
    if ($null -eq $Object.PSObject.Properties[$Name]) { $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value }
}
function Read-JsonObject([string]$Path) {
    if (Test-Path -LiteralPath $Path) { return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json }
    return [pscustomobject]@{}
}
function Write-AtomicText([string]$Path,[string]$Text) {
    [IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
    $temporary=$Path+'.'+[guid]::NewGuid().ToString('N')+'.tmp';$backup=$Path+'.'+[guid]::NewGuid().ToString('N')+'.replace-backup'
    [IO.File]::WriteAllText($temporary,$Text,[Text.UTF8Encoding]::new($false))
    try {
        if(Test-Path -LiteralPath $Path){try{Set-Acl -LiteralPath $temporary -AclObject (Get-Acl -LiteralPath $Path)}catch{};[IO.File]::Replace($temporary,$Path,$backup,$true)}else{[IO.File]::Move($temporary,$Path)}
    } finally {if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Force};if(Test-Path -LiteralPath $backup){Remove-Item -LiteralPath $backup -Force}}
}
function Set-CodexStatusLine([string]$Text) {
    if ($Text -match '(?m)^\s*\[\s*["'']tui["'']\s*\]' -or $Text -match '(?m)^\s*["'']?(?:tui\.)?status_line["'']?\s*=\s*\{') { throw 'Unsupported quoted or inline-table TUI syntax.' }
    $newline = if ($Text.Contains("`r`n")) { "`r`n" } else { "`n" }
    $lines = New-Object Collections.Generic.List[string]
    foreach ($line in ($Text -split '\r?\n')) { $lines.Add($line) }
    $target = "status_line = ['model-with-reasoning', 'context-remaining', 'current-dir']"
    $dotted = @(); $sectionTargets = @(); $tuiHeader = -1; $inTui = $false
    for ($i=0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^\s*\[([^]]+)\]\s*(?:#.*)?$') { $inTui = $matches[1].Trim() -eq 'tui'; if ($inTui) { if ($tuiHeader -ge 0) { throw 'Duplicate [tui] table.' }; $tuiHeader=$i }; continue }
        if ($lines[$i] -match '^\s*tui\.status_line\s*=') { $dotted += $i }
        if ($inTui -and $lines[$i] -match '^\s*status_line\s*=') { $sectionTargets += $i }
    }
    if (($dotted.Count + $sectionTargets.Count) -gt 1) { throw 'Duplicate tui.status_line definitions.' }
    if ($dotted.Count -eq 1) { $lines[$dotted[0]] = 'tui.' + $target }
    elseif ($sectionTargets.Count -eq 1) { $lines[$sectionTargets[0]] = $target }
    elseif ($tuiHeader -ge 0) { $lines.Insert($tuiHeader + 1, $target) }
    else { if ($lines.Count -gt 0 -and $lines[$lines.Count-1] -ne '') { $lines.Add('') }; $lines.Add('[tui]'); $lines.Add($target) }
    return (($lines -join $newline).TrimEnd("`r","`n") + $newline)
}
function Test-CodexConfig([string]$Candidate) {
    if ($SkipCodexValidation) { return }
    $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('token-meter-codex-' + [guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($tempRoot) | Out-Null
    try {
        [IO.File]::WriteAllText((Join-Path $tempRoot 'config.toml'), $Candidate, [Text.UTF8Encoding]::new($false))
        $codexCmd = (Get-Command codex.cmd -ErrorAction Stop).Source
        $info = New-Object Diagnostics.ProcessStartInfo
        $info.FileName = $env:ComSpec
        $info.Arguments = '/d /c ""' + $codexCmd + '" --strict-config doctor --json"'
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $true
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
        $info.EnvironmentVariables['CODEX_HOME'] = $tempRoot
        $process = New-Object Diagnostics.Process
        $process.StartInfo = $info
        [void]$process.Start()
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(15000)) {
            try { $process.Kill() } catch { }
            throw 'Codex config validation timed out.'
        }
        $output = $stdoutTask.Result
        [void]$stderrTask.Result
        $process.Dispose()
        $report = $output | ConvertFrom-Json
        if ([string]$report.checks.'config.load'.status -ne 'ok') { throw 'Codex rejected the candidate TOML.' }
    }
    finally {
        if ($tempRoot.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $tempRoot)) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
    }
}
function New-PortableScriptCommand([string]$FileName) {
    $script = "`$ProgressPreference='SilentlyContinue'`n`$scriptPath=[IO.Path]::Combine([Environment]::GetFolderPath('UserProfile'),'.agents','token-meter','$FileName')`n& `$scriptPath`nexit `$LASTEXITCODE"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
    return "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
}
function Test-TokenMeterScriptCommand([string]$Command,[string]$FileName) {
    if($Command -match '(?i)token-meter[\\/]+'+[regex]::Escape($FileName)){return $true}
    if($Command -notmatch '(?i)-EncodedCommand\s+([A-Za-z0-9+/=]+)'){return $false}
    try {
        $decoded=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($matches[1]))
        return $decoded -match "(?i)token-meter.*$([regex]::Escape($FileName))"
    } catch { return $false }
}

$paths = Initialize-TMDataDirectory
$profile = $paths.Profile
$claudeSettingsPath = Join-Path $profile '.claude\settings.json'
$codexHooksPath = Join-Path $profile '.codex\hooks.json'
$codexConfigPath = Join-Path $profile '.codex\config.toml'
$claudeCommand = New-PortableScriptCommand 'ClaudeTurnHook.ps1'
$codexCommand = New-PortableScriptCommand 'CodexTurnHook.ps1'
$statusCommand = New-PortableScriptCommand 'ClaudeStatusLine.ps1'
$isReinstall = Test-Path -LiteralPath $paths.Manifest
$manifest = if($isReinstall){$existing=Get-Content -Raw $paths.Manifest|ConvertFrom-Json;$copy=[ordered]@{};foreach($p in $existing.PSObject.Properties){$copy[$p.Name]=$p.Value};$copy}else{[ordered]@{schema_version=1;installed_at=[DateTimeOffset]::Now.ToString('o');claude_status_existed=$false;claude_status_previous=$null;claude_hook_added=$false;codex_hook_added=$false;codex_status_value="['model-with-reasoning', 'context-remaining', 'current-dir']"}}

$claude = Read-JsonObject $claudeSettingsPath
Add-NotePropertyIfMissing $claude 'hooks' ([pscustomobject]@{})
Add-NotePropertyIfMissing $claude.hooks 'Stop' @()
$claudeHookCommands = @($claude.hooks.Stop | ForEach-Object { @($_.hooks) })
$legacyClaudeHooks = @($claudeHookCommands | Where-Object { Test-TokenMeterScriptCommand ([string]$_.command) 'ClaudeTurnHook.ps1' -or [string]$_.command -match '(?i)token-meter[\\/]+Invoke-ClaudeTurnHook\.cmd' })
foreach($hook in $legacyClaudeHooks){$hook.command=$claudeCommand}
$claudeHasHook = @($claudeHookCommands | Where-Object { Test-TokenMeterScriptCommand ([string]$_.command) 'ClaudeTurnHook.ps1' -or [string]$_.command -match '(?i)token-meter[\\/]+Invoke-ClaudeTurnHook\.cmd' }).Count -gt 0
if (-not $claudeHasHook) {
    $entry = [pscustomobject]@{hooks=@([pscustomobject]@{type='command';command=$claudeCommand;timeout=10})}
    $claude.hooks.Stop = @($claude.hooks.Stop) + $entry
    $manifest.claude_hook_added = $true
}
if ($null -ne $claude.PSObject.Properties['statusLine']) {
    $statusIsOwned = Test-TokenMeterScriptCommand ([string]$claude.statusLine.command) 'ClaudeStatusLine.ps1' -or [string]$claude.statusLine.command -match '(?i)token-meter[\\/]+Invoke-ClaudeStatusLine\.cmd'
    if(-not $isReinstall -and -not $statusIsOwned){$manifest.claude_status_existed = $true; $manifest.claude_status_previous = $claude.statusLine}
    if (-not $statusIsOwned -and -not $ReplaceClaudeStatusLine) { throw 'Claude statusLine already exists. Re-run with -ReplaceClaudeStatusLine to replace it.' }
    $claude.statusLine = [pscustomobject]@{type='command';command=$statusCommand}
} else { $claude | Add-Member -NotePropertyName statusLine -NotePropertyValue ([pscustomobject]@{type='command';command=$statusCommand}) }
$configText = if (Test-Path -LiteralPath $codexConfigPath) { [IO.File]::ReadAllText($codexConfigPath) } else { '' }
$candidate = Set-CodexStatusLine $configText
Test-CodexConfig $candidate
Write-TMAtomicJson $claudeSettingsPath $claude

$codexHooks = Read-JsonObject $codexHooksPath
Add-NotePropertyIfMissing $codexHooks 'description' 'User-level notifications and lifecycle hooks.'
Add-NotePropertyIfMissing $codexHooks 'hooks' ([pscustomobject]@{})
Add-NotePropertyIfMissing $codexHooks.hooks 'Stop' @()
$codexHookCommands = @($codexHooks.hooks.Stop | ForEach-Object { @($_.hooks) })
$legacyCodexHooks = @($codexHookCommands | Where-Object { Test-TokenMeterScriptCommand ([string]$_.command) 'CodexTurnHook.ps1' -or [string]$_.command -match '(?i)token-meter[\\/]+Invoke-CodexTurnHook\.cmd' })
foreach($hook in $legacyCodexHooks){$hook.command=$codexCommand}
$codexHasHook = @($codexHookCommands | Where-Object { Test-TokenMeterScriptCommand ([string]$_.command) 'CodexTurnHook.ps1' -or [string]$_.command -match '(?i)token-meter[\\/]+Invoke-CodexTurnHook\.cmd' }).Count -gt 0
if (-not $codexHasHook) {
    $entry = [pscustomobject]@{hooks=@([pscustomobject]@{type='command';command=$codexCommand;timeout=10})}
    $codexHooks.hooks.Stop = @($codexHooks.hooks.Stop) + $entry
    $manifest.codex_hook_added = $true
}
Write-TMAtomicJson $codexHooksPath $codexHooks

Write-AtomicText $codexConfigPath $candidate
$manifest.installed_claude_status_hash = Get-TMHash ($claude.statusLine | ConvertTo-Json -Compress)
$manifest.installed_codex_config_hash = Get-TMHash $candidate
$manifest['state'] = 'configured_unverified'
$manifest['last_validated_at'] = [DateTimeOffset]::Now.ToString('o')
Write-TMAtomicJson $paths.Manifest $manifest

$claudeVersion = (& claude --version 2>$null) -join ' '
$codexVersion = (& codex --version 2>$null) -join ' '
[pscustomobject]@{Status='configured_unverified';Claude=$claudeVersion;Codex=$codexVersion;DataRoot=$paths.DataRoot;History=$paths.History} | Format-List
