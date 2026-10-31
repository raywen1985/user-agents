$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$raw = [Console]::In.ReadToEnd()
if ([Text.Encoding]::UTF8.GetByteCount($raw) -gt 2097152) { throw 'Request too large' }
$request = $raw | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class OffWorkNative {
  [StructLayout(LayoutKind.Sequential)] public struct FT { public uint Low; public uint High; }
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessTimes(IntPtr h, out FT c, out FT e, out FT k, out FT u);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder name, ref uint size);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr h, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool IsProcessInJob(IntPtr h, IntPtr job, out bool result);
  [DllImport("advapi32.dll", SetLastError=true)] public static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr token);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr window, uint msg, IntPtr w, IntPtr l);
  public static string Start(IntPtr h) {
    FT c,e,k,u; if(!GetProcessTimes(h,out c,out e,out k,out u)) throw new Exception("start_unreadable");
    return (((ulong)c.High << 32) | c.Low).ToString(System.Globalization.CultureInfo.InvariantCulture);
  }
  public static string Path(IntPtr h) {
    var b=new StringBuilder(32768); uint n=32768;
    if(!QueryFullProcessImageName(h,0,b,ref n)) throw new Exception("path_unreadable"); return b.ToString();
  }
  public static string Sid(IntPtr h) {
    IntPtr t; if(!OpenProcessToken(h,8,out t)) throw new Exception("owner_unreadable");
    try { using(var id=new WindowsIdentity(t)) { return id.User.Value; } } finally { CloseHandle(t); }
  }
}
'@
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$currentSession = [Diagnostics.Process]::GetCurrentProcess().SessionId

if ($request.action -eq 'worker-check') {
    $handle = [OffWorkNative]::OpenProcess(0x1000, $false, [uint32]$request.pid)
    try {
        if ($handle -eq [IntPtr]::Zero) { throw 'Worker unavailable' }
        $inJob = $true
        $ok = [OffWorkNative]::IsProcessInJob($handle, [IntPtr]::Zero, [ref]$inJob)
        @{ independent = ($ok -and -not $inJob -and [OffWorkNative]::Sid($handle) -eq $currentSid) } | ConvertTo-Json -Compress
    } finally { if ($handle -ne [IntPtr]::Zero) { [void][OffWorkNative]::CloseHandle($handle) } }
    exit
}

if ($request.action -eq 'snapshot') {
    $all = @(Get-CimInstance Win32_Process)
    if ($all.Count -gt 10000) { throw 'Process limit exceeded' }
    $versions = @{}
    $rows = foreach ($row in $all) {
        $handle = [OffWorkNative]::OpenProcess(0x101000, $false, [uint32]$row.ProcessId)
        $start = $null; $exe = $row.ExecutablePath; $owner = $null
        try {
            if ($handle -ne [IntPtr]::Zero) {
                $start = [OffWorkNative]::Start($handle)
                $observedStart = $row.CreationDate.ToUniversalTime().ToFileTimeUtc()
                if ([Math]::Abs([long]$start - $observedStart) -gt 10) { throw 'Snapshot PID reused' }
                $exe = [OffWorkNative]::Path($handle)
                $owner = [OffWorkNative]::Sid($handle)
            }
        } catch { $start = $null; $owner = $null } finally { if ($handle -ne [IntPtr]::Zero) { [void][OffWorkNative]::CloseHandle($handle) } }
        if ($owner -and $owner -ne $currentSid) { continue }
        # Keep inaccessible same-login rows so discovery cannot mistake them for absence.
        if (-not $owner -and $row.SessionId -ne $currentSession) { continue }
        $product = $null; $company = $null
        if ($exe -and $row.Name -match '^(codex|chatgpt|claude|opencode|opencode-cli)\.exe$') {
            if (-not $versions.ContainsKey($exe)) {
                try { $versions[$exe] = [Diagnostics.FileVersionInfo]::GetVersionInfo($exe) } catch { $versions[$exe] = $null }
            }
            $product = $versions[$exe].ProductName; $company = $versions[$exe].CompanyName
        }
        [ordered]@{ pid=[int]$row.ProcessId; parentPid=[int]$row.ParentProcessId; sessionId=[int]$row.SessionId;
            procStart=$start; executable=$exe; ownerSid=$owner; name=$row.Name;
            product=$product; company=$company; commandLine=$row.CommandLine }
    }
    @{ complete=$true; ownerSid=$currentSid; sessionId=$currentSession; processes=@($rows); warnings=@() } | ConvertTo-Json -Depth 5 -Compress
    exit
}

