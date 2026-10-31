$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$results = foreach ($entry in $request) {
    $process = $null
    $state = 'unknown'
    $reason = $null
    try {
        $process = [Diagnostics.Process]::GetProcessById([int]$entry.pid)
        if ($process.HasExited) {
            $state = 'inactive'
        } else {
            $actualStart = $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)
            if ($entry.procStart -and ([string]$entry.procStart -ne $actualStart)) {
                $state = 'inactive'
                $reason = 'PID was reused by another process'
            } else {
                $state = 'active'
            }
        }
    } catch [ArgumentException] {
        $state = 'inactive'
    } catch {
        $reason = $_.Exception.Message
    } finally {
        if ($null -ne $process) { $process.Dispose() }
    }
    [ordered]@{ key = [string]$entry.key; state = $state; reason = $reason }
}
ConvertTo-Json -InputObject @($results) -Compress -Depth 4
