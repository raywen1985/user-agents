Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Get-TMProperty {
    param([object]$Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [Collections.IDictionary]) {
        if ($Object.Contains($Name)) { return $Object[$Name] }
        return $null
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function ConvertTo-TMSafeName {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return 'unknown' }
    $safe = [regex]::Replace($Value, '[<>:"/\\|?*\x00-\x1f]', '_').TrimEnd('.', ' ').Trim()
    if ([string]::IsNullOrWhiteSpace($safe)) { return 'unknown' }
    return $safe.ToLowerInvariant()
}

function Get-TMHash {
    param([AllowEmptyString()][string]$Text)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally { $sha.Dispose() }
}

function Get-TMPaths {
    $profile = [Environment]::GetFolderPath('UserProfile')
    $computer = if ([string]::IsNullOrWhiteSpace($env:COMPUTERNAME)) { [Environment]::MachineName } else { $env:COMPUTERNAME }
    $user = if ([string]::IsNullOrWhiteSpace($env:USERNAME)) { [Environment]::UserName } else { $env:USERNAME }
    $computerScope = ConvertTo-TMSafeName $computer
    $userScope = ConvertTo-TMSafeName $user
    $sharedRoot = if ([string]::IsNullOrWhiteSpace($env:TOKEN_METER_DATA_ROOT)) {
        Join-Path $profile '.agents\.token-meter-data'
    } else {
        [IO.Path]::GetFullPath($env:TOKEN_METER_DATA_ROOT)
    }
    $dataRoot = Join-Path (Join-Path $sharedRoot $computerScope) $userScope
    return [pscustomobject]@{
        Profile = $profile
        SharedRoot = $sharedRoot
        DataRoot = $dataRoot
        History = Join-Path $dataRoot 'history.jsonl'
        Latest = Join-Path $dataRoot 'latest'
        Staging = Join-Path $dataRoot 'staging'
        Errors = Join-Path $dataRoot 'errors.log'
        Manifest = Join-Path $dataRoot 'install-manifest.json'
        Computer = $computer
        User = $user
        ComputerScope = $computerScope
        UserScope = $userScope
    }
}

function Initialize-TMDataDirectory {
    $paths = Get-TMPaths
    foreach ($directory in @($paths.DataRoot, $paths.Latest, $paths.Staging, (Join-Path $paths.Latest 'claude'), (Join-Path $paths.Latest 'codex'))) {
        [IO.Directory]::CreateDirectory($directory) | Out-Null
    }
    return $paths
}

function Write-TMError {
    param([string]$Code, [string]$Detail)
    try {
        $paths = Initialize-TMDataDirectory
        $safe = ([string]$Detail -replace '[\r\n]+', ' ').Trim()
        if ($safe.Length -gt 300) { $safe = $safe.Substring(0, 300) }
        $line = '{0} code={1} detail={2}' -f ([DateTimeOffset]::Now.ToString('o')), $Code, $safe
        [IO.File]::AppendAllText($paths.Errors, $line + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    }
    catch { }
}

function ConvertTo-TMCanonicalJson {
    param([object]$Value)
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [bool]) { if ($Value) { return 'true' } else { return 'false' } }
    if ($Value -is [string] -or $Value -is [char]) { return (ConvertTo-Json ([string]$Value) -Compress) }
    if ($Value -is [DateTime] -or $Value -is [DateTimeOffset]) { return (ConvertTo-Json ($Value.ToString('o')) -Compress) }
    if ($Value -is [byte] -or $Value -is [sbyte] -or $Value -is [int16] -or $Value -is [uint16] -or $Value -is [int32] -or $Value -is [uint32] -or $Value -is [int64] -or $Value -is [uint64] -or $Value -is [decimal] -or $Value -is [double] -or $Value -is [single]) {
        return [Convert]::ToString($Value, [Globalization.CultureInfo]::InvariantCulture)
    }
    if ($Value -is [Collections.IDictionary]) {
        $parts = foreach ($key in @($Value.Keys | ForEach-Object { [string]$_ } | Sort-Object)) {
            (ConvertTo-Json $key -Compress) + ':' + (ConvertTo-TMCanonicalJson $Value[$key])
        }
        return '{' + ($parts -join ',') + '}'
    }
    if (($Value -is [Collections.IEnumerable]) -and -not ($Value -is [string])) {
        $parts = foreach ($item in $Value) { ConvertTo-TMCanonicalJson $item }
        return '[' + ($parts -join ',') + ']'
    }
    $table = @{}
    foreach ($property in $Value.PSObject.Properties) { $table[$property.Name] = $property.Value }
    return ConvertTo-TMCanonicalJson $table
}

function Read-TMFileBytes {
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [int]$Attempts = 6,
        [int]$DelayMilliseconds = 100
    )
    $lastError = $null
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
            try {
                $memory = New-Object IO.MemoryStream
                try {
                    $stream.CopyTo($memory)
                    return ,$memory.ToArray()
                }
                finally { $memory.Dispose() }
            }
            finally { $stream.Dispose() }
        }
        catch [IO.IOException] {
            $lastError = $_
            if ($attempt -lt $Attempts) { Start-Sleep -Milliseconds $DelayMilliseconds }
        }
    }
    throw $lastError.Exception
}

function Read-TMFileSnapshot {
    param([Parameter(Mandatory=$true)][string]$Path)
    $bytes = Read-TMFileBytes $Path
    $raw = [Text.Encoding]::GetEncoding(28591).GetString($bytes)
    return [pscustomobject]@{ Bytes = $bytes; Raw = $raw }
}

# Structural needles are ASCII, so the ISO-8859-1 view of the bytes is searchable
# without decoding whole lines as UTF-8 first.
function Test-TMLineSelectedRaw {
    param([string]$Raw, [int]$Start, [int]$Count, [string[]]$ContainsAny, [string[]]$ExcludeAny)
    if ($ContainsAny.Count -gt 0) {
        $matched = $false
        foreach ($needle in $ContainsAny) {
            if ($Raw.IndexOf($needle, $Start, $Count, [StringComparison]::Ordinal) -ge 0) { $matched = $true; break }
        }
        if (-not $matched) { return $false }
    }
    foreach ($needle in $ExcludeAny) {
        if ($Raw.IndexOf($needle, $Start, $Count, [StringComparison]::Ordinal) -ge 0) { return $false }
    }
    return $true
}

