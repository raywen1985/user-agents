param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)][string]$SvnExecutable
)

$ErrorActionPreference = 'Stop'

function Write-Decision([bool]$Safe, [string]$Reason) {
    [Console]::Out.WriteLine(([ordered]@{ version = 1; safe = $Safe; reason = $Reason } |
        ConvertTo-Json -Compress))
}

function Fail([string]$Reason) {
    Write-Decision $false $Reason
    exit 0
}

function Get-CanonicalPath([string]$Value) {
    $current = [IO.Path]::GetFullPath($Value)
    while (-not (Test-Path -LiteralPath $current)) {
        $parent = [IO.Directory]::GetParent($current)
        if ($null -eq $parent) { throw 'No existing ancestor' }
        $current = $parent.FullName
    }
    return (Get-Item -LiteralPath $current -Force).FullName
}

function Test-Within([string]$Root, [string]$Candidate) {
    $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $candidatePath = [IO.Path]::GetFullPath($Candidate).TrimEnd('\')
    return $candidatePath -ieq $rootPath -or $candidatePath.StartsWith($rootPath + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Test-Protected([string]$Candidate, [string[]]$ProtectedPaths) {
    foreach ($protected in $ProtectedPaths) {
        if ((Test-Within $Candidate $protected) -or (Test-Within $protected $Candidate)) { return $true }
    }
    return $false
}

try {
    $raw = [Console]::In.ReadToEnd()
    if ([Text.Encoding]::UTF8.GetByteCount($raw) -gt 32768) { Fail 'invalid_request' }
    $request = $raw | ConvertFrom-Json
    if ($request.version -ne 1 -or $request.cwd -isnot [string] -or $request.target -isnot [string] -or
        $request.protectedPaths -isnot [array]) { Fail 'invalid_request' }

    $root = (Get-Item -LiteralPath $ProjectRoot -Force).FullName
    $cwd = (Get-Item -LiteralPath $request.cwd -Force).FullName
    if (-not (Test-Within $root $cwd)) { Fail 'unsafe_path' }
    $targetInput = if ([IO.Path]::IsPathRooted($request.target)) { $request.target } else { Join-Path $cwd $request.target }
    $target = Get-CanonicalPath $targetInput
    if (-not (Test-Within $root $target)) { Fail 'unsafe_path' }
    $protected = @($request.protectedPaths | ForEach-Object { [IO.Path]::GetFullPath([string]$_) })
    if (Test-Protected $target $protected) { Fail 'protected_path' }

    $xmlText = & $SvnExecutable status --xml --depth infinity -- $targetInput 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($xmlText -join "`n"))) { Fail 'svn_status_failed' }
    [xml]$xml = $xmlText -join "`n"
    foreach ($entry in @($xml.status.target.entry)) {
        if ($null -eq $entry.path) { Fail 'invalid_status' }
        $entryInput = if ([IO.Path]::IsPathRooted([string]$entry.path)) { [string]$entry.path } else { Join-Path $cwd ([string]$entry.path) }
        $entryPath = Get-CanonicalPath $entryInput
        if (-not (Test-Within $root $entryPath) -or (Test-Protected $entryPath $protected)) { Fail 'unsafe_status_entry' }
    }
    Write-Decision $true 'safe_svn_revert'
} catch {
    Write-Decision $false 'invalid_request'
}
