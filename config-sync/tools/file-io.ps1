[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('SecureDirectory','Replace')][string]$Operation,
    [Parameter(Mandatory)][string]$Target,
    [string]$Candidate,
    [string]$ExpectedHash = 'missing'
)
$ErrorActionPreference = 'Stop'
try {
    if ($Operation -eq 'SecureDirectory') {
        if (Test-Path -LiteralPath $Target) {
            if ((Get-Item -LiteralPath $Target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point' }
        } else { [IO.Directory]::CreateDirectory($Target) | Out-Null }
        $acl = New-Object Security.AccessControl.DirectorySecurity
        $acl.SetAccessRuleProtection($true, $false)
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
        foreach ($identity in @($sid, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
            $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
            $acl.AddAccessRule($rule)
        }
        [IO.Directory]::SetAccessControl($Target, $acl)
        exit 0
    }
    $exists = Test-Path -LiteralPath $Target -PathType Leaf
    $actual = 'missing'
    if ($exists) {
        $sha = [Security.Cryptography.SHA256]::Create()
        $stream = [IO.File]::OpenRead($Target)
        try { $actual = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
        finally { $stream.Dispose(); $sha.Dispose() }
    }
    if ($actual -cne $ExpectedHash) { exit 42 }
    if ($exists) {
        if ((Get-Item -LiteralPath $Target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point' }
        [IO.File]::SetAccessControl($Candidate, [IO.File]::GetAccessControl($Target))
        [IO.File]::Replace($Candidate, $Target, [NullString]::Value, $false)
    } else { [IO.File]::Move($Candidate, $Target) }
    exit 0
} catch {
    # Exceptions can contain file content and machine paths. Return a fixed diagnostic.
    [Console]::Error.WriteLine(('config-sync file operation failed ({0}, line {1}, HRESULT {2})' -f $_.Exception.GetType().Name, $_.InvocationInfo.ScriptLineNumber, $_.Exception.HResult))
    exit 1
}