function Read-TMJsonLines {
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [string[]]$ContainsAny = @(),
        [string[]]$ExcludeAny = @()
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return @() }
    $snapshot = Read-TMFileSnapshot $Path
    $bytes = $snapshot.Bytes
    $raw = $snapshot.Raw
    $length = $bytes.Length
    $rows = New-Object Collections.Generic.List[object]
    $start = 0
    while ($start -lt $length) {
        $newline = $raw.IndexOf([char]10, $start)
        if ($newline -lt 0) { $newline = $length }
        $count = $newline - $start
        if ($count -gt 0 -and $bytes[$start + $count - 1] -eq 13) { $count-- }
        if ($count -gt 0 -and (Test-TMLineSelectedRaw $raw $start $count $ContainsAny $ExcludeAny)) {
            try {
                $text = [Text.Encoding]::UTF8.GetString($bytes, $start, $count).TrimStart([char]0xfeff)
                $rows.Add([pscustomobject]@{
                    Object = ($text | ConvertFrom-Json)
                    EndOffset = [int64]([Math]::Min($newline + 1, $length))
                    LineNumber = $rows.Count + 1
                })
            }
            catch { }
        }
        $start = $newline + 1
    }
    return $rows.ToArray()
}

function Get-TMVisibleText {
    param([object]$Value)
    if ($null -eq $Value) { return '' }
    if ($Value -is [string]) { return $Value }
    if (($Value -is [Collections.IEnumerable]) -and -not ($Value -is [string])) {
        return (($Value | ForEach-Object { Get-TMVisibleText $_ }) -join '')
    }
    $type = [string](Get-TMProperty $Value 'type')
    if ($type -in @('tool_result', 'tool_use', 'thinking', 'redacted_thinking')) { return '' }
    $text = Get-TMProperty $Value 'text'
    if ($null -ne $text) { return [string]$text }
    $content = Get-TMProperty $Value 'content'
    if ($null -ne $content) { return Get-TMVisibleText $content }
    return ''
}

function Test-TMHumanUserRow {
    param([object]$Row)
    $item = $Row.Object
    if ([string](Get-TMProperty $item 'type') -ne 'user') { return $false }
    if ((Get-TMProperty $item 'isSidechain') -eq $true) { return $false }
    if ((Get-TMProperty $item 'isMeta') -eq $true) { return $false }
    $message = Get-TMProperty $item 'message'
    $content = Get-TMProperty $message 'content'
    if ($null -eq $content) { return $false }
    if ($content -is [string]) { return -not [string]::IsNullOrWhiteSpace($content) }
    $nonTool = @($content | Where-Object { [string](Get-TMProperty $_ 'type') -notin @('tool_result', 'tool_use') })
    return $nonTool.Count -gt 0
}

function ConvertTo-TMInt64 {
    param([object]$Value)
    if ($null -eq $Value) { return [int64]0 }
    try { return [int64]$Value } catch { return [int64]0 }
}

function ConvertTo-TMUtcTimestamp {
    param([object]$Value)
    if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) { return $null }
    $parsed = [DateTimeOffset]::MinValue
    $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
    if ([DateTimeOffset]::TryParse([string]$Value, [Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$parsed)) {
        return $parsed.ToUniversalTime().ToString('o')
    }
    return $null
}

function Get-TMPricingTimestamp {
    param(
        [object]$PrimaryValue,
        [string]$PrimarySource,
        [object]$SecondaryValue,
        [string]$SecondarySource,
        [Parameter(Mandatory=$true)][string]$FallbackUtc
    )
    $timestamp = ConvertTo-TMUtcTimestamp $PrimaryValue
    if ($null -ne $timestamp) { return [ordered]@{timestamp_utc=$timestamp;source=$PrimarySource;is_fallback=$false} }
    $timestamp = ConvertTo-TMUtcTimestamp $SecondaryValue
    if ($null -ne $timestamp) { return [ordered]@{timestamp_utc=$timestamp;source=$SecondarySource;is_fallback=$false} }
    return [ordered]@{timestamp_utc=$FallbackUtc;source='parser_fallback';is_fallback=$true}
}

function ConvertTo-TMDecimalString {
    param([decimal]$Value)
    return $Value.ToString('0.############################', [Globalization.CultureInfo]::InvariantCulture)
}

function ConvertTo-TMPriceDecimal {
    param([object]$Value, [string]$Field)
    $parsed = [decimal]0
    if (-not [decimal]::TryParse([string]$Value, [Globalization.NumberStyles]::Number, [Globalization.CultureInfo]::InvariantCulture, [ref]$parsed) -or $parsed -lt 0) {
        throw "Price field '$Field' is not a nonnegative invariant decimal."
    }
    return $parsed
}

function Get-TMPriceTablePath {
    if (-not [string]::IsNullOrWhiteSpace($env:TOKEN_METER_PRICE_TABLE_PATH)) {
        return [IO.Path]::GetFullPath($env:TOKEN_METER_PRICE_TABLE_PATH)
    }
    return Join-Path $PSScriptRoot 'model-prices.json'
}

function Get-TMLocalPriceTablePath {
    param([string]$BasePath = (Get-TMPriceTablePath))
    if (-not [string]::IsNullOrWhiteSpace($env:TOKEN_METER_LOCAL_PRICE_TABLE_PATH)) {
        return [IO.Path]::GetFullPath($env:TOKEN_METER_LOCAL_PRICE_TABLE_PATH)
    }
    return Join-Path (Split-Path -Parent $BasePath) 'model-prices.local.json'
}

function Read-TMValidatedPriceTable {
    param([Parameter(Mandatory=$true)][string]$Path, [switch]$AllowEmptyModels)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Price table not found: $Path" }
    $table = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    if ((ConvertTo-TMInt64 (Get-TMProperty $table 'schema_version')) -ne 1) { throw 'Unsupported price table schema_version.' }
    if ([string](Get-TMProperty $table 'currency') -cne 'USD') { throw 'Price table currency must be USD.' }
    if ((ConvertTo-TMInt64 (Get-TMProperty $table 'unit_tokens')) -ne 1000000) { throw 'Price table unit_tokens must be 1000000.' }
    $models = @(Get-TMProperty $table 'models')
    if ($models.Count -eq 0 -and -not $AllowEmptyModels) { throw 'Price table has no models.' }
    foreach ($model in $models) {
        if ([string]::IsNullOrWhiteSpace([string](Get-TMProperty $model 'id'))) { throw 'Price table model id is missing.' }
        foreach ($pattern in @(Get-TMProperty $model 'aliases_regex')) {
            $patternText = [string]$pattern
            if (-not $patternText.StartsWith('^') -or -not $patternText.EndsWith('$')) { throw "Price alias regex must be anchored: $patternText" }
            try { [void][regex]::new($patternText, [Text.RegularExpressions.RegexOptions]::CultureInvariant) } catch { throw "Invalid price alias regex: $patternText" }
        }
        $rates = Get-TMProperty $model 'rates'
        foreach ($period in @('off_peak','peak')) {
            $periodRates = Get-TMProperty $rates $period
            if ($null -eq $periodRates) { throw "Price table model '$($model.id)' has no $period rates." }
            foreach ($field in @('fresh_input_usd_per_million','cache_read_usd_per_million','cache_write_usd_per_million','output_usd_per_million')) {
                [void](ConvertTo-TMPriceDecimal (Get-TMProperty $periodRates $field) "$($model.id).$period.$field")
            }
        }
    }
    return $table
}

