[CmdletBinding()]
param([string[]]$Group = @('All'))

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Group = @($Group | ForEach-Object { @([string]$_ -split ',') } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
Import-Module (Join-Path (Split-Path -Parent $PSScriptRoot) 'StartupHealth.psm1') -Force

$script:Passed = 0
function Assert-SH([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "ASSERT: $Message" }
    $script:Passed++
}
function Assert-SHThrows([scriptblock]$Action, [string]$Pattern, [string]$Message) {
    $caught = $null
    try { & $Action } catch { $caught = $_.Exception.Message }
    Assert-SH ($null -ne $caught -and $caught -match $Pattern) "$Message (actual=$caught)"
}
function Test-SHGroup([string]$Name) { $Group -contains 'All' -or $Group -contains $Name }
function Invoke-SHProviderFixture([string]$Id, $Context, [string]$Root, [string]$PowerShellPath) {
    $contextPath = Join-Path $testRoot ($Id + '-context.json')
    Write-SHAtomicJson $contextPath $Context
    $scriptPath = Join-Path (Join-Path $Root 'checks') ($Id + '.ps1')
    $process = Invoke-SHIsolatedProcess $PowerShellPath @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $scriptPath, '-Action', 'Check', '-ContextPath', $contextPath) $PSScriptRoot 8000 65536
    if ($process.ExitCode -ne 0) { throw "Provider $Id failed: $($process.Stderr)" }
    $process.Stdout.Trim() | ConvertFrom-Json
}
function New-SHTestEncodedCommand([string]$Script) {
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Script))
    "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('startup-health-test-' + [Guid]::NewGuid().ToString('N'))
