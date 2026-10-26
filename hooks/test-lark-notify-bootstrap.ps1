[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$initializer = Join-Path $PSScriptRoot "Initialize-LarkNotify.ps1"
$installer = Join-Path $PSScriptRoot "Install-LarkNotifyBootstrapTask.ps1"
$launcher = Join-Path $PSScriptRoot "Run-LarkNotifyBootstrap.vbs"
. $initializer
. $installer

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("lark-notify-bootstrap-tests-" + [guid]::NewGuid().ToString("N"))
$assertions = 0

function Assert-True
{
    param([bool]$Condition, [string]$Case)
    $script:assertions++
    if (-not $Condition) { throw "$Case failed." }
}

function Assert-False
{
    param([bool]$Condition, [string]$Case)
    Assert-True (-not $Condition) $Case
}

function Assert-Equals
{
    param([object]$Actual, [object]$Expected, [string]$Case)
    $script:assertions++
    if ([string]$Actual -cne [string]$Expected)
    {
        throw "$Case failed. Expected '$Expected', got '$Actual'."
    }
}

function Assert-Throws
{
    param([scriptblock]$Action, [string]$Case)
    $script:assertions++
    try { & $Action; throw "$Case failed. Expected an exception." }
    catch
    {
        if ($_.Exception.Message -eq "$Case failed. Expected an exception.") { throw }
    }
}

function Resolve-TestSid
{
    param([string]$Identity)

    if ($Identity -match '^S-\d-(?:\d+-)+\d+$') { return $Identity }
    return ([Security.Principal.NTAccount]::new($Identity)).Translate(
        [Security.Principal.SecurityIdentifier]).Value
}

function New-TestProfile
{
    param([string]$Name)

    $profile = Join-Path $testRoot $Name
    $local = Join-Path $profile "AppData\Local"
    $agentHooks = Join-Path $profile ".agents\hooks"
    [IO.Directory]::CreateDirectory($agentHooks) | Out-Null
    [IO.Directory]::CreateDirectory($local) | Out-Null
    Set-Content -LiteralPath (Join-Path $agentHooks "lark-notify.ps1") -Value "# test hook" -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $agentHooks "Invoke-CodexNotifyBridge.ps1") -Value "# test bridge" -Encoding UTF8
    [pscustomobject][ordered]@{
        recipientOpenId = "ou_test_user"
        identity = "bot"
        summaryLength = 300
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $profile ".agents\lark-notify.json") -Encoding UTF8
    $fakeCli = Join-Path $profile "lark-cli.exe"
    Set-Content -LiteralPath $fakeCli -Value "test" -Encoding ASCII
    $nativeNotify = Join-Path $local "OpenAI\Codex\runtimes\cua_node\test-runtime\bin\node_modules\@oai\sky\bin\windows\codex-computer-use.exe"
    [IO.Directory]::CreateDirectory((Split-Path -Parent $nativeNotify)) | Out-Null
    Set-Content -LiteralPath $nativeNotify -Value "test" -Encoding ASCII
    return [pscustomobject]@{ Profile = $profile; Local = $local; Cli = $fakeCli; NativeNotify = $nativeNotify }
}

