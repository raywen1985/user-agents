[CmdletBinding()]
param(
    [switch]$Quiet,
    [switch]$SkipGatewayStart
)

$ErrorActionPreference = 'Stop'
$profileRoot = [Environment]::GetFolderPath('UserProfile')
$localRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ai-integration-repair'
$logPath = Join-Path $localRoot 'repair.log'

function Write-RepairLog {
    param([string]$Message)
    try {
        [IO.Directory]::CreateDirectory($localRoot) | Out-Null
        $safe = ($Message -replace '[\r\n]+', ' ').Trim()
        if ($safe.Length -gt 1000) { $safe = $safe.Substring(0, 1000) }
        [IO.File]::AppendAllText($logPath, ('{0} {1}{2}' -f [DateTimeOffset]::Now.ToString('o'), $safe, [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
    } catch { }
}

function Get-DecodedCommand {
    param([string]$Command)
    if ([string]::IsNullOrWhiteSpace($Command)) { return '' }
    $match = [regex]::Match($Command, '(?i)-EncodedCommand\s+(?:"([^"]+)"|''([^'']+)''|(\S+))')
    if (-not $match.Success) { return $Command }
    $encoded = @($match.Groups[1].Value, $match.Groups[2].Value, $match.Groups[3].Value) |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 1
    try { return [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encoded)) }
    catch { return $Command }
}

function Test-CommandTarget {
    param([string]$Command, [string]$FileName)
    return (Get-DecodedCommand $Command) -match ('(?i)' + [regex]::Escape($FileName))
}

function Read-JsonFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
}

function Test-TokenMeterConfiguration {
    foreach ($component in @('TokenMeter.psm1', 'ClaudeTurnHook.ps1', 'ClaudeStatusLine.ps1', 'CodexTurnHook.ps1')) {
        if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot "..\token-meter\$component") -PathType Leaf)) { return $false }
    }
    $claude = Read-JsonFile (Join-Path $profileRoot '.claude\settings.json')
    $codex = Read-JsonFile (Join-Path $profileRoot '.codex\hooks.json')
    if ($null -eq $claude -or $null -eq $codex) { return $false }
    $claudeStop = @($claude.hooks.Stop | ForEach-Object { @($_.hooks) })
    $codexStop = @($codex.hooks.Stop | ForEach-Object { @($_.hooks) })
    $hasClaudeTurn = @($claudeStop | Where-Object { Test-CommandTarget ([string]$_.command) 'ClaudeTurnHook.ps1' }).Count -eq 1
    $hasClaudeStatus = $null -ne $claude.statusLine -and (Test-CommandTarget ([string]$claude.statusLine.command) 'ClaudeStatusLine.ps1')
    $hasCodexTurn = @($codexStop | Where-Object { Test-CommandTarget ([string]$_.command) 'CodexTurnHook.ps1' }).Count -eq 1
    return $hasClaudeTurn -and $hasClaudeStatus -and $hasCodexTurn
}

function Test-LarkNotifyConfiguration {
    $notifyScript = Join-Path $profileRoot '.agents\hooks\lark-notify.ps1'
    $bridgeScript = Join-Path $profileRoot '.agents\hooks\Invoke-CodexNotifyBridge.ps1'
    $notifyConfig = Join-Path $profileRoot '.agents\lark-notify.json'
    $claude = Read-JsonFile (Join-Path $profileRoot '.claude\settings.json')
    $codexTomlPath = Join-Path $profileRoot '.codex\config.toml'
    $nativeState = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'lark-notify\codex-native-notify.json'
    if ($null -eq $claude -or -not (Test-Path -LiteralPath $notifyScript -PathType Leaf) -or
        -not (Test-Path -LiteralPath $bridgeScript -PathType Leaf) -or
        -not (Test-Path -LiteralPath $notifyConfig -PathType Leaf) -or
        -not (Test-Path -LiteralPath $codexTomlPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $nativeState -PathType Leaf)) { return $false }
    foreach ($eventName in @('Stop', 'StopFailure', 'Notification')) {
        $commands = @($claude.hooks.$eventName | ForEach-Object { @($_.hooks) } | Where-Object {
            (Get-DecodedCommand ([string]$_.command)) -match '(?i)lark-notify\.ps1' -and
            (Get-DecodedCommand ([string]$_.command)) -match '(?i)-Source\s+claude(?:\s|$)'
        })
        if ($commands.Count -ne 1) { return $false }
    }
    $toml = [IO.File]::ReadAllText($codexTomlPath)
    if ($toml -notmatch '(?i)Invoke-CodexNotifyBridge\.ps1') { return $false }
    try {
        $state = Get-Content -Raw -LiteralPath $nativeState | ConvertFrom-Json
        return @($state.command).Count -ge 2
    } catch { return $false }
}