function Merge-TMPriceTable {
    param([object]$Base, [object]$Overlay)
    $models = New-Object Collections.Generic.List[object]
    $index = @{}
    foreach ($model in @(Get-TMProperty $Base 'models')) {
        $id = [string](Get-TMProperty $model 'id')
        if (-not [string]::IsNullOrWhiteSpace($id)) { $index[$id] = $models.Count }
        $models.Add($model)
    }
    foreach ($model in @(Get-TMProperty $Overlay 'models')) {
        $id = [string](Get-TMProperty $model 'id')
        if (-not [string]::IsNullOrWhiteSpace($id) -and $index.ContainsKey($id)) {
            $models[$index[$id]] = $model
        } else {
            if (-not [string]::IsNullOrWhiteSpace($id)) { $index[$id] = $models.Count }
            $models.Add($model)
        }
    }
    $merged = [ordered]@{
        schema_version = Get-TMProperty $Base 'schema_version'
        currency = Get-TMProperty $Base 'currency'
        unit_tokens = Get-TMProperty $Base 'unit_tokens'
        source_url = Get-TMProperty $Base 'source_url'
        verified_on = Get-TMProperty $Base 'verified_on'
        models = $models.ToArray()
    }
    $localSource = [string](Get-TMProperty $Overlay 'source_url')
    if (-not [string]::IsNullOrWhiteSpace($localSource)) { $merged['local_source_url'] = $localSource }
    $localVerified = [string](Get-TMProperty $Overlay 'verified_on')
    if (-not [string]::IsNullOrWhiteSpace($localVerified)) { $merged['local_verified_on'] = $localVerified }
    return [pscustomobject]$merged
}

function Read-TMPriceTable {
    param([string]$Path = (Get-TMPriceTablePath))
    $table = Read-TMValidatedPriceTable $Path
    $localPath = Get-TMLocalPriceTablePath $Path
    if (-not [string]::IsNullOrWhiteSpace($localPath) -and (Test-Path -LiteralPath $localPath -PathType Leaf)) {
        $overlay = Read-TMValidatedPriceTable $localPath -AllowEmptyModels
        $table = Merge-TMPriceTable $table $overlay
    }
    return $table
}

function Resolve-TMPriceModel {
    param([Parameter(Mandatory=$true)][object]$PriceTable, [string]$Model)
    if ([string]::IsNullOrWhiteSpace($Model)) { return $null }
    $normalized = $Model.Trim().ToLowerInvariant()
    foreach ($entry in @(Get-TMProperty $PriceTable 'models')) {
        foreach ($alias in @(Get-TMProperty $entry 'aliases_exact')) {
            if ($normalized -ceq ([string]$alias).Trim().ToLowerInvariant()) { return $entry }
        }
    }
    foreach ($entry in @(Get-TMProperty $PriceTable 'models')) {
        foreach ($pattern in @(Get-TMProperty $entry 'aliases_regex')) {
            if ([regex]::IsMatch($normalized, [string]$pattern, [Text.RegularExpressions.RegexOptions]::CultureInvariant)) { return $entry }
        }
    }
    return $null
}

function Get-TMRatePeriod {
    param([Parameter(Mandatory=$true)][object]$Timestamp)
    $utcText = ConvertTo-TMUtcTimestamp $Timestamp
    if ($null -eq $utcText) { throw 'Pricing timestamp is invalid.' }
    $utc = [DateTimeOffset]::Parse($utcText, [Globalization.CultureInfo]::InvariantCulture).UtcDateTime
    if ($utc.DayOfWeek -in @([DayOfWeek]::Monday,[DayOfWeek]::Tuesday,[DayOfWeek]::Wednesday,[DayOfWeek]::Thursday,[DayOfWeek]::Friday)) {
        $time = $utc.TimeOfDay
        if (($time -ge [TimeSpan]::FromHours(1) -and $time -lt [TimeSpan]::FromHours(4)) -or ($time -ge [TimeSpan]::FromHours(6) -and $time -lt [TimeSpan]::FromHours(10))) {
            return 'peak'
        }
    }
    return 'off_peak'
}

function New-TMUnavailableCost {
    param([string]$Reason, [object[]]$RawModels = @())
    return [ordered]@{
        status='unavailable';reason=$Reason;approximate=$true;currency='USD';total_usd=$null
        components_usd=[ordered]@{}
        price_table=$null
        raw_models=@($RawModels | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | Select-Object -Unique)
        segments=@()
    }
}

