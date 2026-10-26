$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class SessionProbeNative {
    public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    public const uint PROCESS_TERMINATE = 0x0001;
    public const uint SYNCHRONIZE = 0x00100000;
    public const uint STILL_ACTIVE = 259;
    public const uint WAIT_OBJECT_0 = 0;
    public const uint WAIT_TIMEOUT = 258;

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
    public static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

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
$terminate = $request.terminate
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

$terminateResult = $null
if ($null -ne $terminate) {
    $pidValue = [uint32]$terminate.pid
    $expectedStart = [string]$terminate.procStart
    $waitMs = [uint32]$terminate.waitMs
    if ($pidValue -eq 0 -or $expectedStart -notmatch '^\d{10,20}$' -or $waitMs -lt 1 -or $waitMs -gt 5000) {
        throw 'Invalid terminate request'
    }
    $access = [SessionProbeNative]::PROCESS_QUERY_LIMITED_INFORMATION -bor [SessionProbeNative]::PROCESS_TERMINATE -bor [SessionProbeNative]::SYNCHRONIZE
    $handle = [SessionProbeNative]::OpenProcess($access, $false, $pidValue)
    if ($handle -eq [IntPtr]::Zero) {
        $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($code -eq 87) { $terminateResult = [ordered]@{ state = 'alreadyExited'; code = $code; procStart = $null } }
        elseif ($code -eq 5) { $terminateResult = [ordered]@{ state = 'accessDenied'; code = $code; procStart = $null } }
        else { $terminateResult = [ordered]@{ state = 'error'; code = $code; procStart = $null } }
    } else {
        try {
            [uint32]$exitCode = 0
            if (-not [SessionProbeNative]::GetExitCodeProcess($handle, [ref]$exitCode)) {
                $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
                $terminateResult = [ordered]@{ state = 'error'; code = $code; procStart = $null }
            } elseif ($exitCode -ne [SessionProbeNative]::STILL_ACTIVE) {
                $terminateResult = [ordered]@{ state = 'alreadyExited'; code = [int]$exitCode; procStart = $null }
            } else {
                $creation = New-Object SessionProbeNative+FILETIME
                $exit = New-Object SessionProbeNative+FILETIME
                $kernel = New-Object SessionProbeNative+FILETIME
                $user = New-Object SessionProbeNative+FILETIME
                if (-not [SessionProbeNative]::GetProcessTimes($handle, [ref]$creation, [ref]$exit, [ref]$kernel, [ref]$user)) {
                    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
                    $terminateResult = [ordered]@{ state = 'error'; code = $code; procStart = $null }
                } else {
                    [uint64]$fileTime = ([uint64]$creation.High * [uint64]4294967296) + [uint64]$creation.Low
                    $actual = $fileTime.ToString([Globalization.CultureInfo]::InvariantCulture)
                    if ($actual -ne $expectedStart) {
                        $terminateResult = [ordered]@{ state = 'reused'; code = $null; procStart = $actual }
                    } elseif (-not [SessionProbeNative]::TerminateProcess($handle, 1)) {
                        $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
                        [uint32]$afterCode = 0
                        if ([SessionProbeNative]::GetExitCodeProcess($handle, [ref]$afterCode) -and $afterCode -ne [SessionProbeNative]::STILL_ACTIVE) {
                            $terminateResult = [ordered]@{ state = 'alreadyExited'; code = [int]$afterCode; procStart = $actual }
                        } elseif ($code -eq 5) {
                            $terminateResult = [ordered]@{ state = 'accessDenied'; code = $code; procStart = $actual }
                        } else {
                            $terminateResult = [ordered]@{ state = 'error'; code = $code; procStart = $actual }
                        }
                    } else {
                        $wait = [SessionProbeNative]::WaitForSingleObject($handle, $waitMs)
                        if ($wait -eq [SessionProbeNative]::WAIT_OBJECT_0) {
                            $terminateResult = [ordered]@{ state = 'terminated'; code = $null; procStart = $actual }
                        } elseif ($wait -eq [SessionProbeNative]::WAIT_TIMEOUT) {
                            $terminateResult = [ordered]@{ state = 'timeout'; code = $null; procStart = $actual }
                        } else {
                            $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
                            $terminateResult = [ordered]@{ state = 'error'; code = $code; procStart = $actual }
                        }
                    }
                }
            }
        } finally {
            [void][SessionProbeNative]::CloseHandle($handle)
        }
    }
}

[ordered]@{ locks = @($lockResults); processes = @($processResults); terminate = $terminateResult } | ConvertTo-Json -Compress -Depth 5
