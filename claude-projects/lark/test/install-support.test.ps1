param([Parameter(Mandatory = $true)][string]$SupportPath)

$ErrorActionPreference = 'Stop'
. $SupportPath

function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

$root = Join-Path ([IO.Path]::GetTempPath()) ('lark-install-test-' + [Guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path (Join-Path $root '.claude'), (Join-Path $root 'config'), (Join-Path $root 'run') | Out-Null
    $settingsPath = Join-Path $root '.claude\settings.local.json'
    $statePath = Join-Path $root '.claude\install-state.local.json'
    $firstExecutables = [ordered]@{ larkCli = 'C:\ToolsA\lark-cli.exe'; claude = 'C:\ToolsA\claude.exe' }
    $firstPermissions = @(Get-ManagedClaudePermissions $firstExecutables)
    @{ permissions = @{ allow = @('UserRule', $firstPermissions[0]) } } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $settingsPath

    $first = New-ClaudeSettingsContent $settingsPath $statePath $firstExecutables ('a' * 32)
    Assert ($first.settings.permissions.allow -contains 'UserRule') 'first run removed an unmanaged permission'
    Assert ($first.settings.permissions.allow -contains $firstPermissions[0]) 'first run removed a preexisting matching permission'
    Assert ($first.state.managedPermissions -notcontains $firstPermissions[0]) 'first run adopted a preexisting permission'
    Assert ($first.state.managedPermissions.Count -eq 7) 'first run ownership count is wrong'

    ConvertTo-JsonText $first.settings | Set-Content -LiteralPath $settingsPath -NoNewline
    ConvertTo-JsonText $first.state | Set-Content -LiteralPath $statePath -NoNewline
    $secondExecutables = [ordered]@{ larkCli = 'C:\ToolsB\lark-cli.exe'; claude = 'C:\ToolsB\claude.exe' }
    $second = New-ClaudeSettingsContent $settingsPath $statePath $secondExecutables ('b' * 32)
    $secondPermissions = @(Get-ManagedClaudePermissions $secondExecutables)
    Assert ($second.settings.permissions.allow -contains 'UserRule') 'second run removed an unmanaged permission'
    Assert ($second.settings.permissions.allow -contains $firstPermissions[0]) 'second run removed a preexisting unowned permission'
    foreach ($permission in $secondPermissions) { Assert ($second.settings.permissions.allow -contains $permission) 'second run missed a generated permission' }

    Write-TextFile (Join-Path $root 'config\gateway.local.json') "old`r`n"
    $generation = 'c' * 32
    $contents = [ordered]@{ gateway = '{}'; projects = '{}'; settings = '{}'; state = '{}' }
    $proposed = [ordered]@{ execute = 'C:\Tools\node.exe'; arguments = 'entry generation'; workingDirectory = $root; entryPoint = (Join-Path $root 'entry.mjs') }
    $taskName = 'LarkInstallTest-' + [Guid]::NewGuid().ToString('N')
    $manifest = New-InstallationTransaction $root $taskName $generation $contents $proposed
    Assert ((Test-Path -LiteralPath (Join-Path $root 'run\install-transaction\active.json'))) 'active recovery journal was not published'
    $gatewayTarget = @($manifest.targets | Where-Object id -eq 'gateway')[0]
    $projectsTarget = @($manifest.targets | Where-Object id -eq 'projects')[0]
    Assert ($gatewayTarget.existed -eq $true -and $gatewayTarget.sha256) 'existing target backup metadata is incomplete'
    Assert ($projectsTarget.existed -eq $false) 'absent target tombstone is missing'

    [pscustomobject]@{ ok = $true; permissions = $secondPermissions.Count; targets = @($manifest.targets).Count } | ConvertTo-Json -Compress
} finally {
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