function Get-TMEstimatedCost {
    param([Parameter(Mandatory=$true)][object]$Record, [string]$PriceTablePath = (Get-TMPriceTablePath))
    $rawModels = @()
    try {
        $quality = [string](Get-TMProperty $Record 'quality')
        if ($quality -notin @('PROVIDER_REPORTED','DERIVED_REPORTED')) { return New-TMUnavailableCost 'token_usage_not_reported' }
        $usage = Get-TMProperty $Record 'normalized_usage'
        if ($null -eq $usage) { return New-TMUnavailableCost 'invalid_usage' }
        [int64]$fresh = ConvertTo-TMInt64 (Get-TMProperty $usage 'fresh_input_tokens')
        [int64]$cacheRead = ConvertTo-TMInt64 (Get-TMProperty $usage 'cache_read_tokens')
        [int64]$cacheWrite = ConvertTo-TMInt64 (Get-TMProperty $usage 'cache_write_tokens')
        [int64]$effective = ConvertTo-TMInt64 (Get-TMProperty $usage 'effective_input_tokens')
        [int64]$output = ConvertTo-TMInt64 (Get-TMProperty $usage 'generated_output_tokens')
        if ($fresh -lt 0 -or $cacheRead -lt 0 -or $cacheWrite -lt 0 -or $effective -lt 0 -or $output -lt 0 -or $effective -ne ($fresh+$cacheRead+$cacheWrite) -or $cacheRead -gt $effective) {
            return New-TMUnavailableCost 'invalid_usage'
        }
        $sourceSegments = @(Get-TMProperty $Record 'pricing_segments')
        if ($sourceSegments.Count -eq 0) { return New-TMUnavailableCost 'mixed_or_missing_segment_data' @([string](Get-TMProperty $Record 'model')) }
        $table = Read-TMPriceTable $PriceTablePath
        [decimal]$freshCost=0;[decimal]$cacheReadCost=0;[decimal]$cacheWriteCost=0;[decimal]$outputCost=0
        [int64]$segmentFresh=0;[int64]$segmentCacheRead=0;[int64]$segmentCacheWrite=0;[int64]$segmentOutput=0
        $pricedSegments = New-Object Collections.Generic.List[object]
        foreach ($segment in $sourceSegments) {
            $rawModel = [string](Get-TMProperty $segment 'raw_model')
            $rawModels += $rawModel
            $modelEntry = Resolve-TMPriceModel $table $rawModel
            if ($null -eq $modelEntry) { return New-TMUnavailableCost 'model_not_mapped' $rawModels }
            $timestamp = [string](Get-TMProperty $segment 'timestamp_utc')
            $period = Get-TMRatePeriod $timestamp
            $rates = Get-TMProperty (Get-TMProperty $modelEntry 'rates') $period
            $tokens = Get-TMProperty $segment 'tokens'
            [int64]$sf=ConvertTo-TMInt64 (Get-TMProperty $tokens 'fresh_input')
            [int64]$sr=ConvertTo-TMInt64 (Get-TMProperty $tokens 'cache_read')
            [int64]$sw=ConvertTo-TMInt64 (Get-TMProperty $tokens 'cache_write')
            [int64]$so=ConvertTo-TMInt64 (Get-TMProperty $tokens 'output')
            if ($sf -lt 0 -or $sr -lt 0 -or $sw -lt 0 -or $so -lt 0) { return New-TMUnavailableCost 'invalid_usage' $rawModels }
            [decimal]$rf=ConvertTo-TMPriceDecimal (Get-TMProperty $rates 'fresh_input_usd_per_million') 'fresh input'
            [decimal]$rr=ConvertTo-TMPriceDecimal (Get-TMProperty $rates 'cache_read_usd_per_million') 'cache read'
            [decimal]$rw=ConvertTo-TMPriceDecimal (Get-TMProperty $rates 'cache_write_usd_per_million') 'cache write'
            [decimal]$ro=ConvertTo-TMPriceDecimal (Get-TMProperty $rates 'output_usd_per_million') 'output'
            [decimal]$unit=ConvertTo-TMInt64 (Get-TMProperty $table 'unit_tokens')
            [decimal]$cf=([decimal]$sf*$rf)/$unit;[decimal]$cr=([decimal]$sr*$rr)/$unit;[decimal]$cw=([decimal]$sw*$rw)/$unit;[decimal]$co=([decimal]$so*$ro)/$unit
            $freshCost+=$cf;$cacheReadCost+=$cr;$cacheWriteCost+=$cw;$outputCost+=$co
            $segmentFresh+=$sf;$segmentCacheRead+=$sr;$segmentCacheWrite+=$sw;$segmentOutput+=$so
            $pricedSegments.Add([pscustomobject][ordered]@{
                raw_model=$rawModel;model_id=[string](Get-TMProperty $modelEntry 'id');display_name=[string](Get-TMProperty $modelEntry 'display_name')
                rate_period=$period;priced_at_utc=$timestamp;pricing_time_source=[string](Get-TMProperty $segment 'timestamp_source')
                tokens=[ordered]@{fresh_input=$sf;cache_read=$sr;cache_write=$sw;output=$so}
                rates_usd_per_million=[ordered]@{fresh_input=(ConvertTo-TMDecimalString $rf);cache_read=(ConvertTo-TMDecimalString $rr);cache_write=(ConvertTo-TMDecimalString $rw);output=(ConvertTo-TMDecimalString $ro)}
                total_usd=(ConvertTo-TMDecimalString ($cf+$cr+$cw+$co))
            })
        }
        if ($segmentFresh -ne $fresh -or $segmentCacheRead -ne $cacheRead -or $segmentCacheWrite -ne $cacheWrite -or $segmentOutput -ne $output) {
            return New-TMUnavailableCost 'invalid_usage' $rawModels
        }
        $priceTableSnapshot = [ordered]@{schema_version=1;source_url=[string](Get-TMProperty $table 'source_url');verified_on=[string](Get-TMProperty $table 'verified_on')}
        $localVerified = [string](Get-TMProperty $table 'local_verified_on')
        if (-not [string]::IsNullOrWhiteSpace($localVerified)) { $priceTableSnapshot['local_verified_on'] = $localVerified }
        $localSource = [string](Get-TMProperty $table 'local_source_url')
        if (-not [string]::IsNullOrWhiteSpace($localSource)) { $priceTableSnapshot['local_source_url'] = $localSource }
        return [ordered]@{
            status='estimated';reason=$null;approximate=$true;currency='USD';total_usd=(ConvertTo-TMDecimalString ($freshCost+$cacheReadCost+$cacheWriteCost+$outputCost))
            components_usd=[ordered]@{fresh_input=(ConvertTo-TMDecimalString $freshCost);cache_read=(ConvertTo-TMDecimalString $cacheReadCost);cache_write=(ConvertTo-TMDecimalString $cacheWriteCost);output=(ConvertTo-TMDecimalString $outputCost)}
            price_table=$priceTableSnapshot
            raw_models=@($rawModels | Select-Object -Unique);segments=$pricedSegments.ToArray()
        }
    }
    catch {
        Write-TMError 'pricing' $_.Exception.Message
        return New-TMUnavailableCost 'price_table_invalid' $rawModels
    }
}

function Get-TMPricingIdentitySegments {
    param([object]$Segments)
    $identity = New-Object Collections.Generic.List[object]
    foreach ($segment in @($Segments)) {
        $isFallback = (Get-TMProperty $segment 'is_fallback') -eq $true
        $identity.Add([pscustomobject][ordered]@{
            raw_model=[string](Get-TMProperty $segment 'raw_model')
            timestamp_utc=if($isFallback){$null}else{[string](Get-TMProperty $segment 'timestamp_utc')}
            timestamp_source=[string](Get-TMProperty $segment 'timestamp_source')
            is_fallback=$isFallback
            tokens=Get-TMProperty $segment 'tokens'
        })
    }
    return $identity.ToArray()
}