try {
    [IO.Directory]::CreateDirectory($testRoot) | Out-Null
    if (Test-SHGroup 'Foundation') {
        $local = Join-Path $testRoot 'local'
        Assert-SH ((Get-SHStateRoot $local) -eq (Join-Path $local 'ai-startup-health')) 'state root is portable'
        Assert-SH ((Get-SHRepositoryRoot) -eq (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))) 'repository root comes from module location'

        $statePath = Join-Path $local 'ai-startup-healthmode.json'
        Write-SHAtomicJson $statePath ([ordered]@{ schemaVersion = 1; autoStart = 'warn-only' })
        $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
        Assert-SH ($state.schemaVersion -eq 1 -and $state.autoStart -eq 'warn-only') 'atomic JSON state round trips'
        Write-SHAtomicJson $statePath ([ordered]@{ schemaVersion = 1; autoStart = 'enabled' })
        Assert-SH ((Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json).autoStart -eq 'enabled') 'atomic JSON state replaces an existing file'

        $corrupt = Move-SHCorruptState $statePath ([DateTimeOffset]'2026-10-25T01:02:03Z')
        Assert-SH ($corrupt -match '\.corrupt-20261025T010203000Z$' -and (Test-Path -LiteralPath $corrupt)) 'corrupt state has a bounded timestamped name'

        $logPath = Join-Path (Join-Path $local 'ai-startup-health') 'runner.log'
        Write-SHLog $logPath ('a' * 80) 100 3
        Write-SHLog $logPath ('b' * 80) 100 3
        Assert-SH ((Test-Path -LiteralPath ($logPath + '.1')) -and (Test-Path -LiteralPath $logPath)) 'log rotates at the byte cap'

        $registryRoot = Join-Path $testRoot 'registry'
        [IO.Directory]::CreateDirectory((Join-Path $registryRoot 'checks')) | Out-Null
        [IO.File]::WriteAllText((Join-Path (Join-Path $registryRoot 'checks') 'one.ps1'), '"ok"', [Text.UTF8Encoding]::new($false))
        $validRegistry = [ordered]@{
            schemaVersion = 1
            checks = @([ordered]@{
                id = 'one'; title = 'One'; script = 'checks/one.ps1'; clients = @('claude'); scope = 'global'; enabled = $true
                autoStartPolicy = $null; checkTimeoutMs = 500; freshnessSeconds = 5; cooldownSeconds = 0; dependsOn = @()
                reasons = [ordered]@{ ready = 'Ready.' }; guidance = [ordered]@{}
            })
        }
        $registryPath = Join-Path $registryRoot 'checks.json'
        Write-SHAtomicJson $registryPath $validRegistry
        $registry = Read-SHRegistry $registryPath
        Assert-SH ($registry.Checks.Count -eq 1 -and $registry.ById.ContainsKey('one')) 'valid registry loads'

        $duplicate = $validRegistry | ConvertTo-Json -Depth 20 | ConvertFrom-Json
        $duplicate.checks = @($duplicate.checks[0], $duplicate.checks[0])
        Write-SHAtomicJson $registryPath $duplicate
        Assert-SHThrows { Read-SHRegistry $registryPath } 'Duplicate check id' 'duplicate ids are rejected'

        $cycle = $validRegistry | ConvertTo-Json -Depth 20 | ConvertFrom-Json
        $cycle.checks = @(
            [ordered]@{ id = 'one'; title = 'One'; script = 'checks/one.ps1'; clients = @('claude'); scope = 'global'; enabled = $true; autoStartPolicy = $null; checkTimeoutMs = 500; freshnessSeconds = 5; cooldownSeconds = 0; dependsOn = @('two'); reasons = [ordered]@{ ready = 'Ready.' }; guidance = [ordered]@{} },
            [ordered]@{ id = 'two'; title = 'Two'; script = 'checks/one.ps1'; clients = @('claude'); scope = 'global'; enabled = $true; autoStartPolicy = $null; checkTimeoutMs = 500; freshnessSeconds = 5; cooldownSeconds = 0; dependsOn = @('one'); reasons = [ordered]@{ ready = 'Ready.' }; guidance = [ordered]@{} }
        )
        Write-SHAtomicJson $registryPath $cycle
        Assert-SHThrows { Read-SHRegistry $registryPath } 'Dependency cycle' 'dependency cycles are rejected'

        $check = ($validRegistry | ConvertTo-Json -Depth 20 | ConvertFrom-Json).checks[0]
        $resultJson = [ordered]@{ schemaVersion = 1; id = 'one'; surface = 'global'; status = 'ok'; reasonCode = 'ready'; guidanceId = $null; startEligibility = 'not-needed'; dependencyReady = $true; facts = [ordered]@{ count = 1 } } | ConvertTo-Json -Compress
        $result = ConvertFrom-SHProviderResult $resultJson $check 'global'
        Assert-SH ($result.status -eq 'ok' -and $result.dependencyReady) 'provider result normalizes'
        $badResultObject = $resultJson | ConvertFrom-Json
        $badResultObject | Add-Member NoteProperty message 'free form'
        $badResult = $badResultObject | ConvertTo-Json -Compress
        Assert-SHThrows { ConvertFrom-SHProviderResult $badResult $check 'global' } 'unknown fields' 'provider free-form fields are rejected'
    }

    if ((Test-SHGroup 'Helpers') -or (Test-SHGroup 'Context') -or (Test-SHGroup 'AutoStartPolicy') -or (Test-SHGroup 'GuardLedger')) {
        $frameworkRoot = Split-Path -Parent $PSScriptRoot
        $repositoryRoot = Split-Path -Parent $frameworkRoot
        if (Test-SHGroup 'Helpers') {
            $encoded = New-SHTestEncodedCommand '$scriptPath=[IO.Path]::Combine([Environment]::GetFolderPath(''UserProfile''),''.agents'',''token-meter'',''ClaudeTurnHook.ps1'')'
            Assert-SH (Test-SHCommandReferences $encoded @('ClaudeTurnHook.ps1')) 'encoded command references are decoded'
            Assert-SH (-not (Test-SHCommandReferences $encoded @('CodexTurnHook.ps1'))) 'encoded command does not match an unrelated script'
            Assert-SH (Test-SHCommandReferences 'powershell.exe -File C:\x\lark-notify.ps1' @('lark-notify.ps1')) 'literal command references match'
            $path = Join-Path $testRoot 'path-test\file.js'
            Assert-SH (Test-SHPathEquivalent ($path -replace '\\', '/') $path) 'forward and backslash paths are equivalent'
            Assert-SH (-not (Test-SHPathEquivalent $path ($path + '.other'))) 'different paths are not equivalent'

            $lark = Get-SHLarkCliInfo
            if ($null -ne $lark) {
                Assert-SH ((Test-Path -LiteralPath $lark.Path) -and [bool]$lark.EntryExists) 'lark-cli resolves a runnable JS entry'
            }
            $debugPort = Get-SHChromeDebugPort
            Assert-SH ($null -eq $debugPort -or ($debugPort -ge 1 -and $debugPort -le 65535)) 'Chrome DevTools port is bounded'

            $profileHome = Join-Path $testRoot 'profile-paths\home'
            $manifestForPaths = [pscustomobject]@{ hooks = [pscustomobject]@{
                claude = [pscustomobject]@{ configPath = (Join-Path $profileHome '.claude\settings.json') }
                codex = [pscustomobject]@{ configPath = (Join-Path $profileHome '.codex\hooks.json') }
            } }
            $derived = Get-SHProfilePaths $manifestForPaths
            Assert-SH ($derived.ClaudeJsonPath -eq (Join-Path $profileHome '.claude.json') -and $derived.CodexConfigPath -eq (Join-Path $profileHome '.codex\config.toml')) 'profile paths derive from the installed manifest'

            $ownedCommand = 'powershell.exe -NoProfile -File Invoke-StartupHealthHook.ps1 -Owner AIStartupHealthV1'
            $hookDocument = [ordered]@{ hooks = [ordered]@{ SessionStart = @([ordered]@{
                matcher = '^(startup|resume)$'
                hooks = @([ordered]@{ type = 'command'; command = $ownedCommand; timeout = 75; async = $true })
            }) } }
            $hookPath = Join-Path $testRoot 'owned-count.json'
            Write-SHAtomicJson $hookPath $hookDocument
            Assert-SH ((Get-SHOwnedHookCount $hookPath) -eq 1) 'owned hook count reports one entry'
            $hookDocument.hooks.SessionStart = @($hookDocument.hooks.SessionStart[0], $hookDocument.hooks.SessionStart[0])
            Write-SHAtomicJson $hookPath $hookDocument
            Assert-SH ((Get-SHOwnedHookCount $hookPath) -eq 2) 'owned hook count reports duplicates'

            $overall = New-SHDeadline 60000
            Assert-SH ((Get-SHPhaseBudget $overall 7000 0) -eq 7000) 'phase budget caps at the phase maximum'
            Assert-SH ((Get-SHPhaseBudget $overall 40000 30000) -le 30000) 'phase budget honors the reserve'
            $expired = New-SHDeadline 50
            Start-Sleep -Milliseconds 80
            Assert-SH ((Get-SHPhaseBudget $expired 7000 0) -eq 0) 'expired overall budget yields no phase budget'

            $registryDocument = Get-Content -Raw -LiteralPath (Join-Path $frameworkRoot 'checks.json') | ConvertFrom-Json
            $policyRegistry = [pscustomobject]@{ Checks = @($registryDocument.checks | Where-Object { $_.autoStartPolicy }) ; ById = @{} }
            $policyManifest = [pscustomobject]@{ taskPolicy = [pscustomobject]@{ id = 'lark-gateway-task-v1' } }
            $policy = Get-SHAutoStartPolicy $policyRegistry $policyManifest
            Assert-SH ($null -ne $policy -and $policy.PolicyId -eq 'lark-gateway-task-v1' -and $policy.CooldownSeconds -eq 300 -and $policy.Key -eq 'lark-gateway|global') 'auto-start policy comes from the registry'
            $policyManifest.taskPolicy.id = 'other-policy'
            Assert-SH ($null -eq (Get-SHAutoStartPolicy $policyRegistry $policyManifest)) 'auto-start policy requires the manifest policy id'

            $guardPath = Join-Path $testRoot 'guard-ledger.json'
            $guardNow = [DateTimeOffset]'2026-10-25T01:00:00Z'
            Assert-SH (Test-SHShouldNotifyGuard $null 'runtime-unapproved' $guardNow) 'first guard warning is emitted'
            Update-SHGuardNotification $null 'runtime-unapproved' $guardPath $guardNow
            $guardLedger = Read-SHStateJson $guardPath
            Assert-SH (-not (Test-SHShouldNotifyGuard $guardLedger 'runtime-unapproved' $guardNow.AddMinutes(5))) 'identical guard warning is suppressed'
            Assert-SH (Test-SHShouldNotifyGuard $guardLedger 'runtime-unapproved' $guardNow.AddMinutes(31)) 'guard warning suppression expires'
            Assert-SH (Test-SHShouldNotifyGuard $guardLedger 'hook-drift' $guardNow) 'changed guard reason is emitted'

            $generationState = Join-Path $testRoot 'generation-state'
            [IO.Directory]::CreateDirectory($generationState) | Out-Null
            Write-SHAtomicJson (Join-Path $generationState 'install-manifest.json') ([ordered]@{ schemaVersion = 1; installed = $true; generation = 'g1' })
            Assert-SH (Test-SHManifestGenerationCurrent ([pscustomobject]@{ generation = 'g1' }) $generationState) 'current manifest generation is detected'
            Assert-SH (-not (Test-SHManifestGenerationCurrent ([pscustomobject]@{ generation = 'g2' }) $generationState)) 'stale manifest generation is rejected'
        }
        if (Test-SHGroup 'Context') {
            $contextRoot = Join-Path $testRoot 'context'
            $contextHome = Join-Path $contextRoot 'home'
            [IO.Directory]::CreateDirectory((Join-Path $contextHome '.claude')) | Out-Null
            [IO.Directory]::CreateDirectory((Join-Path $contextHome '.codex')) | Out-Null
            $node = [string](Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
            $entry = Join-Path $repositoryRoot 'tools\chrome-devtools-mcp\node_modules\chrome-devtools-mcp\build\src\bin\chrome-devtools-mcp.js'
            $entryForward = $entry -replace '\\', '/'
            $ownedCommand = 'powershell.exe -NoProfile -File Invoke-StartupHealthHook.ps1 -Owner AIStartupHealthV1'
            $encodedTurn = New-SHTestEncodedCommand '$scriptPath=[IO.Path]::Combine([Environment]::GetFolderPath(''UserProfile''),''.agents'',''token-meter'',''ClaudeTurnHook.ps1''); & $scriptPath'
            $encodedStatus = New-SHTestEncodedCommand '$scriptPath=[IO.Path]::Combine([Environment]::GetFolderPath(''UserProfile''),''.agents'',''token-meter'',''ClaudeStatusLine.ps1''); & $scriptPath'
            $encodedCodexTurn = New-SHTestEncodedCommand '$scriptPath=[IO.Path]::Combine([Environment]::GetFolderPath(''UserProfile''),''.agents'',''token-meter'',''CodexTurnHook.ps1''); & $scriptPath'
            $claudeSettingsPath = Join-Path $contextHome '.claude\settings.json'
            $claudeSettings = [ordered]@{
                env = [ordered]@{ ANTHROPIC_BASE_URL = 'http://127.0.0.1:15721/v1' }
                statusLine = [ordered]@{ type = 'command'; command = $encodedStatus }
                hooks = [ordered]@{
                    Stop = @(
                        [ordered]@{ hooks = @([ordered]@{ type = 'command'; command = 'powershell.exe -NoProfile -File C:\repo\hooks\lark-notify.ps1' }) },
                        [ordered]@{ hooks = @([ordered]@{ type = 'command'; command = $encodedTurn }) }
                    )
                    SessionStart = @([ordered]@{ matcher = '^(startup|resume)$'; hooks = @([ordered]@{ type = 'command'; command = $ownedCommand; timeout = 75; async = $true }) })
                }
            }
            Write-SHAtomicJson $claudeSettingsPath $claudeSettings
            Write-SHAtomicJson (Join-Path $contextHome '.claude.json') ([ordered]@{ mcpServers = [ordered]@{ 'chrome-devtools' = [ordered]@{ command = $node; args = @($entryForward, '--autoConnect') } } })
            $codexHooksPath = Join-Path $contextHome '.codex\hooks.json'
            $codexHooks = [ordered]@{ hooks = [ordered]@{
                Stop = @([ordered]@{ hooks = @([ordered]@{ type = 'command'; command = $encodedCodexTurn }) })
                SessionStart = @([ordered]@{ matcher = '^(startup|resume)$'; hooks = @([ordered]@{ type = 'command'; command = $ownedCommand; timeout = 75; async = $true }) })
            } }
            Write-SHAtomicJson $codexHooksPath $codexHooks
            $toml = @(
                'notify = [''C:\x\codex-computer-use.exe'', "turn-ended", "--previous-notify", ''["powershell.exe","-File","C:\\repo\\hooks\\Invoke-CodexNotifyBridge.ps1"]'']'
                '[tui]'
                "status_line = ['model-with-reasoning', 'context-remaining', 'current-dir']"
                '[mcp_servers.chrome-devtools]'
                "command = '$node'"
                "args = ['$entry', ""--autoConnect""]"
                'base_url = "http://127.0.0.1:15721/v1"'
            ) -join [Environment]::NewLine
            [IO.File]::WriteAllText((Join-Path $contextHome '.codex\config.toml'), $toml, [Text.UTF8Encoding]::new($false))
            $claudeProjection = Get-SHHookProjection $claudeSettingsPath
            $codexProjection = Get-SHHookProjection $codexHooksPath
            $manifest = [pscustomobject]@{
                frameworkRoot = $frameworkRoot
                nativeAssembly = [pscustomobject]@{ path = 'x' }
                runtimes = @()
                diagnosticProbes = @()
                hooks = [pscustomobject]@{
                    claude = [pscustomobject]@{ configPath = $claudeSettingsPath; projectionSha256 = $claudeProjection.Sha256 }
                    codex = [pscustomobject]@{ configPath = $codexHooksPath; projectionSha256 = $codexProjection.Sha256 }
                }
                taskPolicy = [pscustomobject]@{ id = 'lark-gateway-task-v1'; definition = $null }
            }
            $registryDocument = Get-Content -Raw -LiteralPath (Join-Path $frameworkRoot 'checks.json') | ConvertFrom-Json
            $tokenClaude = New-SHProviderContext -Check (@($registryDocument.checks | Where-Object id -eq 'token-meter')[0]) -Surface 'claude' -Manifest $manifest
            Assert-SH ($tokenClaude.tokenMeter.hookHealthy -and $tokenClaude.tokenMeter.statusLineHealthy) 'Claude token-meter detects encoded hooks and status line'
            $tokenCodex = New-SHProviderContext -Check (@($registryDocument.checks | Where-Object id -eq 'token-meter')[0]) -Surface 'codex' -Manifest $manifest
            Assert-SH ($tokenCodex.tokenMeter.hookHealthy -and $tokenCodex.tokenMeter.statusLineHealthy) 'Codex token-meter detects encoded hooks and status line'
            $notifyClaude = New-SHProviderContext -Check (@($registryDocument.checks | Where-Object id -eq 'lark-notify')[0]) -Surface 'claude' -Manifest $manifest
            $notifyCodex = New-SHProviderContext -Check (@($registryDocument.checks | Where-Object id -eq 'lark-notify')[0]) -Surface 'codex' -Manifest $manifest
            Assert-SH ($notifyClaude.larkNotify.hookHealthy -and $notifyClaude.larkNotify.larkCliPresent) 'Claude notification context is healthy'
            Assert-SH ($notifyCodex.larkNotify.hookHealthy -and $notifyCodex.larkNotify.larkCliPresent) 'Codex notification context checks the notify bridge'
            $chromeClaude = New-SHProviderContext -Check (@($registryDocument.checks | Where-Object id -eq 'chrome-devtools-mcp')[0]) -Surface 'claude' -Manifest $manifest
            $chromeCodex = New-SHProviderContext -Check (@($registryDocument.checks | Where-Object id -eq 'chrome-devtools-mcp')[0]) -Surface 'codex' -Manifest $manifest
            Assert-SH ($chromeClaude.chromeDevtools.configured -and $chromeClaude.chromeDevtools.argumentsMatch -and $chromeClaude.chromeDevtools.autoConnect) 'Claude MCP context reads .claude.json and normalizes paths'
            Assert-SH ($chromeCodex.chromeDevtools.configured -and $chromeCodex.chromeDevtools.argumentsMatch) 'Codex MCP context reads config.toml'
            $proxy = New-SHProviderContext -Check (@($registryDocument.checks | Where-Object id -eq 'model-proxy')[0]) -Surface 'claude' -Manifest $manifest
            Assert-SH ([string]$proxy.modelProxy.endpoint -match '127\.0\.0\.1:15721') 'Claude model proxy endpoint is read and sanitized'
            $configClaude = New-SHProviderContext -Check (@($registryDocument.checks | Where-Object id -eq 'config-integrity')[0]) -Surface 'claude' -Manifest $manifest
            Assert-SH ($configClaude.configuration.validatorAvailable -and $configClaude.configuration.valid -and $configClaude.configuration.ownedHookCount -eq 1) 'Claude configuration integrity validates JSONC and the owned hook'
            $probeFacts = @{ 'codex-config-load' = [pscustomobject]@{ ready = $true; profile = 'codex-config-load'; path = 'x'; version = $null } }
            $configCodex = New-SHProviderContext -Check (@($registryDocument.checks | Where-Object id -eq 'config-integrity')[0]) -Surface 'codex' -Manifest $manifest -ProbeFacts $probeFacts
            Assert-SH ($configCodex.configuration.validatorAvailable -and $configCodex.configuration.valid -and $configCodex.configuration.ownedHookCount -eq 1) 'Codex configuration integrity consumes the config-load probe'
            $configCodexNoProbe = New-SHProviderContext -Check (@($registryDocument.checks | Where-Object id -eq 'config-integrity')[0]) -Surface 'codex' -Manifest $manifest
            Assert-SH (-not $configCodexNoProbe.configuration.validatorAvailable) 'Codex validation is reported unavailable without the probe'
        }
        if (Test-SHGroup 'GuardLedger') {
            $guardLedgerPath = Join-Path $testRoot 'guard-ledger-notify.json'
            Write-SHAtomicJson $guardLedgerPath ([ordered]@{ codex = [ordered]@{ hash = 'x'; notifiedAt = [DateTimeOffset]::UtcNow.ToString('O') } })
            Update-SHGuardNotification (Read-SHStateJson $guardLedgerPath) 'runtime-unapproved' $guardLedgerPath
            $ledger = Read-SHStateJson $guardLedgerPath
            Assert-SH ($null -ne $ledger.PSObject.Properties['codex'] -and $null -ne $ledger.PSObject.Properties['compatibility-guard']) 'guard notification preserves surface entries'
        }
    }

    if ((Test-SHGroup 'Concurrency') -or (Test-SHGroup 'Processes') -or (Test-SHGroup 'Budgets')) {
        if (Test-SHGroup 'Concurrency') {
            $mutexName = 'Global\AIStartupHealth-Test-' + [Guid]::NewGuid().ToString('N')
            $first = Enter-SHMutex -NameOverride $mutexName -WaitMilliseconds 0
            Assert-SH ($first.Acquired -and -not $first.Abandoned) 'first process acquires the mutex'
            $powershell = Join-Path $PSHOME 'powershell.exe'
            $modulePath = Join-Path (Split-Path -Parent $PSScriptRoot) 'StartupHealth.psm1'
            $probePath = Join-Path $PSScriptRoot 'fixtures\mutex-probe.ps1'
            $blocked = Invoke-SHIsolatedProcess $powershell @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $probePath, '-ModulePath', $modulePath, '-MutexName', $mutexName) $PSScriptRoot 5000 4096
            if ($blocked.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($blocked.Stdout)) { throw "Mutex probe failed: stdout=$($blocked.Stdout) stderr=$($blocked.Stderr)" }
            Assert-SH (-not ($blocked.Stdout | ConvertFrom-Json).acquired) 'second process opens but does not wait on an owned mutex'
            Exit-SHMutex $first
            $available = Invoke-SHIsolatedProcess $powershell @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $probePath, '-ModulePath', $modulePath, '-MutexName', $mutexName) $PSScriptRoot 5000 4096
            if ($available.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($available.Stdout)) { throw "Mutex probe failed: stdout=$($available.Stdout) stderr=$($available.Stderr)" }
            Assert-SH (($available.Stdout | ConvertFrom-Json).acquired) 'second process acquires and releases the existing mutex'
        }
        if (Test-SHGroup 'Budgets') {
            $deadline = New-SHDeadline 200
            $before = Get-SHRemainingMilliseconds $deadline
            Start-Sleep -Milliseconds 40
            $after = Get-SHRemainingMilliseconds $deadline
            Assert-SH ($before -le 200 -and $after -lt $before -and $after -gt 0) 'deadline uses a decreasing monotonic clock'
            Start-Sleep -Milliseconds 200
            Assert-SH ((Get-SHRemainingMilliseconds $deadline) -eq 0) 'expired deadline never becomes negative'
        }
        if (Test-SHGroup 'Processes') {
            $powershell = Join-Path $PSHOME 'powershell.exe'
            $streams = Invoke-SHIsolatedProcess $powershell @('-NoProfile', '-Command', '[Console]::Out.Write("out"); [Console]::Error.Write("err")') $PSScriptRoot 5000 4096
            Assert-SH ($streams.ExitCode -eq 0 -and $streams.Stdout -eq 'out' -and $streams.Stderr -eq 'err') 'isolated process drains both streams'
            $flood = Invoke-SHIsolatedProcess $powershell @('-NoProfile', '-Command', '[Console]::Out.Write("x" * 20000)') $PSScriptRoot 5000 4096
            Assert-SH ($flood.StdoutTruncated -and [Text.Encoding]::UTF8.GetByteCount($flood.Stdout) -eq 4096) 'isolated process truncates flood output'
            $timeout = Invoke-SHIsolatedProcess $powershell @('-NoProfile', '-Command', 'Start-Sleep -Seconds 30') $PSScriptRoot 150 4096
            Assert-SH ($timeout.TimedOut -and $timeout.DurationMilliseconds -lt 5000) 'isolated process timeout closes its job'
        }
    }

    if (Test-SHGroup 'RuntimeGuard') {
        $guardRoot = Join-Path $testRoot 'guard'
        [IO.Directory]::CreateDirectory($guardRoot) | Out-Null
        $nativeAssembly = Join-Path $guardRoot 'StartupHealthNative.dll'
        $nativeHash = Install-SHNativeAssembly $nativeAssembly
        $powershell = Join-Path $PSHOME 'powershell.exe'
        $runtimeIdentity = Get-SHFileIdentity $powershell $nativeAssembly

        $hookCommand = 'powershell.exe -NoProfile -File Invoke-StartupHealthHook.ps1 -Owner AIStartupHealthV1'
        $hookDocument = [ordered]@{ hooks = [ordered]@{ SessionStart = @([ordered]@{
            matcher = '^(startup|resume)$'
            hooks = @([ordered]@{ type = 'command'; command = $hookCommand; timeout = 75; async = $true })
        }) } }
        $hookPath = Join-Path $guardRoot 'hooks.json'
        Write-SHAtomicJson $hookPath $hookDocument
        $projection = Get-SHHookProjection $hookPath
        Assert-SH ($projection.Projection.async -and $projection.Projection.timeout -eq 75) 'owned hook projection includes async and timeout'

        $jsoncHookPath = Join-Path $guardRoot 'hooks-jsonc.json'
        $jsoncHookText = "{`r`n  `"hooks`": {`r`n    `"SessionStart`": [{`r`n      `"matcher`": `"^(startup|resume)$`",`r`n      `"hooks`": [{ `"type`": `"command`", `"command`": `"$hookCommand`", `"timeout`": 75, `"async`": true, }],`r`n    }],`r`n  }, // retained comment`r`n}`r`n"
        [IO.File]::WriteAllText($jsoncHookPath, $jsoncHookText, [Text.UTF8Encoding]::new($false))
        Assert-SH ((Get-SHHookProjection $jsoncHookPath).Projection.matcher -eq '^(startup|resume)$') 'runtime projection accepts comments after trailing commas'

        $manifest = [pscustomobject]@{
            schemaVersion = 1; installed = $true
            nativeAssembly = [pscustomobject]@{ path = $nativeAssembly; sha256 = $nativeHash }
            hooks = [pscustomobject]@{ codex = [pscustomobject]@{ configPath = $hookPath; projectionSha256 = $projection.Sha256 } }
            runtimes = @([pscustomobject]@{ surface = 'codex'; file = $runtimeIdentity })
        }
        $approved = Test-SHEntryGuardEvidence $manifest @($powershell) 'Codex Desktop' 500
        Assert-SH ($approved.Approved -and $approved.Surface -eq 'codex' -and $approved.DurationMilliseconds -le 500) 'spoofed desktop hint cannot change a standalone approved runtime'

        $hookDocument.hooks.SessionStart[0].hooks[0].async = $false
        Write-SHAtomicJson $hookPath $hookDocument
        $drift = Test-SHEntryGuardEvidence $manifest @($powershell) $null 500
        Assert-SH (-not $drift.Approved -and $drift.Reason -eq 'hook-drift') 'async-only hook drift fails closed'
        $hookDocument.hooks.SessionStart[0].hooks[0].async = $true
        $hookDocument.hooks.SessionStart[0].hooks[0].timeout = 74
        Write-SHAtomicJson $hookPath $hookDocument
        $drift = Test-SHEntryGuardEvidence $manifest @($powershell) $null 500
        Assert-SH (-not $drift.Approved -and $drift.Reason -eq 'hook-drift') 'timeout-only hook drift fails closed'

        $packageText = '{"name":"fixture","version":"26.1021.31345"}'
        $packageBytes = [Text.Encoding]::UTF8.GetBytes($packageText)
        $headerObject = [ordered]@{ files = [ordered]@{ 'package.json' = [ordered]@{ size = $packageBytes.Length; offset = '0' } } }
        $headerBytes = [Text.Encoding]::UTF8.GetBytes(($headerObject | ConvertTo-Json -Compress -Depth 10))
        $padded = ($headerBytes.Length + 3) -band -bnot 3
        [byte[]]$preamble = New-Object byte[] 16
        [Array]::Copy([BitConverter]::GetBytes([uint32]$headerBytes.Length), 0, $preamble, 12, 4)
        $asarPath = Join-Path $guardRoot 'app.asar'
        $asarStream = [IO.File]::Open($asarPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $asarStream.Write($preamble, 0, $preamble.Length)
            $asarStream.Write($headerBytes, 0, $headerBytes.Length)
            if ($padded -gt $headerBytes.Length) { $asarStream.Write((New-Object byte[] ($padded - $headerBytes.Length)), 0, ($padded - $headerBytes.Length)) }
            $asarStream.Write($packageBytes, 0, $packageBytes.Length)
        } finally { $asarStream.Dispose() }
        $asar = Get-SHAsarPackageMetadata $asarPath
        Assert-SH ($asar.InternalBuild -eq '26.1021.31345' -and (Read-SHAsarPackageVersionAt $asarPath $asar.DataOffset $asar.PackageOffset $asar.PackageSize) -eq $asar.InternalBuild) 'ASAR package build uses the recorded bounded offset'

        $stateRoot = Join-Path $guardRoot 'state'
        [IO.Directory]::CreateDirectory($stateRoot) | Out-Null
        [IO.File]::WriteAllText((Join-Path $stateRoot 'disabled'), '', [Text.UTF8Encoding]::new($false))
        $entry = Join-Path (Split-Path -Parent $PSScriptRoot) 'Invoke-StartupHealthHook.ps1'
        $killSwitch = Invoke-SHIsolatedProcess $powershell @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $entry, '-Owner', 'AIStartupHealthV1', '-StateRoot', $stateRoot, '-ManifestPath', (Join-Path $guardRoot 'missing.json')) $PSScriptRoot 5000 4096
        Assert-SH ($killSwitch.ExitCode -eq 0 -and [string]::IsNullOrEmpty($killSwitch.Stdout)) 'kill switch exits silently before manifest access'
    }

    if ((Test-SHGroup 'Probes') -or (Test-SHGroup 'Scheduler') -or (Test-SHGroup 'Cache')) {
        if (Test-SHGroup 'Probes') {
            $powershell = Join-Path $PSHOME 'powershell.exe'
            $requests = @(
                [pscustomobject]@{ Key = 'one'; Executable = $powershell; Arguments = @('-NoProfile', '-Command', 'Start-Sleep -Milliseconds 150; [Console]::Out.Write("one")'); WorkingDirectory = $PSScriptRoot; TimeoutMilliseconds = 2000; MaximumBytes = 4096 },
                [pscustomobject]@{ Key = 'two'; Executable = $powershell; Arguments = @('-NoProfile', '-Command', 'Start-Sleep -Milliseconds 150; [Console]::Out.Write("two")'); WorkingDirectory = $PSScriptRoot; TimeoutMilliseconds = 2000; MaximumBytes = 4096 }
            )
            $watch = [Diagnostics.Stopwatch]::StartNew()
            $batch = Invoke-SHProcessBatch $requests 2 3000
            $watch.Stop()
            Assert-SH ($batch.Count -eq 2 -and $batch[0].Result.Stdout -eq 'one' -and $batch[1].Result.Stdout -eq 'two') 'probe batch preserves keyed results'
            Assert-SH ($watch.ElapsedMilliseconds -lt 1400) 'probe batch runs independent work concurrently'
            $probe = [pscustomobject]@{ Profile = 'version-output'; ExecutableIdentity = 'abc'; Arguments = @('--version'); Surface = 'codex' }
            Assert-SH ((Get-SHProbeKey $probe) -eq (Get-SHProbeKey $probe)) 'probe deduplication key is deterministic'
            $node = [string](Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
            $probeNative = Join-Path $testRoot 'probe-native.dll'
            $probeNativeHash = Install-SHNativeAssembly $probeNative
            $probeManifest = [pscustomobject]@{
                frameworkRoot = Split-Path -Parent $PSScriptRoot
                nativeAssembly = [pscustomobject]@{ path = $probeNative; sha256 = $probeNativeHash }
                diagnosticProbes = @([pscustomobject]@{
                    id = 'node-version'; profile = 'version-output'; surface = 'global'; file = Get-SHFileIdentity $node $probeNative
                    sha256 = Get-SHSha256 -Path $node; arguments = @('--version'); timeoutMilliseconds = 3500
                })
            }
            $probeFacts = Invoke-SHDiagnosticProbes $probeManifest 7000
            Assert-SH ($probeFacts['node-version'].ready -and [string]$probeFacts['node-version'].version -match '^v\d+') 'probe broker revalidates and runs an exact pinned version command'
            $probeManifest.diagnosticProbes[0].sha256 = 'drifted'
            $probeFacts = Invoke-SHDiagnosticProbes $probeManifest 7000
            Assert-SH (-not $probeFacts['node-version'].ready) 'probe broker refuses executable digest drift'
        }
        if (Test-SHGroup 'Scheduler') {
            $fit = @(
                [pscustomobject]@{ Id = 'a'; TimeoutMilliseconds = 3000; DependsOn = @() },
                [pscustomobject]@{ Id = 'b'; TimeoutMilliseconds = 3000; DependsOn = @() },
                [pscustomobject]@{ Id = 'c'; TimeoutMilliseconds = 5000; DependsOn = @('a') }
            )
            Assert-SH (Test-SHDeterministicSchedule $fit 4 10000) 'deterministic provider schedule fits its budget'
            Assert-SH (-not (Test-SHDeterministicSchedule $fit 4 7000)) 'overcommitted provider schedule is rejected'
            $cycle = @(
                [pscustomobject]@{ Id = 'a'; TimeoutMilliseconds = 1000; DependsOn = @('b') },
                [pscustomobject]@{ Id = 'b'; TimeoutMilliseconds = 1000; DependsOn = @('a') }
            )
            Assert-SH (-not (Test-SHDeterministicSchedule $cycle 4 10000)) 'cyclic schedule is rejected'
        }
        if (Test-SHGroup 'Cache') {
            $now = [DateTimeOffset]'2026-10-25T00:00:00Z'
            $existing = @(
                [pscustomobject]@{ key = 'fresh'; checkedAt = '2026-10-24T23:59:00Z'; expiresAt = '2026-10-25T00:01:00Z'; value = 1 },
                [pscustomobject]@{ key = 'stale'; checkedAt = '2026-10-24T23:58:00Z'; expiresAt = '2026-10-24T23:59:59Z'; value = 2 },
                [pscustomobject]@{ key = 'future'; checkedAt = '2026-10-25T01:00:00Z'; expiresAt = '2026-10-25T01:05:00Z'; value = 4 }
            )
            $merged = @(Merge-SHSnapshotCells $existing @([pscustomobject]@{ key = 'new'; expiresAt = '2026-10-25T00:02:00Z'; value = 3 }) $now)
            Assert-SH ($merged.Count -eq 2 -and @($merged.key) -contains 'fresh' -and @($merged.key) -contains 'new') 'snapshot merge preserves only fresh cells and new results'
        }
    }

    if ((Test-SHGroup 'ProviderContract') -or (Test-SHGroup 'Dependencies') -or (Test-SHGroup 'ConfigIntegrity') -or (Test-SHGroup 'TokenMeter') -or (Test-SHGroup 'LarkNotify')) {
        $frameworkRoot = Split-Path -Parent $PSScriptRoot
        $repositoryRoot = Split-Path -Parent $frameworkRoot
        $registryDocument = Get-Content -Raw -LiteralPath (Join-Path $frameworkRoot 'checks.json') | ConvertFrom-Json
        $powershell = Join-Path $PSHOME 'powershell.exe'
        $nativeAssembly = Join-Path $testRoot 'provider-native.dll'
        $null = Install-SHNativeAssembly $nativeAssembly
        if ((Test-SHGroup 'Dependencies') -or (Test-SHGroup 'ProviderContract')) {
            $context = [ordered]@{ runtimeDependencies = @([ordered]@{ id = 'powershell'; path = $powershell; required = $true; probeReady = $true }) }
            $result = Invoke-SHProviderFixture 'runtime-dependencies' $context $frameworkRoot $powershell
            $check = @($registryDocument.checks | Where-Object id -eq 'runtime-dependencies')[0]
            $null = ConvertFrom-SHProviderResult ($result | ConvertTo-Json -Compress -Depth 10) $check 'global'
            Assert-SH ($result.status -eq 'ok' -and $result.dependencyReady) 'runtime dependency provider accepts verified executables'
        }
        if ((Test-SHGroup 'ConfigIntegrity') -or (Test-SHGroup 'ProviderContract')) {
            $context = [ordered]@{ surface = 'codex'; configuration = [ordered]@{ validatorAvailable = $true; valid = $true; ownedHookCount = 1 } }
            $result = Invoke-SHProviderFixture 'config-integrity' $context $frameworkRoot $powershell
            $check = @($registryDocument.checks | Where-Object id -eq 'config-integrity')[0]
            $null = ConvertFrom-SHProviderResult ($result | ConvertTo-Json -Compress -Depth 10) $check 'codex'
            Assert-SH ($result.status -eq 'ok') 'configuration provider accepts one validated owned hook'
        }
        if ((Test-SHGroup 'TokenMeter') -or (Test-SHGroup 'ProviderContract')) {
            $dataRoot = Join-Path $testRoot 'token-data'; [IO.Directory]::CreateDirectory($dataRoot) | Out-Null
            $acl = Get-Acl -LiteralPath $dataRoot
            $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
            $rights = [Security.AccessControl.FileSystemRights]::CreateFiles -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
            $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, $rights, [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
            Set-Acl -LiteralPath $dataRoot -AclObject $acl
            $context = [ordered]@{
                surface = 'claude'; paths = [ordered]@{ repositoryRoot = $repositoryRoot; nativeAssemblyPath = $nativeAssembly }
                tokenMeter = [ordered]@{ manifestValid = $true; hookHealthy = $true; statusLineHealthy = $true; dataRoot = $dataRoot }
            }
            $result = Invoke-SHProviderFixture 'token-meter' $context $frameworkRoot $powershell
            $check = @($registryDocument.checks | Where-Object id -eq 'token-meter')[0]
            $null = ConvertFrom-SHProviderResult ($result | ConvertTo-Json -Compress -Depth 10) $check 'claude'
            Assert-SH ($result.status -eq 'ok' -and $result.facts.dataAccess) 'token meter uses AccessCheck without a write probe'
            Assert-SH (@(Get-ChildItem -LiteralPath $dataRoot -Force).Count -eq 0) 'token meter permission check creates no files'
        }
        if ((Test-SHGroup 'LarkNotify') -or (Test-SHGroup 'ProviderContract')) {
            $context = [ordered]@{
                surface = 'desktop'; paths = [ordered]@{ repositoryRoot = $repositoryRoot }
                larkNotify = [ordered]@{ larkCliPresent = $true; hookHealthy = $true; bridgeHealthy = $true; taskPresent = $true; taskEnabled = $true; taskState = 'Running'; lastTaskResult = 267009 }
            }
            $result = Invoke-SHProviderFixture 'lark-notify' $context $frameworkRoot $powershell
            $check = @($registryDocument.checks | Where-Object id -eq 'lark-notify')[0]
            $null = ConvertFrom-SHProviderResult ($result | ConvertTo-Json -Compress -Depth 10) $check 'desktop'
            Assert-SH ($result.status -eq 'ok' -and $result.facts.taskActive) 'running bootstrap task codes are not treated as completed failures'
        }
        if (Test-SHGroup 'ProviderContract') {
            foreach ($provider in @('runtime-dependencies.ps1', 'config-integrity.ps1', 'token-meter.ps1', 'lark-notify.ps1')) {
                $tokens = $null; $errors = $null
                $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path (Join-Path $frameworkRoot 'checks') $provider), [ref]$tokens, [ref]$errors)
                Assert-SH ($errors.Count -eq 0) "$provider parses"
                $commands = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] }, $true) | ForEach-Object { $_.GetCommandName() })
                Assert-SH (@($commands | Where-Object { $_ -in @('Start-Process', 'Start-ScheduledTask', 'Register-ScheduledTask', 'Set-Content', 'Add-Content', 'Out-File', 'New-Item', 'Remove-Item') }).Count -eq 0) "$provider contains no mutating command"
            }
        }
    }

    if ((Test-SHGroup 'Gateway') -or (Test-SHGroup 'AutoStartPolicy') -or (Test-SHGroup 'Readiness')) {
        $frameworkRoot = Split-Path -Parent $PSScriptRoot
        $repositoryRoot = Split-Path -Parent $frameworkRoot
        $registryDocument = Get-Content -Raw -LiteralPath (Join-Path $frameworkRoot 'checks.json') | ConvertFrom-Json
        $powershell = Join-Path $PSHOME 'powershell.exe'
        $nativeAssembly = Join-Path $testRoot 'gateway-native.dll'
        $null = Install-SHNativeAssembly $nativeAssembly
        if (Test-SHGroup 'Gateway') {
            $process = Get-SHProcessIdentity $PID $nativeAssembly
            $processStartedAt = (ConvertFrom-SHFileTime ([string]$process.ProcessStartFileTime)).UtcDateTime.ToString('o')
            $healthPath = Join-Path $testRoot 'health.json'
            Write-SHAtomicJson $healthPath ([ordered]@{
                pid = $PID; processStartedAt = $processStartedAt; gatewayEntry = 'gateway.mjs'; listenerReady = $true; stopping = $false; updatedAt = '2026-10-25T01:00:00Z'
            })
            $context = [ordered]@{
                now = '2026-10-25T01:00:10Z'; paths = [ordered]@{ repositoryRoot = $repositoryRoot; nativeAssemblyPath = $nativeAssembly }
                larkGateway = [ordered]@{
                    taskPresent = $true; taskEnabled = $true; taskState = 'Ready'; taskDefinitionMatches = $true; dependenciesReady = $true
                    healthPath = $healthPath; expectedNodePath = [string]$process.ExecutablePath; expectedGatewayEntry = 'gateway.mjs'
                }
            }
            $result = Invoke-SHProviderFixture 'lark-gateway' $context $frameworkRoot $powershell
            $check = @($registryDocument.checks | Where-Object id -eq 'lark-gateway')[0]
            $null = ConvertFrom-SHProviderResult ($result | ConvertTo-Json -Compress -Depth 10) $check 'global'
            Assert-SH ($result.status -eq 'ok' -and $result.reasonCode -eq 'live-gateway-external-to-task' -and $result.startEligibility -eq 'not-needed') 'Ready task with a validated external gateway is healthy and not startable'

            $context.larkGateway.healthPath = Join-Path $testRoot 'missing-health.json'
            $result = Invoke-SHProviderFixture 'lark-gateway' $context $frameworkRoot $powershell
            Assert-SH ($result.status -eq 'warn' -and $result.startEligibility -eq 'eligible' -and $result.reasonCode -eq 'gateway-not-running') 'Ready task without live health is eligible'

            $context.larkGateway.taskDefinitionMatches = $false
            $result = Invoke-SHProviderFixture 'lark-gateway' $context $frameworkRoot $powershell
            Assert-SH ($result.reasonCode -eq 'policy-task-definition-drift' -and $result.startEligibility -eq 'unsupported') 'task definition drift suppresses auto-start'

            $context.larkGateway.taskPresent = $false
            $result = Invoke-SHProviderFixture 'lark-gateway' $context $frameworkRoot $powershell
            Assert-SH ($result.reasonCode -eq 'gateway-task-missing') 'a missing task is reported as missing, not drift'
            $context.larkGateway.taskPresent = $true
            $context.larkGateway.taskEnabled = $false
            $context.larkGateway.taskState = 'Disabled'
            $result = Invoke-SHProviderFixture 'lark-gateway' $context $frameworkRoot $powershell
            Assert-SH ($result.reasonCode -eq 'gateway-task-disabled') 'a disabled task is reported as disabled, not drift'
        }
        if (Test-SHGroup 'AutoStartPolicy') {
            $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
            $currentSid = $currentIdentity.User.Value
            $currentName = $currentIdentity.Name
            $expected = [pscustomobject]@{ execute = 'node.exe'; arguments = '"gateway.mjs"'; workingDirectory = 'repo'; userSid = $currentSid }
            $actual = [pscustomobject]@{
                actions = @([pscustomobject]@{ execute = 'node.exe'; arguments = '"gateway.mjs"'; workingDirectory = 'repo' })
                triggers = @([pscustomobject]@{ type = 'AtLogOn'; userSid = $currentSid })
                userSid = $currentName; logonType = 'Interactive'; runLevel = 'Limited'; enabled = $true
                executionTimeLimitSeconds = 0; restartCount = 5; restartIntervalSeconds = 60
            }
            Assert-SH (Test-SHGatewayTaskDefinition $actual $expected) 'exact gateway task definition matches the compiled policy'
            $actual.actions += [pscustomobject]@{ execute = 'extra.exe'; arguments = ''; workingDirectory = 'repo' }
            Assert-SH (-not (Test-SHGatewayTaskDefinition $actual $expected)) 'an additional task action invalidates the policy'
            $helper = Get-Content -Raw -LiteralPath (Join-Path (Join-Path $frameworkRoot 'internal') 'Start-LarkGatewayTask.ps1')
            Assert-SH ($helper -match "TaskName 'LarkClaudeGateway'" -and $helper -notmatch '^param') 'start helper has a fixed task and accepts no parameters'
        }
    }

    if ((Test-SHGroup 'ChromeDevToolsMcp') -or (Test-SHGroup 'ModelProxy')) {
        $frameworkRoot = Split-Path -Parent $PSScriptRoot
        $registryDocument = Get-Content -Raw -LiteralPath (Join-Path $frameworkRoot 'checks.json') | ConvertFrom-Json
        $powershell = Join-Path $PSHOME 'powershell.exe'
        if (Test-SHGroup 'ChromeDevToolsMcp') {
            $packagePath = Join-Path $testRoot 'chrome-package'; [IO.Directory]::CreateDirectory($packagePath) | Out-Null
            $entryPath = Join-Path $packagePath 'index.js'; [IO.File]::WriteAllText($entryPath, '', [Text.UTF8Encoding]::new($false))
            $context = [ordered]@{ surface = 'codex'; chromeDevtools = [ordered]@{
                packagePath = $packagePath; entryScript = $entryPath; lockConsistent = $true; configured = $true; enabled = $true; required = $false
                commandMatches = $true; argumentsMatch = $true; autoConnect = $true; chromePresent = $true; remoteDebuggingAvailable = $true
            } }
            $result = Invoke-SHProviderFixture 'chrome-devtools-mcp' $context $frameworkRoot $powershell
            $check = @($registryDocument.checks | Where-Object id -eq 'chrome-devtools-mcp')[0]
            $null = ConvertFrom-SHProviderResult ($result | ConvertTo-Json -Compress -Depth 10) $check 'codex'
            Assert-SH ($result.status -eq 'ok' -and $result.startEligibility -eq 'not-needed') 'Chrome DevTools MCP healthy configuration remains optional'
            $context.chromeDevtools.required = $true
            $result = Invoke-SHProviderFixture 'chrome-devtools-mcp' $context $frameworkRoot $powershell
            Assert-SH ($result.reasonCode -eq 'chrome-devtools-config-drift') 'required Chrome MCP configuration is rejected'
        }
        if (Test-SHGroup 'ModelProxy') {
            $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $listener.Start()
            try {
                $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
                $context = [ordered]@{ surface = 'codex'; modelProxy = [ordered]@{ endpoint = "http://127.0.0.1:$port/v1" } }
                $result = Invoke-SHProviderFixture 'model-proxy' $context $frameworkRoot $powershell
                $check = @($registryDocument.checks | Where-Object id -eq 'model-proxy')[0]
                $null = ConvertFrom-SHProviderResult ($result | ConvertTo-Json -Compress -Depth 10) $check 'codex'
                Assert-SH ($result.status -eq 'ok' -and $result.facts.loopback -and $result.facts.reachable) 'model proxy performs a loopback TCP check only'
            } finally { $listener.Stop() }
            $context = [ordered]@{ surface = 'codex'; modelProxy = [ordered]@{ endpoint = 'http://192.0.2.1:8080/v1' } }
            $result = Invoke-SHProviderFixture 'model-proxy' $context $frameworkRoot $powershell
            Assert-SH ($result.reasonCode -eq 'model-proxy-not-loopback') 'non-loopback model proxy is rejected without connecting'
        }
    }

    if (Test-SHGroup 'Installer') {
        $frameworkRoot = Split-Path -Parent $PSScriptRoot
        $repositoryRoot = Split-Path -Parent $frameworkRoot
        Import-Module (Join-Path $frameworkRoot 'StartupHealthInstaller.psm1') -Force
        $matrix = Read-SHCompatibilityMatrix (Join-Path $frameworkRoot 'compatibility.json')
        $approvedInventory = @(
            [pscustomobject]@{ surface = 'claude'; path = 'fixture-claude.exe'; version = '2.1.252 (Claude Code)' },
            [pscustomobject]@{ surface = 'desktop'; path = 'fixture-codex.exe'; version = 'codex-cli 0.163.0-alpha.10.2'; internalBuild = '26.1013.40934' }
        )
        $compatibility = Test-SHCompatibilityInventory $matrix $approvedInventory
        Assert-SH $compatibility.Approved 'exact compatibility matrix entries are approved'
        $approvedInventory[1].version = 'codex-cli 0.164.0-alpha.11.1'
        $compatibility = Test-SHCompatibilityInventory $matrix $approvedInventory
        Assert-SH (-not $compatibility.Approved -and @($compatibility.Issues | Where-Object code -eq 'runtime-version-unapproved').Count -eq 1) 'an upgraded client is rejected until the matrix is updated'

        $npmBin = Join-Path $testRoot 'npm-bin'
        $npmEngine = Join-Path $npmBin 'node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe'
        [IO.Directory]::CreateDirectory((Split-Path -Parent $npmEngine)) | Out-Null
        [IO.File]::WriteAllText((Join-Path $npmBin 'codex.cmd'), '@echo off', [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText($npmEngine, 'fixture', [Text.UTF8Encoding]::new($false))
        Assert-SH ((Resolve-SHCodexLauncherEngine (Join-Path $npmBin 'codex.cmd')) -eq $npmEngine) 'npm launcher resolution records the actual Codex engine consumer'

        $desktopLocal = Join-Path $testRoot 'desktop-local'
        $desktopBin = Join-Path $desktopLocal 'OpenAI\Codex\bin\fixture-hash'
        [IO.Directory]::CreateDirectory($desktopBin) | Out-Null
        $desktopEngine = Join-Path $desktopBin 'codex.exe'
        Copy-Item -LiteralPath (Join-Path $PSHOME 'powershell.exe') -Destination $desktopEngine
        $desktopCandidates = @(Get-SHDesktopEngineCandidates -LocalApplicationDataPath $desktopLocal -DesktopAppAsarPath (Join-Path $testRoot 'missing.asar'))
        Assert-SH ($desktopCandidates.Count -eq 1 -and $desktopCandidates[0] -ieq $desktopEngine) 'desktop engine is discovered from the local runtime directory'

        $installerRoot = Join-Path $testRoot 'installer'
        [IO.Directory]::CreateDirectory($installerRoot) | Out-Null
        $node = [string](Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
        $powershell = [string](Get-Command powershell.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
        $command = New-SHOwnedHookCommand $powershell (Join-Path $frameworkRoot 'Invoke-StartupHealthHook.ps1')
        $firstConfig = Join-Path $installerRoot 'claude.json'
        $secondConfig = Join-Path $installerRoot 'codex.json'
        [IO.File]::WriteAllText($firstConfig, "{`r`n  // keep`r`n  `"hooks`": {},`r`n  `"retained`": true,`r`n}`r`n", [Text.UTF8Encoding]::new($true))
        [IO.File]::WriteAllText($secondConfig, '{"hooks":{},"retained":2}', [Text.UTF8Encoding]::new($false))
        $firstCandidate = Join-Path $installerRoot 'claude-candidate.json'
        $secondCandidate = Join-Path $installerRoot 'codex-candidate.json'
        $null = Invoke-SHConfigEditor $node install $firstConfig $firstCandidate $command $frameworkRoot
        $null = Invoke-SHConfigEditor $node install $secondConfig $secondCandidate $command $frameworkRoot
        $firstProjection = Get-SHHookProjection $firstCandidate
        Assert-SH ($firstProjection.Projection.async -and $firstProjection.Projection.timeout -eq 75) 'runtime projection accepts the JSONC candidate without a child parser'
        Assert-SHThrows {
            $duplicatePath = Join-Path $installerRoot 'duplicate.json'
            [IO.File]::WriteAllText($duplicatePath, '{"hooks":{},"hooks":{}}', [Text.UTF8Encoding]::new($false))
            Get-SHHookProjection $duplicatePath
        } 'Duplicate JSON property' 'runtime projection rejects duplicate JSON properties'

        $stateRoot = Join-Path $installerRoot 'state'
        $manifest = [ordered]@{ schemaVersion = 1; installed = $true; generation = 'test-generation' }
        $targets = @(
            [pscustomobject]@{ configPath = $firstConfig; candidatePath = $firstCandidate; sourceStamp = Get-SHFileStamp $firstConfig },
            [pscustomobject]@{ configPath = $secondConfig; candidatePath = $secondCandidate; sourceStamp = Get-SHFileStamp $secondConfig }
        )
        $transaction = Install-SHHookTransaction $targets $stateRoot $manifest ('Global\AIStartupHealth-Installer-' + [Guid]::NewGuid().ToString('N'))
        Assert-SH ($transaction.Installed -and (Get-Content -Raw $firstConfig) -match 'keep' -and (Get-Content -Raw $secondConfig) -match 'AIStartupHealthV1') 'transaction installs both candidates and preserves unrelated JSONC content'
        Assert-SH ((Get-Content -Raw (Join-Path $stateRoot 'mode.json') | ConvertFrom-Json).autoStart -eq 'warn-only') 'installation always begins in warn-only mode'
        Assert-SH ((Test-Path -LiteralPath (Join-Path $stateRoot 'start-attempts.json')) -and (Test-Path -LiteralPath (Join-Path $stateRoot 'last-notified.json'))) 'installation creates conservative empty ledgers'

        $driftConfig = Join-Path $installerRoot 'drift.json'
        $driftCandidate = Join-Path $installerRoot 'drift-candidate.json'
        [IO.File]::WriteAllText($driftConfig, '{"value":1}', [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText($driftCandidate, '{"value":2}', [Text.UTF8Encoding]::new($false))
        $driftStamp = Get-SHFileStamp $driftConfig
        [IO.File]::WriteAllText($driftConfig, '{"value":3}', [Text.UTF8Encoding]::new($false))
        Assert-SHThrows {
            Install-SHHookTransaction @([pscustomobject]@{ configPath = $driftConfig; candidatePath = $driftCandidate; sourceStamp = $driftStamp }) (Join-Path $installerRoot 'drift-state') $manifest ('Global\AIStartupHealth-Installer-' + [Guid]::NewGuid().ToString('N'))
        } 'changed after candidate validation' 'transaction rejects source drift before replacement'
        Assert-SH ((Get-Content -Raw $driftConfig) -eq '{"value":3}') 'source drift is preserved'
        Assert-SH (-not (Test-Path -LiteralPath (Join-Path $installerRoot 'drift-state\mode.json'))) 'source drift is rejected before transaction state changes'

        $rollbackOne = Join-Path $installerRoot 'rollback-one.json'
        $rollbackTwo = Join-Path $installerRoot 'rollback-two.json'
        $rollbackCandidate = Join-Path $installerRoot 'rollback-candidate.json'
        [IO.File]::WriteAllText($rollbackOne, '{"original":1}', [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText($rollbackTwo, '{"original":2}', [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText($rollbackCandidate, '{"installed":1}', [Text.UTF8Encoding]::new($false))
        $rollbackTargets = @(
            [pscustomobject]@{ configPath = $rollbackOne; candidatePath = $rollbackCandidate; sourceStamp = Get-SHFileStamp $rollbackOne },
            [pscustomobject]@{ configPath = $rollbackTwo; candidatePath = (Join-Path $installerRoot 'missing-candidate.json'); sourceStamp = Get-SHFileStamp $rollbackTwo }
        )
        $rollbackState = Join-Path $installerRoot 'rollback-state'
        [IO.Directory]::CreateDirectory($rollbackState) | Out-Null
        $oldMode = '{"schemaVersion":1,"autoStart":"enabled","generation":"old"}'
        $oldActivation = '{"schemaVersion":1,"generation":"old","status":"complete"}'
        $oldManifest = '{"schemaVersion":1,"installed":true,"generation":"old"}'
        [IO.File]::WriteAllText((Join-Path $rollbackState 'mode.json'), $oldMode, [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText((Join-Path $rollbackState 'activation.json'), $oldActivation, [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText((Join-Path $rollbackState 'install-manifest.json'), $oldManifest, [Text.UTF8Encoding]::new($false))
        Assert-SHThrows {
            Install-SHHookTransaction $rollbackTargets $rollbackState $manifest ('Global\AIStartupHealth-Installer-' + [Guid]::NewGuid().ToString('N'))
        } '.+' 'partial install failure is reported'
        Assert-SH ((Get-Content -Raw $rollbackOne) -eq '{"original":1}') 'partial install failure restores the first configuration exactly'
        Assert-SH ((Get-Content -Raw (Join-Path $rollbackState 'mode.json')) -eq $oldMode) 'partial install failure restores the previous mode exactly'
        Assert-SH ((Get-Content -Raw (Join-Path $rollbackState 'activation.json')) -eq $oldActivation) 'partial install failure restores the previous activation exactly'
        Assert-SH ((Get-Content -Raw (Join-Path $rollbackState 'install-manifest.json')) -eq $oldManifest) 'partial install failure retains the previous manifest exactly'
        Assert-SH (-not (Test-Path -LiteralPath (Join-Path $rollbackState 'start-attempts.json'))) 'partial install failure removes a transaction-created start ledger'
        Assert-SH (-not (Test-Path -LiteralPath (Join-Path $rollbackState 'last-notified.json'))) 'partial install failure removes a transaction-created notification ledger'

        $absentDirectory = Join-Path $testRoot 'absent-target'
        [IO.Directory]::CreateDirectory($absentDirectory) | Out-Null
        $absentConfig = Join-Path $absentDirectory 'settings.json'
        $absentCandidate = Join-Path $installerRoot 'absent-candidate.json'
        [IO.File]::WriteAllText($absentCandidate, '{"installed":true}', [Text.UTF8Encoding]::new($false))
        $absentState = Join-Path $installerRoot 'absent-state'
        $absentManifest = [ordered]@{ schemaVersion = 1; installed = $true; generation = 'absent-generation' }
        $absentTransaction = Install-SHHookTransaction @([pscustomobject]@{ configPath = $absentConfig; candidatePath = $absentCandidate; sourceStamp = Get-SHFileStamp $absentConfig }) $absentState $absentManifest ('Global\AIStartupHealth-Installer-' + [Guid]::NewGuid().ToString('N'))
        Assert-SH ($absentTransaction.Installed -and (Test-Path -LiteralPath $absentConfig)) 'an absent target is created transactionally'
        Assert-SH (@(Get-ChildItem -LiteralPath $absentDirectory -Force -Filter '.startup-health-candidate-*.tmp').Count -eq 0) 'absent-target staging leaves no temporary file'

        $claudeRuntime = [string](Get-Command claude -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
        $codexRuntime = [string](Resolve-SHCodexLauncherEngine ([string](Get-Command codex -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source))
        $desktopCandidates = @(Get-SHDesktopEngineCandidates)
        $inventoryPath = Join-Path $testRoot 'inventory.json'
        $inventoryRuntimes = @(
            [ordered]@{ surface = 'claude'; path = $claudeRuntime; version = '2.1.252 (Claude Code)' },
            [ordered]@{ surface = 'codex'; path = $codexRuntime; version = 'codex-cli 0.153.4' }
        )
        if ($desktopCandidates.Count -gt 0) {
            $inventoryRuntimes += [ordered]@{ surface = 'desktop'; path = $desktopCandidates[0]; version = 'codex-cli 0.163.0-alpha.10.2'; internalBuild = '26.1013.40934' }
        }
        Write-SHAtomicJson $inventoryPath ([ordered]@{ runtimes = $inventoryRuntimes })
        $preflight = Invoke-SHIsolatedProcess $powershell @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $frameworkRoot 'Install-StartupHealth.ps1'), '-Mode', 'Preflight', '-InventoryPath', $inventoryPath) $repositoryRoot 30000 131072
        $preflightReport = ([string]$preflight.Stdout).Trim() | ConvertFrom-Json
        Assert-SH ($preflight.ExitCode -eq 0 -and [bool]$preflightReport.approved) 'preflight approves an inventory that matches the matrix'
    }

    if (Test-SHGroup 'Runner') {
        $frameworkRoot = Split-Path -Parent $PSScriptRoot
        $runnerRoot = Join-Path $testRoot 'runner'
        [IO.Directory]::CreateDirectory((Join-Path $runnerRoot 'checks')) | Out-Null
        Copy-Item -LiteralPath (Join-Path $frameworkRoot 'checks\runtime-dependencies.ps1') -Destination (Join-Path $runnerRoot 'checks\runtime-dependencies.ps1')
        $runnerRegistryDocument = [ordered]@{ schemaVersion = 1; checks = @([ordered]@{
            id = 'runtime-dependencies'; title = 'Runtime dependencies'; script = 'checks/runtime-dependencies.ps1'; clients = @('codex'); scope = 'global'; enabled = $true
            autoStartPolicy = $null; checkTimeoutMs = 3000; freshnessSeconds = 300; cooldownSeconds = 0; dependsOn = @()
            reasons = [ordered]@{ 'dependencies-ready' = 'Ready.'; 'dependency-missing' = 'Missing.'; 'dependency-version-unavailable' = 'Unavailable.' }
            guidance = [ordered]@{ 'review-runtime-installation' = [ordered]@{ text = 'Review.'; documentation = 'startup-health/README.md' } }
        }) }
        $runnerRegistryPath = Join-Path $runnerRoot 'checks.json'
        Write-SHAtomicJson $runnerRegistryPath $runnerRegistryDocument
        $runnerRegistry = Read-SHRegistry $runnerRegistryPath
        $nativeAssembly = Join-Path $runnerRoot 'native.dll'
        $null = Install-SHNativeAssembly $nativeAssembly
        $powershell = [string](Get-Command powershell.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
        $runnerManifest = [pscustomobject]@{
            frameworkRoot = $frameworkRoot
            nativeAssembly = [pscustomobject]@{ path = $nativeAssembly }
            runtimes = @([pscustomobject]@{ surface = 'codex'; file = Get-SHFileIdentity $powershell $nativeAssembly })
        }
        $scheduled = Invoke-SHProviderSchedule $runnerRegistry 'codex' $runnerManifest @() 5000 ([DateTimeOffset]'2026-10-25T00:00:00Z')
        Assert-SH ($scheduled.Results.ContainsKey('runtime-dependencies|global') -and $scheduled.NewCells.Count -eq 1 -and $scheduled.RefreshedKeys -contains 'runtime-dependencies|global') 'runner executes an applicable provider and creates one cache cell'
        $cached = Invoke-SHProviderSchedule $runnerRegistry 'codex' $runnerManifest $scheduled.NewCells 5000 ([DateTimeOffset]'2026-10-25T00:01:00Z')
        Assert-SH ($cached.NewCells.Count -eq 0 -and $cached.Results.ContainsKey('runtime-dependencies|global') -and $cached.RefreshedKeys.Count -eq 0) 'runner reuses a fresh per-cell result'

        $smokeState = Join-Path $runnerRoot 'smoke-state'
        [IO.Directory]::CreateDirectory($smokeState) | Out-Null
        $smokeHome = Join-Path $runnerRoot 'smoke-home'
        [IO.Directory]::CreateDirectory((Join-Path $smokeHome '.claude')) | Out-Null
        [IO.Directory]::CreateDirectory((Join-Path $smokeHome '.codex')) | Out-Null
        $ownedCommand = 'powershell.exe -NoProfile -File Invoke-StartupHealthHook.ps1 -Owner AIStartupHealthV1'
        foreach ($hookKey in @('claude', 'codex')) {
            $path = if ($hookKey -eq 'claude') { Join-Path $smokeHome '.claude\settings.json' } else { Join-Path $smokeHome '.codex\hooks.json' }
            Write-SHAtomicJson $path ([ordered]@{ hooks = [ordered]@{ SessionStart = @([ordered]@{
                matcher = '^(startup|resume)$'
                hooks = @([ordered]@{ type = 'command'; command = $ownedCommand; timeout = 75; async = $true })
            }) } })
        }
        $smokeClaude = Get-SHHookProjection (Join-Path $smokeHome '.claude\settings.json')
        $smokeCodex = Get-SHHookProjection (Join-Path $smokeHome '.codex\hooks.json')
        $nativeHash = Get-SHSha256 -Path $nativeAssembly
        $smokeManifest = [ordered]@{
            schemaVersion = 1; installed = $true; generation = 'smoke-generation'; frameworkRoot = $frameworkRoot
            nativeAssembly = [ordered]@{ path = $nativeAssembly; sha256 = $nativeHash }
            registry = [ordered]@{ path = $runnerRegistryPath; sha256 = Get-SHSha256 -Path $runnerRegistryPath }
            providers = [ordered]@{ 'runtime-dependencies' = [ordered]@{ path = (Join-Path $runnerRoot 'checks\runtime-dependencies.ps1'); sha256 = Get-SHSha256 -Path (Join-Path $runnerRoot 'checks\runtime-dependencies.ps1') } }
            diagnosticProbes = @()
            runtimes = @([ordered]@{ surface = 'codex'; file = Get-SHFileIdentity $powershell $nativeAssembly })
            hooks = [ordered]@{
                claude = [ordered]@{ configPath = (Join-Path $smokeHome '.claude\settings.json'); projectionSha256 = $smokeClaude.Sha256 }
                codex = [ordered]@{ configPath = (Join-Path $smokeHome '.codex\hooks.json'); projectionSha256 = $smokeCodex.Sha256 }
            }
            taskPolicy = [ordered]@{ id = 'lark-gateway-task-v1'; definition = $null }
        }
        Write-SHAtomicJson (Join-Path $smokeState 'install-manifest.json') $smokeManifest
        Write-SHAtomicJson (Join-Path $smokeState 'mode.json') ([ordered]@{ schemaVersion = 1; autoStart = 'warn-only' })
        Invoke-SHRunner -Manifest ([pscustomobject]$smokeManifest) -Surface 'codex' -StateRoot $smokeState
        $smokeLatest = Read-SHStateJson (Join-Path $smokeState 'latest.json')
        $smokeActivation = Read-SHStateJson (Join-Path $smokeState 'activation.json')
        Assert-SH ($null -ne $smokeLatest -and @($smokeLatest.cells | Where-Object key -eq 'runtime-dependencies|global').Count -eq 1) 'runner writes a normalized snapshot without auto-start'
        Assert-SH ($null -ne $smokeActivation -and $null -ne $smokeActivation.surfaces.PSObject.Properties['codex']) 'runner records warning-only activation evidence'

        $activationManifest = [pscustomobject]@{
            generation = 'g1'; runtimes = @([pscustomobject]@{ surface = 'claude' }, [pscustomobject]@{ surface = 'desktop' })
            hooks = [pscustomobject]@{ claude = [pscustomobject]@{ projectionSha256 = 'hc' }; codex = [pscustomobject]@{ projectionSha256 = 'hx' } }
        }
        $activation = [pscustomobject]@{ schemaVersion = 1; generation = 'g1'; surfaces = [pscustomobject]@{
            claude = [pscustomobject]@{ passed = $true; generation = 'g1'; manifestSha256 = 'mh'; hookProjectionSha256 = 'hc' }
            desktop = [pscustomobject]@{ passed = $true; generation = 'g1'; manifestSha256 = 'mh'; hookProjectionSha256 = 'hx' }
        } }
        Assert-SH (Test-SHActivationComplete $activation $activationManifest 'mh') 'activation requires current evidence for every installed surface'
        $activation.surfaces.desktop.passed = $false
        Assert-SH (-not (Test-SHActivationComplete $activation $activationManifest 'mh')) 'a failed surface canary blocks auto-start enablement'
    }

    if ((Test-SHGroup 'Activation') -or (Test-SHGroup 'Enablement') -or (Test-SHGroup 'Uninstall') -or (Test-SHGroup 'Rollback')) {
        $frameworkRoot = Split-Path -Parent $PSScriptRoot
        $lifecycleRoot = Join-Path $testRoot 'lifecycle'
        $profileRoot = Join-Path $lifecycleRoot 'profile'
        $stateRoot = Join-Path $lifecycleRoot 'state'
        [IO.Directory]::CreateDirectory((Join-Path $profileRoot '.claude')) | Out-Null
        [IO.Directory]::CreateDirectory((Join-Path $profileRoot '.codex')) | Out-Null
        [IO.Directory]::CreateDirectory($stateRoot) | Out-Null
        $node = [string](Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
        $powershell = [string](Get-Command powershell.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
        Import-Module (Join-Path $frameworkRoot 'StartupHealthInstaller.psm1') -Force
        $hookCommand = New-SHOwnedHookCommand $powershell (Join-Path $frameworkRoot 'Invoke-StartupHealthHook.ps1')
        $hookMap = [ordered]@{}
        foreach ($key in @('claude', 'codex')) {
            $configPath = if ($key -eq 'claude') { Join-Path $profileRoot '.claude\settings.json' } else { Join-Path $profileRoot '.codex\hooks.json' }
            $emptyPath = Join-Path $lifecycleRoot ($key + '-empty.json')
            $candidatePath = Join-Path $lifecycleRoot ($key + '-candidate.json')
            [IO.File]::WriteAllText($emptyPath, '{"retained":true}', [Text.UTF8Encoding]::new($false))
            $null = Invoke-SHConfigEditor $node install $emptyPath $candidatePath $hookCommand $frameworkRoot
            [IO.File]::Move($candidatePath, $configPath)
            $projection = Get-SHHookProjection $configPath
            $hookMap[$key] = [ordered]@{ configPath = $configPath; projectionSha256 = $projection.Sha256; installedSha256 = Get-SHSha256 -Path $configPath }
        }
        $lifecycleManifest = [ordered]@{ schemaVersion = 1; installed = $true; generation = 'lifecycle-generation'; hooks = $hookMap }
        Write-SHAtomicJson (Join-Path $stateRoot 'install-manifest.json') $lifecycleManifest
        Write-SHAtomicJson (Join-Path $stateRoot 'mode.json') ([ordered]@{ schemaVersion = 1; autoStart = 'enabled'; generation = 'lifecycle-generation' })
        if ((Test-SHGroup 'Rollback') -or (Test-SHGroup 'Enablement')) {
            $disable = Invoke-SHIsolatedProcess $powershell @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $frameworkRoot 'Disable-StartupHealthAutoStart.ps1'), '-StateRoot', $stateRoot) $frameworkRoot 5000 8192
            $disabledMode = (Get-Content -Raw (Join-Path $stateRoot 'mode.json') | ConvertFrom-Json).autoStart
            Assert-SH ($disable.ExitCode -eq 0 -and $disabledMode -eq 'warn-only') "auto-start rollback retains checks and sets warn-only atomically (exit=$($disable.ExitCode), mode=$disabledMode, stderr=$($disable.Stderr))"
        }
        if ((Test-SHGroup 'Activation') -or (Test-SHGroup 'Enablement')) {
            Write-SHAtomicJson (Join-Path $stateRoot 'activation.json') ([ordered]@{ schemaVersion = 1; generation = 'lifecycle-generation'; status = 'pending'; surfaces = [ordered]@{} })
            $enable = Invoke-SHIsolatedProcess $powershell @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $frameworkRoot 'Enable-StartupHealthAutoStart.ps1'), '-StateRoot', $stateRoot) $frameworkRoot 5000 8192
            Assert-SH ($enable.ExitCode -ne 0 -and (Get-Content -Raw (Join-Path $stateRoot 'mode.json') | ConvertFrom-Json).autoStart -ne 'enabled') 'enablement fails closed when validation or canary evidence is incomplete'
        }
        if (Test-SHGroup 'Uninstall') {
            $uninstall = Invoke-SHIsolatedProcess $powershell @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $frameworkRoot 'Uninstall-StartupHealth.ps1'), '-StateRoot', $stateRoot, '-UserHome', $profileRoot, '-Force') $frameworkRoot 10000 16384
            if ($uninstall.ExitCode -ne 0) { throw "Uninstall fixture failed: $($uninstall.Stderr)" }
            Assert-SH ((Get-Content -Raw (Join-Path $profileRoot '.claude\settings.json')) -notmatch 'AIStartupHealthV1' -and (Get-Content -Raw (Join-Path $profileRoot '.codex\hooks.json')) -notmatch 'AIStartupHealthV1') 'uninstall removes only the owned hooks from both configurations'
            $retainedManifest = Get-Content -Raw (Join-Path $stateRoot 'install-manifest.json') | ConvertFrom-Json
            Assert-SH (-not $retainedManifest.installed -and (Test-Path -LiteralPath (Join-Path $stateRoot 'mode.json'))) 'uninstall retains audit state and marks the manifest uninstalled'
        }
    }

    if ((Test-SHGroup 'Reporting') -or (Test-SHGroup 'Envelopes')) {
        $warnings = @(1..12 | ForEach-Object { [pscustomobject]@{ id = "check-$_"; status = if ($_ -eq 1) { 'error' } else { 'warn' }; reasonCode = "reason-$_"; registryOrder = $_ } })
        $payload = Format-SHWarningPayload $warnings
        Assert-SH ([Text.Encoding]::UTF8.GetByteCount($payload) -le 1024) 'warning payload respects the byte cap'
        Assert-SH (@($payload -split ' \| ').Count -le 9 -and $payload -match 'more-warnings=warn\(omitted-') 'warning payload keeps eight segments plus a bounded omission segment'
        Assert-SH ($payload.IndexOf('check-1=error') -lt $payload.IndexOf('check-2=warn')) 'warning ordering prefers errors then registry order'
        $envelope = ConvertTo-SHSystemMessageEnvelope $warnings
        $parsed = $envelope | ConvertFrom-Json
        Assert-SH ([Text.Encoding]::UTF8.GetByteCount($envelope) -le 1280 -and $parsed.systemMessage -eq $payload) 'systemMessage envelope respects its complete byte cap'
        Assert-SH (@($parsed.PSObject.Properties).Count -eq 1 -and $null -eq $parsed.PSObject.Properties['continue']) 'envelope contains no control fields'

        $now = [DateTimeOffset]'2026-10-25T01:00:00Z'
        $hash = Get-SHWarningSetHash $warnings
        $ledger = [pscustomobject]@{ codex = [pscustomobject]@{ hash = $hash; notifiedAt = '2026-10-25T00:45:00Z' } }
        Assert-SH (-not (Test-SHShouldNotify $ledger 'codex' $warnings $now 30)) 'identical warning set is suppressed inside 30 minutes'
        Assert-SH (Test-SHShouldNotify $ledger 'desktop' $warnings $now 30) 'notification suppression is surface-specific'
        $changed = @($warnings | Select-Object -First 1)
        Assert-SH (Test-SHShouldNotify $ledger 'codex' $changed $now 30) 'changed warning set is immediately eligible'
    }

    [pscustomobject]@{ Passed = $script:Passed; Groups = $Group } | ConvertTo-Json -Compress
} finally {
    if ($testRoot.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $testRoot)) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
