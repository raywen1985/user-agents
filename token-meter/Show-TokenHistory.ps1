[CmdletBinding()]
param(
    [ValidateSet('claude','codex')][string]$Cli,
    [ValidateSet('All','Today')][string]$Period = 'All',
    [int]$Last = 20,
    [switch]$AllMachines,
    [switch]$Json
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'TokenMeter.psm1') -Force
$paths = Get-TMPaths
$historyFiles = if ($AllMachines) {
    @(Get-ChildItem -LiteralPath $paths.SharedRoot -Recurse -Filter 'history.jsonl' -File -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
} else { @($paths.History) }
$records = New-Object Collections.Generic.List[object]
foreach ($history in $historyFiles) {
    foreach ($record in @(Get-TMLatestRecords $history)) {
        if (-not [string]::IsNullOrWhiteSpace($Cli) -and [string]$record.cli -ne $Cli) { continue }
        if ($Period -eq 'Today' -and ([DateTimeOffset]$record.timestamp).LocalDateTime.Date -ne (Get-Date).Date) { continue }
        $records.Add($record)
    }
}
$selected = @($records | Sort-Object {[DateTimeOffset]$_.timestamp} -Descending | Select-Object -First ([Math]::Max(1,$Last)))
if ($Json) { $selected | ConvertTo-Json -Depth 20; exit 0 }
$selected | Select-Object @{n='Time';e={([DateTimeOffset]$_.timestamp).LocalDateTime.ToString('yyyy-MM-dd HH:mm:ss')}},cli,computer,user,revision,quality,@{n='Usage';e={Format-TMTurnSummary $_}} | Format-Table -Wrap -AutoSize