function Invoke-ExternalScript {
    param([string]$Path, [string[]]$Arguments = @())
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Required script is missing: $Path" }
    $output = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Path @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "$(Split-Path -Leaf $Path) failed with exit code ${LASTEXITCODE}: $($output -join ' ')" }
    return @($output)
}

function Test-GatewayHealthy {
    $gatewayRoot = Join-Path $profileRoot '.agents\claude-projects\lark'
    $healthPath = Join-Path $gatewayRoot 'run\health.json'
    if (-not (Test-Path -LiteralPath $healthPath -PathType Leaf)) { return $false }
    try {
        $health = Get-Content -Raw -LiteralPath $healthPath | ConvertFrom-Json
        if ($health.listenerReady -ne $true -or $health.stopping -eq $true) { return $false }
        $process = Get-Process -Id ([int]$health.pid) -ErrorAction Stop
        if ($process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne [string]$health.procStart) { return $false }
        $updated = [DateTimeOffset]::Parse([string]$health.updatedAt)
        return ([DateTimeOffset]::UtcNow - $updated.ToUniversalTime()).TotalMinutes -lt 3
    } catch { return $false }
}

function Start-GatewayIfAvailable {
    if ($SkipGatewayStart -or (Test-GatewayHealthy)) { return $false }
    $task = Get-ScheduledTask -TaskName 'LarkClaudeGateway' -ErrorAction SilentlyContinue
    if ($null -eq $task) { throw 'Feishu remote gateway task LarkClaudeGateway is not installed.' }
    if ([string]$task.State -eq 'Disabled') { throw 'Feishu remote gateway task is disabled.' }
    if ([string]$task.State -eq 'Running') { throw 'Feishu remote gateway is running but its health state is stale or invalid; it was not restarted.' }
    Start-ScheduledTask -TaskName 'LarkClaudeGateway'
    return $true
}

$mutex = [Threading.Mutex]::new($false, 'Local\AIIntegrationRepair-v1')
$acquired = $false
$changed = New-Object Collections.Generic.List[string]
$warnings = New-Object Collections.Generic.List[string]
try {
    try { $acquired = $mutex.WaitOne([TimeSpan]::FromSeconds(20)) }
    catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { throw 'Another integration repair is still running.' }

    try {
        if (-not (Test-TokenMeterConfiguration)) {
            $installer = Join-Path $PSScriptRoot '..\token-meter\Install-TokenMeter.ps1'
            Invoke-ExternalScript $installer @('-SkipCodexValidation', '-SkipVersionProbe') | Out-Null
            if (-not (Test-TokenMeterConfiguration)) { throw 'Token Meter configuration is still incomplete after repair.' }
            $changed.Add('token-meter')
        }
    } catch { $warnings.Add($_.Exception.Message); Write-RepairLog $_.Exception.Message }

    try {
        if (-not (Test-LarkNotifyConfiguration)) {
            $notify = Join-Path $PSScriptRoot '..\hooks\Initialize-LarkNotify.ps1'
            $notifyOutput = Invoke-ExternalScript $notify
            $notifyResult = ($notifyOutput -join [Environment]::NewLine) | ConvertFrom-Json
            if (-not (Test-LarkNotifyConfiguration)) { throw 'Feishu notification configuration is still incomplete after repair.' }
            if ($notifyResult.ClaudeChanged -or $notifyResult.CodexChanged -or $notifyResult.CodexNotifyChanged -or $notifyResult.NativeNotifyChanged) {
                $changed.Add('lark-notify')
            }
        }
    } catch { $warnings.Add($_.Exception.Message); Write-RepairLog $_.Exception.Message }

    try {
        if (Start-GatewayIfAvailable) { $changed.Add('lark-gateway-start') }
    } catch { $warnings.Add($_.Exception.Message); Write-RepairLog $_.Exception.Message }
}
catch {
    $warnings.Add($_.Exception.Message)
    Write-RepairLog $_.Exception.Message
}
finally {
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}

$result = [pscustomobject][ordered]@{
    Healthy = $warnings.Count -eq 0
    Changed = $changed.ToArray()
    Warnings = $warnings.ToArray()
    Timestamp = [DateTimeOffset]::Now.ToString('o')
}
if (-not $Quiet) { $result | ConvertTo-Json -Compress }
if ($warnings.Count -gt 0) { exit 2 }
exit 0
