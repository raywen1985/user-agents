[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'TokenMeter.psm1') -Force
$paths=Get-TMPaths
if(-not (Test-Path -LiteralPath $paths.Manifest)){throw 'Token meter install manifest was not found.'}
$manifest=Get-Content -Raw $paths.Manifest|ConvertFrom-Json
$profile=$paths.Profile
$claudePath=Join-Path $profile '.claude\settings.json';$codexHooksPath=Join-Path $profile '.codex\hooks.json';$configPath=Join-Path $profile '.codex\config.toml'
function New-PortableScriptCommand([string]$FileName){$script="`$ProgressPreference='SilentlyContinue'`n`$scriptPath=[IO.Path]::Combine([Environment]::GetFolderPath('UserProfile'),'.agents','token-meter','$FileName')`n& `$scriptPath`nexit `$LASTEXITCODE";$encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script));return "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"}
function Test-TokenMeterScriptCommand([string]$Command,[string]$FileName){if($Command-match'(?i)token-meter[\\/]+'+[regex]::Escape($FileName)){return $true};if($Command-notmatch'(?i)-EncodedCommand\s+([A-Za-z0-9+/=]+)'){return $false};try{$decoded=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($matches[1]));return $decoded-match"(?i)token-meter.*$([regex]::Escape($FileName))"}catch{return $false}}
$claudeCommand=New-PortableScriptCommand 'ClaudeTurnHook.ps1';$codexCommand=New-PortableScriptCommand 'CodexTurnHook.ps1';$statusCommand=New-PortableScriptCommand 'ClaudeStatusLine.ps1'
if(Test-Path -LiteralPath $claudePath){$c=Get-Content -Raw $claudePath|ConvertFrom-Json;if($c.hooks.Stop){$new=@();foreach($m in @($c.hooks.Stop)){$m.hooks=@($m.hooks|Where-Object{-not(Test-TokenMeterScriptCommand ([string]$_.command) 'ClaudeTurnHook.ps1') -and [string]$_.command -notmatch '(?i)token-meter[\\/]+Invoke-ClaudeTurnHook\.cmd'});if(@($m.hooks).Count -gt 0){$new+=$m}};$c.hooks.Stop=$new};$ownedStatus=Test-TokenMeterScriptCommand ([string]$c.statusLine.command) 'ClaudeStatusLine.ps1' -or [string]$c.statusLine.command -match '(?i)token-meter[\\/]+Invoke-ClaudeStatusLine\.cmd';if($ownedStatus){if($manifest.claude_status_existed){$c.statusLine=$manifest.claude_status_previous}else{$c.PSObject.Properties.Remove('statusLine')}};Write-TMAtomicJson $claudePath $c}
if(Test-Path -LiteralPath $codexHooksPath){$h=Get-Content -Raw $codexHooksPath|ConvertFrom-Json;if($h.hooks.Stop){$new=@();foreach($m in @($h.hooks.Stop)){$m.hooks=@($m.hooks|Where-Object{-not(Test-TokenMeterScriptCommand ([string]$_.command) 'CodexTurnHook.ps1') -and [string]$_.command -notmatch '(?i)token-meter[\\/]+Invoke-CodexTurnHook\.cmd'});if(@($m.hooks).Count -gt 0){$new+=$m}};$h.hooks.Stop=$new};Write-TMAtomicJson $codexHooksPath $h}
if(Test-Path -LiteralPath $configPath){$text=[IO.File]::ReadAllText($configPath);$text=[regex]::Replace($text,'(?m)^\s*(?:tui\.)?status_line\s*=\s*\[''model-with-reasoning'',\s*''context-remaining'',\s*''current-dir''\]\s*\r?\n?','');[IO.File]::WriteAllText($configPath,$text,[Text.UTF8Encoding]::new($false))}
'Token meter hooks and status-line entries were removed. History data was preserved.'