function Get-ClaudeTurnRecord {
    param([Parameter(Mandatory=$true)][object]$HookPayload)
    $parserFallbackUtc = [DateTimeOffset]::UtcNow.ToString('o')
    $sessionId = [string](Get-TMProperty $HookPayload 'session_id')
    $transcript = [string](Get-TMProperty $HookPayload 'transcript_path')
    if ([string]::IsNullOrWhiteSpace($sessionId) -or [string]::IsNullOrWhiteSpace($transcript) -or -not (Test-Path -LiteralPath $transcript -PathType Leaf)) { throw 'Claude hook payload is missing a valid session_id or transcript_path.' }
    $snapshot = Read-TMFileSnapshot $transcript
    $bytes = $snapshot.Bytes
    $raw = $snapshot.Raw
    $userRow = $null
    $turnRows = New-Object Collections.Generic.List[object]
    $position = $bytes.Length
    while ($position -gt 0) {
        $lineOffset = $position
        $lineEnd = $position
        if ($lineEnd -gt 0 -and $bytes[$lineEnd - 1] -eq 10) { $lineEnd-- }
        if ($lineEnd -gt 0 -and $bytes[$lineEnd - 1] -eq 13) { $lineEnd-- }
        $lineStart = if ($lineEnd -gt 0) { $raw.LastIndexOf([char]10, $lineEnd - 1) + 1 } else { 0 }
        $count = $lineEnd - $lineStart
        if ($count -gt 0 -and (Test-TMLineSelectedRaw $raw $lineStart $count @('"type":"user"', '"type": "user"', '"type":"assistant"', '"type": "assistant"') @('"type":"tool_result"', '"type": "tool_result"'))) {
            try {
                $item = ([Text.Encoding]::UTF8.GetString($bytes, $lineStart, $count).TrimStart([char]0xfeff) | ConvertFrom-Json)
                $row = [pscustomobject]@{ Object=$item; EndOffset=[int64]$lineOffset; LineNumber=0 }
                if (Test-TMHumanUserRow $row) { $userRow = $row; break }
                if ([string](Get-TMProperty $item 'type') -eq 'assistant' -and (Get-TMProperty $item 'isSidechain') -ne $true) { $turnRows.Add($row) }
            }
            catch { }
        }
        $position = $lineStart
    }
    if ($null -eq $userRow) { throw 'No top-level human user turn was found.' }
    $rows = @($turnRows | Sort-Object EndOffset)
    $user = $userRow.Object
    $turnId = [string](Get-TMProperty $user 'uuid')
    if ([string]::IsNullOrWhiteSpace($turnId)) {
        $turnId = Get-TMHash ('{0}|{1}|{2}' -f [string](Get-TMProperty $user 'timestamp'), $userRow.EndOffset, $sessionId)
    }
    $messages = @{}
    $visibleOutput = ''
    $sourceCursor = [int64]$userRow.EndOffset
    foreach ($row in $rows) {
        $item = $row.Object
        $message = Get-TMProperty $item 'message'
        if ($null -eq $message) { continue }
        $id = [string](Get-TMProperty $message 'id')
        if ([string]::IsNullOrWhiteSpace($id)) { $id = [string](Get-TMProperty $item 'uuid') }
        if ([string]::IsNullOrWhiteSpace($id)) { $id = 'offset-' + $row.EndOffset }
        $messages[$id] = [pscustomobject]@{ Message=$message; EndOffset=[int64]$row.EndOffset; Timestamp=(Get-TMProperty $item 'timestamp') }
    }
    $usageItems = @($messages.Values | Where-Object { $null -ne (Get-TMProperty $_.Message 'usage') } | Sort-Object EndOffset)
    foreach ($entry in @($messages.Values | Sort-Object EndOffset)) {
        $visibleOutput += Get-TMVisibleText (Get-TMProperty $entry.Message 'content')
        if ($entry.EndOffset -gt $sourceCursor) { $sourceCursor = $entry.EndOffset }
    }
    $paths = Get-TMPaths
    if ($usageItems.Count -gt 0) {
        [int64]$inputTokens = 0; [int64]$cacheRead = 0; [int64]$cacheWrite = 0; [int64]$output = 0; [int64]$reasoning = 0
        $model = ''
        $pricingSegments = New-Object Collections.Generic.List[object]
        foreach ($entry in $usageItems) {
            $usage = Get-TMProperty $entry.Message 'usage'
            [int64]$entryInput = ConvertTo-TMInt64 (Get-TMProperty $usage 'input_tokens')
            [int64]$entryCacheRead = ConvertTo-TMInt64 (Get-TMProperty $usage 'cache_read_input_tokens')
            [int64]$entryCacheWrite = ConvertTo-TMInt64 (Get-TMProperty $usage 'cache_creation_input_tokens')
            [int64]$entryOutput = ConvertTo-TMInt64 (Get-TMProperty $usage 'output_tokens')
            [int64]$entryReasoning = ConvertTo-TMInt64 (Get-TMProperty (Get-TMProperty $usage 'output_tokens_details') 'thinking_tokens')
            $inputTokens += $entryInput
            $cacheRead += $entryCacheRead
            $cacheWrite += $entryCacheWrite
            $output += $entryOutput
            if ($entryReasoning -gt 0) { $reasoning += $entryReasoning }
            if (($entryInput + $entryCacheRead + $entryCacheWrite + $entryOutput) -le 0) { continue }
            $candidateModel = [string](Get-TMProperty $entry.Message 'model')
            if (-not [string]::IsNullOrWhiteSpace($candidateModel) -and $candidateModel -ne '<synthetic>') { $model = $candidateModel }
            $pricingTime = Get-TMPricingTimestamp $entry.Timestamp 'assistant_row_timestamp' (Get-TMProperty $user 'timestamp') 'human_row_timestamp' $parserFallbackUtc
            $pricingSegments.Add([pscustomobject][ordered]@{
                raw_model=$candidateModel;timestamp_utc=$pricingTime.timestamp_utc;timestamp_source=$pricingTime.source;is_fallback=$pricingTime.is_fallback
                tokens=[ordered]@{fresh_input=$entryInput;cache_read=$entryCacheRead;cache_write=$entryCacheWrite;output=$entryOutput}
            })
        }
        return [ordered]@{
            cli='claude'; computer=$paths.Computer; user=$paths.User; computer_scope=$paths.ComputerScope; user_scope=$paths.UserScope
            session_id=$sessionId; turn_id=$turnId; model=$model; source_cursor=$sourceCursor
            quality='DERIVED_REPORTED'; source='claude.transcript.message.usage'
            source_usage=[ordered]@{input_tokens=$inputTokens;cache_read_input_tokens=$cacheRead;cache_creation_input_tokens=$cacheWrite;output_tokens=$output}
            normalized_usage=[ordered]@{fresh_input_tokens=$inputTokens;cache_read_tokens=$cacheRead;cache_write_tokens=$cacheWrite;effective_input_tokens=($inputTokens+$cacheRead+$cacheWrite);visible_output_tokens=[Math]::Max([int64]0, $output - $reasoning);reasoning_output_tokens=$reasoning;generated_output_tokens=$output}
            semantics=[ordered]@{source_input_includes_cache=$false;source_output_includes_reasoning=$true}
            pricing_segments=$pricingSegments.ToArray()
        }
    }
    $visibleInput = Get-TMVisibleText (Get-TMProperty (Get-TMProperty $user 'message') 'content')
    return [ordered]@{
        cli='claude'; computer=$paths.Computer; user=$paths.User; computer_scope=$paths.ComputerScope; user_scope=$paths.UserScope
        session_id=$sessionId; turn_id=$turnId; model=''; source_cursor=$sourceCursor
        quality='ESTIMATED_VISIBLE_TEXT'; source='claude.transcript.visible_text'
        source_usage=[ordered]@{input_tokens=$null;cached_input_tokens=$null;cache_write_input_tokens=$null;output_tokens=$null;reasoning_output_tokens=$null;total_tokens=$null}
        normalized_usage=[ordered]@{estimated_visible_input_tokens=[int64][Math]::Ceiling($visibleInput.Length/4.0);estimated_visible_output_tokens=[int64][Math]::Ceiling($visibleOutput.Length/4.0)}
        semantics=[ordered]@{estimate_scope='visible_text_only'}; estimate_scope='visible_text_only'
    }
}

