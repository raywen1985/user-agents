$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class SessionProbeNative {
    public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    public const uint STILL_ACTIVE = 259;

    [StructLayout(LayoutKind.Sequential)]
    public struct FILETIME {
        public uint Low;
        public uint High;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetProcessTimes(
        IntPtr process,
        out FILETIME creation,
        out FILETIME exit,
        out FILETIME kernel,
        out FILETIME user);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr handle);
}
'@

function Result([string]$id, [string]$state, [Nullable[int]]$code, [string]$procStart) {
    [ordered]@{ id = $id; state = $state; code = $code; procStart = $procStart }
}

$raw = [Console]::In.ReadToEnd()
if ([Text.Encoding]::UTF8.GetByteCount($raw) -gt 262144) { throw 'Input too large' }
$request = $raw | ConvertFrom-Json
$locks = @($request.locks)
$processes = @($request.processes)
if (($locks.Count + $processes.Count) -gt 512) { throw 'Too many probes' }

$lockResults = foreach ($item in $locks) {
    $stream = $null
    try {
        $stream = [IO.File]::Open([string]$item.path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
        Result ([string]$item.id) 'free' $null $null
    } catch [IO.FileNotFoundException] {
        Result ([string]$item.id) 'missing' 2 $null
    } catch [UnauthorizedAccessException] {
        Result ([string]$item.id) 'accessDenied' 5 $null
    } catch [IO.IOException] {
        $code = $_.Exception.HResult -band 0xFFFF
        if ($code -eq 32 -or $code -eq 33) { Result ([string]$item.id) 'held' $code $null }
        else { Result ([string]$item.id) 'error' $code $null }
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

$processResults = foreach ($item in $processes) {
    $pidValue = [uint32]$item.pid
    $handle = [SessionProbeNative]::OpenProcess([SessionProbeNative]::PROCESS_QUERY_LIMITED_INFORMATION, $false, $pidValue)
    if ($handle -eq [IntPtr]::Zero) {
        $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($code -eq 87) { Result ([string]$item.id) 'exited' $code $null }
        elseif ($code -eq 5) { Result ([string]$item.id) 'accessDenied' $code $null }
        else { Result ([string]$item.id) 'error' $code $null }
        continue
    }
    try {
        [uint32]$exitCode = 0
        if (-not [SessionProbeNative]::GetExitCodeProcess($handle, [ref]$exitCode)) {
            $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
            if ($code -eq 6) { Result ([string]$item.id) 'exited' $code $null }
            else { Result ([string]$item.id) 'error' $code $null }
            continue
        }
        if ($exitCode -ne [SessionProbeNative]::STILL_ACTIVE) {
            Result ([string]$item.id) 'exited' ([int]$exitCode) $null
            continue
        }
        $creation = New-Object SessionProbeNative+FILETIME
        $exit = New-Object SessionProbeNative+FILETIME
        $kernel = New-Object SessionProbeNative+FILETIME
        $user = New-Object SessionProbeNative+FILETIME
        if (-not [SessionProbeNative]::GetProcessTimes($handle, [ref]$creation, [ref]$exit, [ref]$kernel, [ref]$user)) {
            $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
            if ($code -eq 6) { Result ([string]$item.id) 'exited' $code $null }
            else { Result ([string]$item.id) 'error' $code $null }
            continue
        }
        [uint64]$fileTime = ([uint64]$creation.High * [uint64]4294967296) + [uint64]$creation.Low
        $actual = $fileTime.ToString([Globalization.CultureInfo]::InvariantCulture)
        if ($actual -eq [string]$item.procStart) { Result ([string]$item.id) 'live' $null $actual }
        else { Result ([string]$item.id) 'reused' $null $actual }
    } finally {
        [void][SessionProbeNative]::CloseHandle($handle)
    }
}

[ordered]@{ locks = @($lockResults); processes = @($processResults) } | ConvertTo-Json -Compress -Depth 5