function Invoke-TestBootstrap
{
    param([object]$Environment, [switch]$CheckOnly, [scriptblock]$BeforeReplace)
    Invoke-LarkNotifyBootstrap `
        -UserProfilePath $Environment.Profile `
        -LocalAppDataPath $Environment.Local `
        -LarkCliPath $Environment.Cli `
        -CheckOnly:$CheckOnly `
        -BeforeReplace $BeforeReplace
}

function Get-Hooks
{
    param([string]$Path, [string]$EventName)
    $document = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    return @($document.hooks.$EventName | ForEach-Object { @($_.hooks) })
}

function Get-SendingHooks
{
    param([object[]]$Hooks, [string]$Source)
    return @($Hooks | Where-Object {
        ([string]$_.command) -match "lark-notify\.ps1" -and ([string]$_.command) -match "-Source $Source"
    })
}

try
{
    [IO.Directory]::CreateDirectory($testRoot) | Out-Null

    $fresh = New-TestProfile "fresh"
    $first = Invoke-TestBootstrap $fresh
    Assert-True $first.Healthy "first repair reports healthy"
    Assert-True $first.ClaudeChanged "fresh Claude config changed"
    Assert-False $first.CodexChanged "fresh profile does not create Codex hooks"
    Assert-True $first.CodexNotifyChanged "fresh Codex notify changed"
    Assert-True $first.NativeNotifyChanged "fresh native notify state changed"
    Assert-True $first.RequiresCodexTrustConfirmation "fresh Codex notify requires trust"

    $claudePath = Join-Path $fresh.Profile ".claude\settings.json"
    $codexPath = Join-Path $fresh.Profile ".codex\hooks.json"
    $codexTomlPath = Join-Path $fresh.Profile ".codex\config.toml"
    $nativeStatePath = Join-Path $fresh.Local "lark-notify\codex-native-notify.json"
    Assert-True (Test-Path $claudePath) "Claude config created"
    Assert-False (Test-Path $codexPath) "Codex hooks config not created"
    Assert-True (Test-Path $codexTomlPath) "Codex TOML created"
    Assert-True (Test-Path $nativeStatePath) "native notify state created"
    $tomlInfo = Get-LNTomlNotifyInfo (Get-Content -Raw $codexTomlPath)
    Assert-True (Test-LNCodexNotifyBridge $tomlInfo.Command (Join-Path $fresh.Profile ".agents\hooks\Invoke-CodexNotifyBridge.ps1")) "Codex notify bridge configured"
    $nativeState = Get-Content -Raw $nativeStatePath | ConvertFrom-Json
    Assert-Equals $nativeState.command[0] $fresh.NativeNotify "native notify executable preserved"
    Assert-Equals $nativeState.command[1] "turn-ended" "native notify argument preserved"
    foreach ($eventName in @("Stop", "StopFailure", "Notification"))
    {
        $hooks = Get-Hooks $claudePath $eventName
        Assert-Equals @(Get-SendingHooks $hooks "claude").Count 1 "Claude $eventName one send path"
    }
    $notification = (Get-Content -Raw $claudePath | ConvertFrom-Json).hooks.Notification[0]
    Assert-Equals $notification.matcher "permission_prompt|idle_prompt|agent_needs_input" "notification matcher"
    Assert-True ([bool]$notification.hooks[0].async) "notification async"

    $claudeTime = (Get-Item $claudePath).LastWriteTimeUtc
    $tomlTime = (Get-Item $codexTomlPath).LastWriteTimeUtc
    $nativeStateTime = (Get-Item $nativeStatePath).LastWriteTimeUtc
    Start-Sleep -Milliseconds 1100
    $second = Invoke-TestBootstrap $fresh
    Assert-False $second.ClaudeChanged "second Claude run idempotent"
    Assert-False $second.CodexChanged "second Codex run idempotent"
    Assert-False $second.CodexNotifyChanged "second Codex notify run idempotent"
    Assert-False $second.NativeNotifyChanged "second native notify run idempotent"
    Assert-Equals (Get-Item $claudePath).LastWriteTimeUtc.Ticks $claudeTime.Ticks "Claude timestamp unchanged"
    Assert-False (Test-Path $codexPath) "second run still does not create Codex hooks"
    Assert-Equals (Get-Item $codexTomlPath).LastWriteTimeUtc.Ticks $tomlTime.Ticks "Codex TOML timestamp unchanged"
    Assert-Equals (Get-Item $nativeStatePath).LastWriteTimeUtc.Ticks $nativeStateTime.Ticks "native notify state timestamp unchanged"

    $check = New-TestProfile "check-only"
    $checkResult = Invoke-TestBootstrap $check -CheckOnly
    Assert-False $checkResult.Healthy "check-only reports missing hooks"
    Assert-False (Test-Path (Join-Path $check.Profile ".claude\settings.json")) "check-only does not create Claude config"
    Assert-False (Test-Path (Join-Path $check.Profile ".codex\hooks.json")) "check-only does not create Codex config"
    Assert-False (Test-Path (Join-Path $check.Profile ".codex\config.toml")) "check-only does not create Codex TOML"
    Assert-False (Test-Path (Join-Path $check.Local "lark-notify\codex-native-notify.json")) "check-only does not create native state"

    $chained = New-TestProfile "chained"
    [void](Invoke-TestBootstrap $chained)
    $chainedTomlPath = Join-Path $chained.Profile ".codex\config.toml"
    $chainedBridge = Join-Path $chained.Profile ".agents\hooks\Invoke-CodexNotifyBridge.ps1"
    $chainedPrevious = @("powershell.exe", "-File", $chainedBridge) | ConvertTo-Json -Compress
    $chainedLine = "notify = ['$($chained.NativeNotify)', ""turn-ended"", ""--previous-notify"", '$chainedPrevious']"
    Set-Content -LiteralPath $chainedTomlPath -Value $chainedLine -Encoding UTF8 -NoNewline
    $chainedTime = (Get-Item $chainedTomlPath).LastWriteTimeUtc
    Start-Sleep -Milliseconds 1100
    $chainedResult = Invoke-TestBootstrap $chained
    Assert-True $chainedResult.Healthy "chained notify reports healthy"
    Assert-True $chainedResult.CodexNotifyChained "chained notify detected"
    Assert-False $chainedResult.CodexNotifyChanged "chained notify left untouched"
    Assert-False $chainedResult.NativeNotifyChanged "chained native state unchanged"
    Assert-Equals (Get-Item $chainedTomlPath).LastWriteTimeUtc.Ticks $chainedTime.Ticks "chained TOML timestamp unchanged"
    Assert-Equals (Get-Content -Raw $chainedTomlPath).Trim() $chainedLine.Trim() "chained TOML content unchanged"
    $chainedCheck = Invoke-TestBootstrap $chained -CheckOnly
    Assert-True $chainedCheck.Healthy "chained check-only healthy"

    $unknownChain = New-TestProfile "unknown-chain"
    [void](Invoke-TestBootstrap $unknownChain)
    $unknownTomlPath = Join-Path $unknownChain.Profile ".codex\config.toml"
    $unknownLine = "notify = ['$($unknownChain.NativeNotify)', ""turn-ended"", ""--previous-notify"", '[""powershell.exe"",""-File"",""C:\\temp\\other.ps1""]']"
    Set-Content -LiteralPath $unknownTomlPath -Value $unknownLine -Encoding UTF8 -NoNewline
    Assert-Throws { Invoke-TestBootstrap $unknownChain } "unknown chained previous notify refused"

    $complex = New-TestProfile "complex"
    [IO.Directory]::CreateDirectory((Join-Path $complex.Profile ".claude")) | Out-Null
    [IO.Directory]::CreateDirectory((Join-Path $complex.Profile ".codex")) | Out-Null
    $notifyPath = Join-Path $complex.Profile ".agents\hooks\lark-notify.ps1"
    $ownedClaude = "powershell.exe -File `"$notifyPath`" -Source claude"
    $ownedCodex = "powershell.exe -File `"$notifyPath`" -Source codex"
    $unknown = 'powershell.exe -File "C:\tools\other-hook.ps1"'
    $encodedText = "& '$notifyPath' -Source claude"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($encodedText))
    $claudeDocument = [pscustomobject][ordered]@{
        env = [pscustomobject]@{ KEEP = "yes" }
        permissions = [pscustomobject]@{ defaultMode = "auto" }
        hooks = [pscustomobject][ordered]@{
            Stop = @(
                [pscustomobject]@{ matcher = "shared"; hooks = @(
                    [pscustomobject]@{ type = "command"; command = $ownedClaude; timeout = 5 },
                    [pscustomobject]@{ type = "command"; command = $unknown; timeout = 7 }
                ) },
                [pscustomobject]@{ hooks = @([pscustomobject]@{
                    type = "command"; command = "powershell.exe -EncodedCommand $encoded"; timeout = 1
                }) }
            )
            Notification = @([pscustomobject]@{ matcher = "legacy"; hooks = @(
                [pscustomobject]@{ type = "command"; command = $ownedClaude; timeout = 2 },
                [pscustomobject]@{ type = "command"; command = $unknown; timeout = 3 }
            ) })
        }
    }
    $claudeDocument | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $complex.Profile ".claude\settings.json") -Encoding UTF8
    $codexDocument = [pscustomobject][ordered]@{
        description = "keep me"
        hooks = [pscustomobject][ordered]@{
            Stop = @(
                [pscustomobject]@{ hooks = @([pscustomobject]@{ type = "command"; command = $unknown; timeout = 9 }) },
                [pscustomobject]@{ hooks = @([pscustomobject]@{ type = "command"; command = $ownedCodex; timeout = 1 }) },
                [pscustomobject]@{ hooks = @([pscustomobject]@{ type = "command"; command = $ownedCodex; timeout = 2 }) }
            )
        }
    }
    $codexDocument | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $complex.Profile ".codex\hooks.json") -Encoding UTF8

    $beforeAcl = (Get-Acl (Join-Path $complex.Profile ".claude\settings.json")).Sddl
    [void](Invoke-TestBootstrap $complex)
    $complexClaude = Get-Content -Raw (Join-Path $complex.Profile ".claude\settings.json") | ConvertFrom-Json
    $complexCodex = Get-Content -Raw (Join-Path $complex.Profile ".codex\hooks.json") | ConvertFrom-Json
    Assert-Equals $complexClaude.env.KEEP "yes" "unrelated env preserved"
    Assert-Equals $complexClaude.permissions.defaultMode "auto" "permissions preserved"
    Assert-Equals $complexClaude.hooks.Stop[0].matcher "shared" "shared matcher preserved"
    Assert-Equals $complexClaude.hooks.Stop[0].hooks[1].command $unknown "shared unknown sibling preserved"
    Assert-Equals @(Get-SendingHooks (Get-Hooks (Join-Path $complex.Profile ".claude\settings.json") "Stop") "claude").Count 1 "duplicate Claude hooks consolidated"
    Assert-Equals $complexClaude.hooks.Notification[0].matcher "legacy" "notification shared matcher preserved"
    Assert-Equals $complexClaude.hooks.Notification[0].hooks[1].command $unknown "notification sibling preserved"
    Assert-Equals @(Get-SendingHooks (Get-Hooks (Join-Path $complex.Profile ".claude\settings.json") "Notification") "claude").Count 1 "shared notification gets canonical entry"
    Assert-Equals $complexCodex.hooks.Stop[0].hooks[0].command $unknown "Codex unknown index preserved"
    Assert-Equals $complexCodex.hooks.Stop[1].hooks[0].command 'powershell.exe -NoLogo -NoProfile -NonInteractive -Command "exit 0"' "first owned Codex hook disabled in place"
    Assert-Equals $complexCodex.hooks.Stop[2].hooks[0].command 'powershell.exe -NoLogo -NoProfile -NonInteractive -Command "exit 0"' "second owned Codex hook disabled in place"
    Assert-Equals $complexCodex.description "keep me" "Codex description preserved"
    Assert-Equals @(Get-SendingHooks (Get-Hooks (Join-Path $complex.Profile ".codex\hooks.json") "Stop") "codex").Count 0 "all Codex send hooks disabled"
    Assert-Equals (Get-Acl (Join-Path $complex.Profile ".claude\settings.json")).Sddl $beforeAcl "target ACL preserved"
    Assert-Equals (Get-Acl ((Join-Path $complex.Profile ".claude\settings.json") + ".lark-notify.bootstrap.bak")).Sddl $beforeAcl "backup ACL preserved"

    $stableCodexCommand = "powershell.exe -File `"$notifyPath`" -Source codex"
    $stableCodexDocument = [pscustomobject][ordered]@{
        description = "User-level notifications and lifecycle hooks."
        hooks = [pscustomobject][ordered]@{
            Stop = @([pscustomobject]@{ hooks = @([pscustomobject]@{
                type = "command"; command = $stableCodexCommand; timeout = 30
            }) })
        }
    }
    Assert-True (Merge-LNCodexConfig $stableCodexDocument $notifyPath) "single Codex hook disabled"
    Assert-Equals $stableCodexDocument.hooks.Stop[0].hooks[0].command 'powershell.exe -NoLogo -NoProfile -NonInteractive -Command "exit 0"' "single Codex hook replaced in place"

    $metadataCodexDocument = [pscustomobject][ordered]@{
        hooks = [pscustomobject][ordered]@{
            Stop = @([pscustomobject][ordered]@{
                matcher = "keep-matcher"
                custom = "keep-metadata"
                hooks = @([pscustomobject]@{ type = "command"; command = $stableCodexCommand; timeout = 3 })
            })
        }
    }
    Assert-True (Merge-LNCodexConfig $metadataCodexDocument $notifyPath) "metadata Codex hook disabled"
    Assert-Equals $metadataCodexDocument.hooks.Stop[0].matcher "keep-matcher" "Codex matcher preserved"
    Assert-Equals $metadataCodexDocument.hooks.Stop[0].custom "keep-metadata" "Codex entry metadata preserved"

    $rollback = New-TestProfile "rollback"
    [IO.Directory]::CreateDirectory((Join-Path $rollback.Profile ".codex")) | Out-Null
    $rollbackHooksPath = Join-Path $rollback.Profile ".codex\hooks.json"
    $rollbackTomlPath = Join-Path $rollback.Profile ".codex\config.toml"
    $rollbackNotifyPath = Join-Path $rollback.Profile ".agents\hooks\lark-notify.ps1"
    $rollbackOwnedCommand = "powershell.exe -File `"$rollbackNotifyPath`" -Source codex"
    [pscustomobject][ordered]@{
        hooks = [pscustomobject][ordered]@{
            Stop = @([pscustomobject]@{ hooks = @([pscustomobject]@{
                type = "command"; command = $rollbackOwnedCommand; timeout = 30
            }) })
        }
    } | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $rollbackHooksPath -Encoding UTF8
    $rollbackNativeLine = "notify = " + (ConvertTo-LNTomlArray @($rollback.NativeNotify, "turn-ended"))
    Set-Content -LiteralPath $rollbackTomlPath -Value $rollbackNativeLine -Encoding UTF8 -NoNewline
    $script:rollbackFailureInjected = $false
    $failHookReplace = {
        param($path, $attempt)
        if (-not $script:rollbackFailureInjected -and $path -eq $rollbackHooksPath)
        {
            $script:rollbackFailureInjected = $true
            throw "forced hook replacement failure"
        }
    }
    Assert-Throws { Invoke-TestBootstrap $rollback -BeforeReplace $failHookReplace } "hook migration failure reported"
    Assert-Equals (Get-Content -Raw $rollbackTomlPath).Trim() $rollbackNativeLine "TOML rolled back after hook migration failure"
    Assert-Equals @(Get-SendingHooks (Get-Hooks $rollbackHooksPath "Stop") "codex").Count 1 "old Codex hook retained after migration failure"

    $concurrent = New-TestProfile "concurrent"
    [IO.Directory]::CreateDirectory((Join-Path $concurrent.Profile ".claude")) | Out-Null
    '{}' | Set-Content -LiteralPath (Join-Path $concurrent.Profile ".claude\settings.json") -Encoding UTF8
    [IO.Directory]::CreateDirectory((Join-Path $concurrent.Profile ".codex")) | Out-Null
    '{}' | Set-Content -LiteralPath (Join-Path $concurrent.Profile ".codex\hooks.json") -Encoding UTF8
    $script:injected = $false
    $injectEdit = {
        param($path, $attempt)
        if (-not $script:injected -and $path -like "*settings.json")
        {
            $script:injected = $true
            $doc = Get-Content -Raw $path | ConvertFrom-Json
            $doc | Add-Member -NotePropertyName concurrentMarker -NotePropertyValue "preserve"
            $doc | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $path -Encoding UTF8
        }
    }
    [void](Invoke-TestBootstrap $concurrent -BeforeReplace $injectEdit)
    Assert-Equals (Get-Content -Raw (Join-Path $concurrent.Profile ".claude\settings.json") | ConvertFrom-Json).concurrentMarker "preserve" "concurrent edit preserved"

    $broken = New-TestProfile "broken"
    [IO.Directory]::CreateDirectory((Join-Path $broken.Profile ".claude")) | Out-Null
    $brokenPath = Join-Path $broken.Profile ".claude\settings.json"
    '{broken' | Set-Content -LiteralPath $brokenPath -Encoding UTF8
    Assert-Throws { Invoke-TestBootstrap $broken } "invalid JSON rejected"
    Assert-Equals (Get-Content -Raw $brokenPath).Trim() "{broken" "invalid JSON unchanged"

    $stale = New-TestProfile "stale"
    [IO.Directory]::CreateDirectory((Join-Path $stale.Profile ".claude")) | Out-Null
    $stalePath = Join-Path $stale.Profile ".claude\settings.json"
    '{}' | Set-Content -LiteralPath $stalePath -Encoding UTF8
    'stale' | Set-Content -LiteralPath ($stalePath + ".lark-notify.bootstrap.tmp") -Encoding UTF8
    [void](Invoke-TestBootstrap $stale)
    Assert-False (Test-Path ($stalePath + ".lark-notify.bootstrap.tmp")) "stale temp removed when target valid"

    $recovery = New-TestProfile "recovery"
    [IO.Directory]::CreateDirectory((Join-Path $recovery.Profile ".claude")) | Out-Null
    $recoveryPath = Join-Path $recovery.Profile ".claude\settings.json"
    '{broken' | Set-Content -LiteralPath $recoveryPath -Encoding UTF8
    'stale' | Set-Content -LiteralPath ($recoveryPath + ".lark-notify.bootstrap.tmp") -Encoding UTF8
    '{}' | Set-Content -LiteralPath ($recoveryPath + ".lark-notify.bootstrap.bak") -Encoding UTF8
    Assert-Throws { Invoke-TestBootstrap $recovery } "invalid target with stale temp fails closed"
    Assert-True (Test-Path $recoveryPath) "recovery target preserved"
    Assert-True (Test-Path ($recoveryPath + ".lark-notify.bootstrap.tmp")) "recovery temp preserved"
    Assert-True (Test-Path ($recoveryPath + ".lark-notify.bootstrap.bak")) "recovery backup preserved"

    $taskDefinition = New-LarkNotifyBootstrapTaskDefinition -BootstrapScript $initializer -LauncherScript $launcher
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    Assert-Equals (Resolve-TestSid $taskDefinition.Principal.UserId) $currentSid "task principal SID"
    Assert-Equals $taskDefinition.Principal.RunLevel "Limited" "task limited privilege"
    Assert-True ([string]$taskDefinition.Principal.LogonType -match "Interactive") "task interactive token"
    Assert-Equals $taskDefinition.Settings.RestartCount 5 "task restart count"
    Assert-Equals ([Xml.XmlConvert]::ToTimeSpan([string]$taskDefinition.Settings.RestartInterval).TotalMinutes) 1 "task restart interval"
    Assert-Equals ([Xml.XmlConvert]::ToTimeSpan([string]$taskDefinition.Settings.ExecutionTimeLimit).TotalMinutes) 5 "task execution limit"
    Assert-Equals $taskDefinition.Settings.MultipleInstances "IgnoreNew" "task ignores second instance"
    Assert-Equals $taskDefinition.Action.Execute (Join-Path $env:SystemRoot "System32\wscript.exe") "task uses windowless host"
    Assert-Equals $taskDefinition.Action.Arguments ('//B //Nologo "{0}"' -f $launcher) "task launches bootstrap wrapper"
    $taskTriggers = @($taskDefinition.Trigger)
    Assert-Equals $taskTriggers.Count 2 "task has logon and periodic triggers"
    Assert-Equals (Resolve-TestSid $taskTriggers[0].UserId) $currentSid "task logon trigger SID"
    Assert-Equals $taskTriggers[1].DaysInterval 1 "task periodic trigger recurs daily"
    Assert-Equals ([Xml.XmlConvert]::ToTimeSpan([string]$taskTriggers[1].Repetition.Interval).TotalMinutes) 10 "task periodic interval"
    Assert-Equals ([Xml.XmlConvert]::ToTimeSpan([string]$taskTriggers[1].Repetition.Duration).TotalDays) 1 "task periodic duration"
    Assert-True (-not [bool]$taskTriggers[1].Repetition.StopAtDurationEnd) "task periodic trigger hands off across days"

    $launcherTestRoot = Join-Path $testRoot "launcher path with spaces"
    [IO.Directory]::CreateDirectory($launcherTestRoot) | Out-Null
    $launcherTestPath = Join-Path $launcherTestRoot "Run-LarkNotifyBootstrap.vbs"
    $launcherInitializer = Join-Path $launcherTestRoot "Initialize-LarkNotify.ps1"
    Copy-Item -LiteralPath $launcher -Destination $launcherTestPath
    $wscript = Join-Path $env:SystemRoot "System32\wscript.exe"
    $launcherArguments = '//B //Nologo "{0}"' -f $launcherTestPath

    "exit 0" | Set-Content -LiteralPath $launcherInitializer -Encoding ASCII
    $launcherSuccess = Start-Process -FilePath $wscript -ArgumentList $launcherArguments -Wait -PassThru
    Assert-Equals $launcherSuccess.ExitCode 0 "launcher supports spaces and returns success"

    "exit 7" | Set-Content -LiteralPath $launcherInitializer -Encoding ASCII
    $launcherFailure = Start-Process -FilePath $wscript -ArgumentList $launcherArguments -Wait -PassThru
    Assert-Equals $launcherFailure.ExitCode 7 "launcher preserves PowerShell failure"

    $systemRootBeforeFailureTest = $env:SystemRoot
    try
    {
        $env:SystemRoot = Join-Path $testRoot "missing-system-root"
        $launcherStartFailure = Start-Process -FilePath $wscript -ArgumentList $launcherArguments -Wait -PassThru
        Assert-Equals $launcherStartFailure.ExitCode 1 "launcher reports process startup failure"
    }
    finally
    {
        $env:SystemRoot = $systemRootBeforeFailureTest
    }

    Write-Host "PASS: $assertions assertions"
}
finally
{
    if (Test-Path -LiteralPath $testRoot)
    {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