function Test-TMCodexSessionEligible {
    param([object]$SessionMetaPayload)
    if ($null -eq $SessionMetaPayload) { return $true }
    if ($null -ne (Get-TMProperty $SessionMetaPayload 'parent_thread_id')) { return $false }
    $threadSource = [string](Get-TMProperty $SessionMetaPayload 'thread_source')
    if (-not [string]::IsNullOrWhiteSpace($threadSource) -and $threadSource -cne 'user') { return $false }
    $source = Get-TMProperty $SessionMetaPayload 'source'
    if ($source -is [string]) {
        $normalized = $source.Trim().ToLowerInvariant()
        if ($normalized -notin @('cli','exec','vscode','desktop','app','ide')) { return $false }
    }
    return $true
}

function Get-CodexTurnRecord {
    param([Parameter(Mandatory=$true)][object]$HookPayload)
    $parserFallbackUtc = [DateTimeOffset]::UtcNow.ToString('o')
    $sessionId = [string](Get-TMProperty $HookPayload 'session_id')
    $turnId = [string](Get-TMProperty $HookPayload 'turn_id')
    $transcript = [string](Get-TMProperty $HookPayload 'transcript_path')
    if ([string]::IsNullOrWhiteSpace($sessionId) -or [string]::IsNullOrWhiteSpace($turnId) -or [string]::IsNullOrWhiteSpace($transcript) -or -not (Test-Path -LiteralPath $transcript -PathType Leaf)) { throw 'Codex hook payload is missing a valid session_id, turn_id, or transcript_path.' }
    $rows = @(Read-TMJsonLines $transcript -ContainsAny @('"type":"session_meta"', '"type": "session_meta"', $turnId))
    $paths = Get-TMPaths
    $meta = $rows | Where-Object { [string](Get-TMProperty $_.Object 'type') -eq 'session_meta' } | Select-Object -First 1
    if ($null -ne $meta) {
        $metaPayload = Get-TMProperty $meta.Object 'payload'
        if (-not (Test-TMCodexSessionEligible $metaPayload)) {
            return [ordered]@{
                cli='codex';computer=$paths.Computer;user=$paths.User;computer_scope=$paths.ComputerScope;user_scope=$paths.UserScope
                session_id=$sessionId;turn_id=$turnId;model='';source_cursor=[int64]0;quality='EXCLUDED';source='codex.transcript'
                source_usage=$null;normalized_usage=$null;semantics=$null;unavailable_reason='Nested subagent and non-user Codex threads are excluded.'
            }
        }
    }
    $matches = New-Object Collections.Generic.List[object]
    [int64]$turnCursor = 0
    $turnContextTimestamp = $null
    $turnContextModel = ''
    foreach ($row in $rows) {
        $item = $row.Object
        $payload = Get-TMProperty $item 'payload'
        if ([string](Get-TMProperty $payload 'turn_id') -ne $turnId) { continue }
        $ordinal = ConvertTo-TMInt64 (Get-TMProperty $item 'ordinal')
        if ($ordinal -le 0) { $ordinal = [int64]$row.EndOffset }
        if ($ordinal -gt $turnCursor) { $turnCursor = $ordinal }
        if ([string](Get-TMProperty $item 'type') -eq 'turn_context') {
            if ($null -eq $turnContextTimestamp) { $turnContextTimestamp = Get-TMProperty $item 'timestamp' }
            if ([string]::IsNullOrWhiteSpace($turnContextModel)) { $turnContextModel = [string](Get-TMProperty $payload 'model') }
        }
        if ([string](Get-TMProperty $item 'type') -eq 'token_usage_record' -and $null -ne (Get-TMProperty $payload 'turn_token_usage')) {
            $matches.Add([pscustomobject]@{ Usage=(Get-TMProperty $payload 'turn_token_usage'); Cursor=$ordinal; Payload=$payload; Timestamp=(Get-TMProperty $item 'timestamp') })
        }
    }
    if ($matches.Count -eq 0) {
        return [ordered]@{
            cli='codex';computer=$paths.Computer;user=$paths.User;computer_scope=$paths.ComputerScope;user_scope=$paths.UserScope
            session_id=$sessionId;turn_id=$turnId;model='';source_cursor=$turnCursor;quality='UNAVAILABLE';source='codex.transcript'
            source_usage=$null;normalized_usage=$null;semantics=$null;unavailable_reason='No turn_token_usage record matched the Stop turn_id.'
        }
    }
    $last = $matches | Sort-Object Cursor | Select-Object -Last 1
    $usage = $last.Usage
    [int64]$inputTokens = ConvertTo-TMInt64 (Get-TMProperty $usage 'input_tokens')
    [int64]$cacheRead = ConvertTo-TMInt64 (Get-TMProperty $usage 'cached_input_tokens')
    [int64]$cacheWrite = ConvertTo-TMInt64 (Get-TMProperty $usage 'cache_write_input_tokens')
    [int64]$output = ConvertTo-TMInt64 (Get-TMProperty $usage 'output_tokens')
    [int64]$reasoning = ConvertTo-TMInt64 (Get-TMProperty $usage 'reasoning_output_tokens')
    [int64]$fresh = [Math]::Max(0, $inputTokens - $cacheRead - $cacheWrite)
    [int64]$visible = [Math]::Max(0, $output - $reasoning)
    $model = [string](Get-TMProperty $last.Payload 'model')
    if ([string]::IsNullOrWhiteSpace($model)) { $model = $turnContextModel }
    $pricingTime = Get-TMPricingTimestamp $last.Timestamp 'token_usage_row_timestamp' $turnContextTimestamp 'turn_context_timestamp' $parserFallbackUtc
    return [ordered]@{
        cli='codex';computer=$paths.Computer;user=$paths.User;computer_scope=$paths.ComputerScope;user_scope=$paths.UserScope
        session_id=$sessionId;turn_id=$turnId;model=$model;source_cursor=[int64]$last.Cursor
        quality='DERIVED_REPORTED';source='codex.token_usage_record.turn_token_usage'
        source_usage=[ordered]@{input_tokens=$inputTokens;cached_input_tokens=$cacheRead;cache_write_input_tokens=$cacheWrite;output_tokens=$output;reasoning_output_tokens=$reasoning;total_tokens=(ConvertTo-TMInt64 (Get-TMProperty $usage 'total_tokens'))}
        normalized_usage=[ordered]@{fresh_input_tokens=$fresh;cache_read_tokens=$cacheRead;cache_write_tokens=$cacheWrite;effective_input_tokens=$inputTokens;visible_output_tokens=$visible;reasoning_output_tokens=$reasoning;generated_output_tokens=$output}
        semantics=[ordered]@{source_input_includes_cache=$true;source_output_includes_reasoning=$true}
        pricing_segments=@([ordered]@{raw_model=$model;timestamp_utc=$pricingTime.timestamp_utc;timestamp_source=$pricingTime.source;is_fallback=$pricingTime.is_fallback;tokens=[ordered]@{fresh_input=$fresh;cache_read=$cacheRead;cache_write=$cacheWrite;output=$output}})
    }
}