if ($request.action -ne 'shutdown') { throw 'Unsupported action' }
$targets = @($request.targets)
if ($targets.Count -gt 2048) { throw 'Target limit exceeded' }
$held = @(); $outcomes = @()
try {
    foreach ($target in $targets) {
        if ([int]$target.pid -le 0 -or $target.procStart -notmatch '^\d{10,20}$' -or -not [IO.Path]::IsPathRooted($target.executable)) { throw 'Invalid target' }
        $item = [ordered]@{ pid=[int]$target.pid; procStart=[string]$target.procStart; state='unverified' }
        $handle = [OffWorkNative]::OpenProcess(0x101001, $false, [uint32]$target.pid)
        if ($handle -eq [IntPtr]::Zero) {
            $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
            $item.state = if ($code -eq 87) { 'exited' } else { 'access_denied' }
            $outcomes += $item; continue
        }
        $accepted = $false
        try {
            if ([OffWorkNative]::WaitForSingleObject($handle, 0) -eq 0) { $item.state='exited' }
            elseif ([OffWorkNative]::Start($handle) -ne $target.procStart -or [OffWorkNative]::Path($handle) -ine $target.executable -or
                [OffWorkNative]::Sid($handle) -ne $currentSid -or $target.ownerSid -ne $currentSid) { $item.state='identity_changed' }
            else {
                $window = [IntPtr]::Zero
                $processObject = [Diagnostics.Process]::GetProcessById([int]$target.pid)
                try { $window = $processObject.MainWindowHandle } finally { $processObject.Dispose() }
                [uint32]$windowPid = 0
                if ($target.kind -eq 'desktop' -and $window -ne [IntPtr]::Zero) {
                    [void][OffWorkNative]::GetWindowThreadProcessId($window, [ref]$windowPid)
                    if ($windowPid -ne $target.pid -or [OffWorkNative]::WaitForSingleObject($handle, 0) -eq 0) {
                        $item.state='window_changed'
                    } else {
                        [void][OffWorkNative]::PostMessage($window, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
                        $accepted=$true
                    }
                } else { $accepted=$true }
                if ($accepted) { $held += @{ handle=$handle; item=$item } }
            }
        } catch { $item.state='identity_unverified' }
        if (-not $accepted) { [void][OffWorkNative]::CloseHandle($handle); $outcomes += $item }
    }
    # Desktop close is cooperative; terminal clients have no safe universal input injection.
    if ($held.Count) { Start-Sleep -Milliseconds 1500 }
    foreach ($entry in $held) {
        if ([OffWorkNative]::WaitForSingleObject($entry.handle, 0) -eq 0) { $entry.item.state='closed' }
        elseif ([OffWorkNative]::TerminateProcess($entry.handle, 1)) { $entry.item.state='signaled' }
        else { $entry.item.state='terminate_failed' }
    }
    # One shared deadline, not a per-process timeout multiplied by the process count.
    $deadline = [DateTime]::UtcNow.AddSeconds(3)
    do {
        $pending = $false
        foreach ($entry in $held) {
            if ($entry.item.state -eq 'signaled') {
                if ([OffWorkNative]::WaitForSingleObject($entry.handle, 0) -eq 0) { $entry.item.state='terminated' }
                else { $pending=$true }
            }
        }
        if ($pending) { Start-Sleep -Milliseconds 50 }
    } while ($pending -and [DateTime]::UtcNow -lt $deadline)
    foreach ($entry in $held) {
        if ($entry.item.state -eq 'signaled') { $entry.item.state='timeout' }
        $outcomes += $entry.item
    }
    @{ outcomes=@($outcomes) } | ConvertTo-Json -Depth 4 -Compress
} finally {
    foreach ($entry in $held) { [void][OffWorkNative]::CloseHandle($entry.handle) }
}
