param(
    [Parameter(Mandatory = $true)][string]$ModulePath,
    [Parameter(Mandatory = $true)][string]$MutexName
)

$ErrorActionPreference = 'Stop'
Import-Module $ModulePath -Force
$lease = Enter-SHMutex -NameOverride $MutexName -WaitMilliseconds 0
try {
    [Console]::Out.Write((@{ acquired = [bool]$lease.Acquired } | ConvertTo-Json -Compress))
} finally {
    Exit-SHMutex $lease
}