function Repair-TMHistoryTail {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
    try {
        if ($stream.Length -eq 0) { return }
        $stream.Position = $stream.Length - 1
        if ($stream.ReadByte() -eq 10) { return }
        for ($position = $stream.Length - 1; $position -ge 0; $position--) {
            $stream.Position = $position
            if ($stream.ReadByte() -eq 10) { $stream.SetLength($position + 1); return }
        }
        $stream.SetLength(0)
    }
    finally { $stream.Dispose() }
}

function Write-TMAtomicJson {
    param([string]$Path, [object]$Value)
    [IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
    $temporary = $Path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    $backup = $Path + '.' + [guid]::NewGuid().ToString('N') + '.replace-backup'
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    try {
        if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary, $Path, $backup, $true) }
        else { [IO.File]::Move($temporary, $Path) }
    }
    finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
        if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
    }
}

function Save-TMTurnRecord {
    param([Parameter(Mandatory=$true)][Collections.IDictionary]$Record)
    $paths = Initialize-TMDataDirectory
    $scope = '{0}|{1}|{2}|{3}|{4}' -f $Record.computer_scope,$Record.user_scope,$Record.cli,$Record.session_id,$Record.turn_id
    $logicalTurnId = Get-TMHash $scope
    $snapshot = [ordered]@{}
    foreach ($name in @('quality','source','model','source_usage','normalized_usage','semantics','estimate_scope','unavailable_reason')) {
        if ($Record.Contains($name)) { $snapshot[$name] = $Record[$name] } else { $snapshot[$name] = $null }
    }
    $snapshot['pricing_segments'] = if ($Record.Contains('pricing_segments')) { Get-TMPricingIdentitySegments $Record['pricing_segments'] } else { $null }
    $snapshotHash = Get-TMHash (ConvertTo-TMCanonicalJson $snapshot)
    $recordId = Get-TMHash ($logicalTurnId + '|' + $snapshotHash)
    $mutexName = 'TokenMeter-' + (Get-TMHash $paths.DataRoot).Substring(0,24)
    $mutex = New-Object Threading.Mutex($false, $mutexName)
    $acquired = $false
    try {
        try { $acquired = $mutex.WaitOne(3000) } catch [Threading.AbandonedMutexException] { $acquired = $true }
        if (-not $acquired) { throw 'History lock timed out.' }
        Repair-TMHistoryTail $paths.History
        $chain = New-Object Collections.Generic.List[object]
        if (Test-Path -LiteralPath $paths.History) {
            foreach ($line in [IO.File]::ReadLines($paths.History)) {
                try {
                    $item = $line | ConvertFrom-Json
                    if ([string](Get-TMProperty $item 'logical_turn_id') -eq $logicalTurnId) { $chain.Add($item) }
                }
                catch { }
            }
        }
        if (@($chain | Where-Object { [string](Get-TMProperty $_ 'record_id') -eq $recordId }).Count -gt 0) {
            return [pscustomobject]@{ Action='duplicate'; Record=($chain | Where-Object { $_.record_id -eq $recordId } | Select-Object -Last 1) }
        }
        $latest = $chain | Sort-Object @{Expression={ConvertTo-TMInt64 (Get-TMProperty $_ 'revision')}} | Select-Object -Last 1
        $cursor = ConvertTo-TMInt64 $Record.source_cursor
        if ($null -ne $latest) {
            $latestCursor = ConvertTo-TMInt64 (Get-TMProperty $latest 'source_cursor')
            if ($cursor -lt $latestCursor) { return [pscustomobject]@{Action='stale';Record=$latest} }
            if ($cursor -eq $latestCursor) { throw 'The same source_cursor produced a different snapshot.' }
        }
        $revision = if ($null -eq $latest) { 1 } else { (ConvertTo-TMInt64 (Get-TMProperty $latest 'revision')) + 1 }
        $saved = [ordered]@{schema_version=1;record_id=$recordId;logical_turn_id=$logicalTurnId;source_cursor=$cursor;revision=$revision;status='observed_stop';supersedes=if($null -eq $latest){$null}else{[string](Get-TMProperty $latest 'record_id')};timestamp=[DateTimeOffset]::Now.ToString('o')}
        foreach ($key in $Record.Keys) { $saved[$key] = $Record[$key] }
        $saved['estimated_cost'] = Get-TMEstimatedCost $Record
        $json = $saved | ConvertTo-Json -Compress -Depth 20
        [IO.File]::AppendAllText($paths.History, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        $sessionHash = (Get-TMHash ([string]$Record.session_id)).Substring(0,32)
        $latestPath = Join-Path (Join-Path $paths.Latest ([string]$Record.cli)) ($sessionHash + '.json')
        Write-TMAtomicJson $latestPath $saved
        return [pscustomobject]@{Action='appended';Record=[pscustomobject]$saved}
    }
    catch {
        Write-TMError 'history-write' $_.Exception.Message
        throw
    }
    finally {
        if ($acquired) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

function Format-TMInteger {
    param([object]$Value)
    return (ConvertTo-TMInt64 $Value).ToString('N0', [Globalization.CultureInfo]::InvariantCulture)
}

function Format-TMTurnSummary {
    param([object]$Record, [switch]$Compact)
    if ($null -eq $Record) { return '[UNAVAILABLE] Token usage not found' }
    $cli = if ([string](Get-TMProperty $Record 'cli') -eq 'claude') { 'Claude' } else { 'Codex' }
    $quality = [string](Get-TMProperty $Record 'quality')
    $usage = Get-TMProperty $Record 'normalized_usage'
    if ($quality -in @('PROVIDER_REPORTED','DERIVED_REPORTED')) {
        [int64]$fresh=ConvertTo-TMInt64 (Get-TMProperty $usage 'fresh_input_tokens')
        [int64]$cacheRead=ConvertTo-TMInt64 (Get-TMProperty $usage 'cache_read_tokens')
        [int64]$cacheWrite=ConvertTo-TMInt64 (Get-TMProperty $usage 'cache_write_tokens')
        [int64]$effective=ConvertTo-TMInt64 (Get-TMProperty $usage 'effective_input_tokens')
        [int64]$output=ConvertTo-TMInt64 (Get-TMProperty $usage 'generated_output_tokens')
        [decimal]$ratio = if ($effective -gt 0) { ([decimal]$cacheRead * 100) / [decimal]$effective } else { 0 }
        $ratioText = $ratio.ToString('0.00', [Globalization.CultureInfo]::InvariantCulture) + '%'
        $cost = Get-TMProperty $Record 'estimated_cost'
        $costStatus = [string](Get-TMProperty $cost 'status')
        $costText = 'unavailable'
        $costDetail = ''
        if ($costStatus -eq 'estimated') {
            $costValue = [decimal]0
            if ([decimal]::TryParse([string](Get-TMProperty $cost 'total_usd'), [Globalization.NumberStyles]::Number, [Globalization.CultureInfo]::InvariantCulture, [ref]$costValue)) {
                $costText = '$' + $costValue.ToString('0.0000', [Globalization.CultureInfo]::InvariantCulture) + ' USD'
                $costSegments = @(Get-TMProperty $cost 'segments')
                $names = @($costSegments | ForEach-Object { [string](Get-TMProperty $_ 'display_name') } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
                $periods = @($costSegments | ForEach-Object { [string](Get-TMProperty $_ 'rate_period') } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
                if ($names.Count -eq 1 -and $periods.Count -eq 1) { $costDetail = $names[0] + ' ' + $periods[0].Replace('_','-') }
                elseif ($costSegments.Count -gt 0) { $costDetail = 'mixed models/periods' }
            }
        } else {
            $reason = if ($null -eq $cost) { 'not recorded' } else { ([string](Get-TMProperty $cost 'reason')).Replace('_',' ') }
            if ($null -ne $cost -and $reason -eq 'model not mapped') {
                $unmapped = @(Get-TMProperty $cost 'raw_models' | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | Select-Object -Unique)
                if ($unmapped.Count -gt 0) { $reason = $reason + ' (' + ($unmapped -join ', ') + ')' }
            }
            if (-not [string]::IsNullOrWhiteSpace($reason)) { $costDetail = $reason }
        }
        if ($Compact) { return '[TURN] in {0} | out {1} | cache {2} | cost ~{3}' -f (Format-TMInteger $effective),(Format-TMInteger $output),$ratioText,$costText.Replace(' USD','') }
        $cacheRatioLabel = -join @([char]0x7F13,[char]0x5B58,[char]0x8BFB,[char]0x53D6,[char]0x5360,[char]0x6BD4)
        $costLabel = -join @([char]0x8D39,[char]0x7528)
        $model = [string](Get-TMProperty $Record 'model')
        if ([string]::IsNullOrWhiteSpace($model)) { $model = 'unknown' }
        $costLine = '[EST:COST] {0}: {1}' -f $costLabel,$costText
        if (-not [string]::IsNullOrWhiteSpace($costDetail)) { $costLine += ' | ' + $costDetail }
        return @(
            '[REPORTED->TURN] {0} | model {1}' -f $cli,$model
            'fresh input: {0} | cache read: {1} | cache write: {2}' -f (Format-TMInteger $fresh),(Format-TMInteger $cacheRead),(Format-TMInteger $cacheWrite)
            'input: {0} | out: {1} | {2}: {3}' -f (Format-TMInteger $effective),(Format-TMInteger $output),$cacheRatioLabel,$ratioText
            $costLine
        ) -join [Environment]::NewLine
    }
    if ($quality -eq 'ESTIMATED_VISIBLE_TEXT') {
        return '[EST:VISIBLE] {0} | visible-in ~{1} | visible-out ~{2} | not billable-total' -f $cli,(Format-TMInteger (Get-TMProperty $usage 'estimated_visible_input_tokens')),(Format-TMInteger (Get-TMProperty $usage 'estimated_visible_output_tokens'))
    }
    return '[UNAVAILABLE] {0} | {1}' -f $cli,[string](Get-TMProperty $Record 'unavailable_reason')
}

function Get-TMLatestRecords {
    param([string]$HistoryPath)
    if (-not (Test-Path -LiteralPath $HistoryPath -PathType Leaf)) { return @() }
    $latest = @{}
    foreach ($line in [IO.File]::ReadLines($HistoryPath)) {
        try {
            $item = $line | ConvertFrom-Json
            $id = [string](Get-TMProperty $item 'logical_turn_id')
            if ([string]::IsNullOrWhiteSpace($id)) { continue }
            if (-not $latest.ContainsKey($id) -or (ConvertTo-TMInt64 $item.revision) -gt (ConvertTo-TMInt64 $latest[$id].revision)) { $latest[$id] = $item }
        }
        catch { }
    }
    return @($latest.Values)
}

Export-ModuleMember -Function Get-TMProperty,Get-TMHash,Get-TMPaths,Initialize-TMDataDirectory,Write-TMError,Read-TMJsonLines,Get-ClaudeTurnRecord,Get-CodexTurnRecord,Test-TMCodexSessionEligible,Save-TMTurnRecord,Format-TMTurnSummary,Get-TMLatestRecords,Write-TMAtomicJson,ConvertTo-TMCanonicalJson,Read-TMPriceTable,Resolve-TMPriceModel,Get-TMRatePeriod,Get-TMEstimatedCost
