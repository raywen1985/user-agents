[CmdletBinding()]
param([ValidateSet('claude','codex')][string]$ConfirmVisible)
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'TokenMeter.psm1') -Force
function Assert([bool]$Condition,[string]$Message){if(-not $Condition){throw "ASSERT: $Message"};$script:passed++}
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('token-meter-test-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testRoot)|Out-Null
$script:passed=0
$oldRoot=$env:TOKEN_METER_DATA_ROOT
$oldPricePath=$env:TOKEN_METER_PRICE_TABLE_PATH
$oldLocalPricePath=$env:TOKEN_METER_LOCAL_PRICE_TABLE_PATH
$oldCulture=[Threading.Thread]::CurrentThread.CurrentCulture
$summary=$null
try{
 $env:TOKEN_METER_DATA_ROOT=$testRoot
 $env:TOKEN_METER_PRICE_TABLE_PATH=$null
 $env:TOKEN_METER_LOCAL_PRICE_TABLE_PATH=Join-Path $testRoot 'missing-local.json'
 $priceTable=Read-TMPriceTable
 Assert ((Resolve-TMPriceModel $priceTable 'deepseekv4flash').id-eq'deepseek-v4.1-flash') 'Flash exact alias'
 Assert ((Resolve-TMPriceModel $priceTable 'deepseek-v4.1-flash').id-eq'deepseek-v4.1-flash') 'Flash dotted-version alias'
 Assert ((Resolve-TMPriceModel $priceTable ' DEEPSEEK-V4-1-FLASH-260910 ').id-eq'deepseek-v4.1-flash') 'Flash version alias and normalization'
 Assert ((Resolve-TMPriceModel $priceTable 'deepseekv4pro').id-eq'deepseek-v4-pro') 'Pro exact alias'
 Assert ((Resolve-TMPriceModel $priceTable 'deepseek-v4-pro-0813').id-eq'deepseek-v4-pro') 'Pro version alias'
 Assert ((Resolve-TMPriceModel $priceTable 'deepseek-v4.1-pro').id-eq'deepseek-v4-pro') 'Pro dotted alias'
 Assert ((Resolve-TMPriceModel $priceTable 'deepseek-v4-1-pro-260910').id-eq'deepseek-v4-pro') 'Pro dotted version alias'
 Assert ((Resolve-TMPriceModel $priceTable 'cc-deepseek-v4.1-flash').id-eq'deepseek-v4.1-flash') 'Claude Code proxy prefix alias'
 Assert ($null-eq(Resolve-TMPriceModel $priceTable 'not-deepseek-v4-pro')) 'Unknown model is not substring matched'

 $localPricePath=Join-Path $testRoot 'local-prices.json'
 [IO.File]::WriteAllText($localPricePath, @'
{"schema_version":1,"currency":"USD","unit_tokens":1000000,"source_url":"local test","verified_on":"2026-10-25","models":[
{"id":"gpt-5.6-sol","official_model":"gpt-5.6-sol","display_name":"GPT-5.6 Sol","aliases_exact":["gpt-5.6-sol"],"aliases_regex":[],"rates":{"off_peak":{"fresh_input_usd_per_million":"1","cache_read_usd_per_million":"0.1","cache_write_usd_per_million":"1","output_usd_per_million":"2"},"peak":{"fresh_input_usd_per_million":"2","cache_read_usd_per_million":"0.2","cache_write_usd_per_million":"2","output_usd_per_million":"4"}}},
{"id":"deepseek-v4.1-flash","official_model":"local-flash","display_name":"Overridden Flash","aliases_exact":["deepseek-v4.1-flash"],"aliases_regex":[],"rates":{"off_peak":{"fresh_input_usd_per_million":"0.5","cache_read_usd_per_million":"0.01","cache_write_usd_per_million":"0.5","output_usd_per_million":"1"},"peak":{"fresh_input_usd_per_million":"1","cache_read_usd_per_million":"0.02","cache_write_usd_per_million":"1","output_usd_per_million":"2"}}}
]}
'@,[Text.UTF8Encoding]::new($false))
 $env:TOKEN_METER_LOCAL_PRICE_TABLE_PATH=$localPricePath
 $localTable=Read-TMPriceTable
 Assert ((Resolve-TMPriceModel $localTable 'gpt-5.6-sol').id-eq'gpt-5.6-sol') 'Local price table adds a model'
 Assert ((Resolve-TMPriceModel $localTable 'deepseek-v4.1-flash').display_name-eq'Overridden Flash') 'Local price table overrides a model id'
 $localSample=[ordered]@{quality='DERIVED_REPORTED';model='gpt-5.6-sol';normalized_usage=[ordered]@{fresh_input_tokens=1000000;cache_read_tokens=0;cache_write_tokens=0;effective_input_tokens=1000000;generated_output_tokens=0};pricing_segments=@([ordered]@{raw_model='gpt-5.6-sol';timestamp_utc='2026-10-10T05:00:00Z';timestamp_source='test';is_fallback=$false;tokens=[ordered]@{fresh_input=1000000;cache_read=0;cache_write=0;output=0}})}
 $localCost=Get-TMEstimatedCost $localSample
 Assert ($localCost.status-eq'estimated') 'Local price estimates cost'
 Assert ($localCost.total_usd-eq'1') 'Local off-peak rate applied'
 Assert ($localCost.price_table.local_verified_on-eq'2026-10-25') 'Local price metadata recorded'
 $badLocalPath=Join-Path $testRoot 'bad-local-prices.json'
 [IO.File]::WriteAllText($badLocalPath,'{"schema_version":999}',[Text.UTF8Encoding]::new($false))
 $env:TOKEN_METER_LOCAL_PRICE_TABLE_PATH=$badLocalPath
 Assert ((Get-TMEstimatedCost $localSample).reason-eq'price_table_invalid') 'Invalid local table falls back safely'
 $env:TOKEN_METER_LOCAL_PRICE_TABLE_PATH=Join-Path $testRoot 'missing-local.json'
 Assert ((Get-TMRatePeriod '2026-10-09T00:59:59Z')-eq'off_peak') 'Before first peak boundary'
 Assert ((Get-TMRatePeriod '2026-10-09T01:00:00Z')-eq'peak') 'First peak boundary'
 Assert ((Get-TMRatePeriod '2026-10-09T04:00:00Z')-eq'off_peak') 'First peak end boundary'
 Assert ((Get-TMRatePeriod '2026-10-09T06:00:00Z')-eq'peak') 'Second peak boundary'
 Assert ((Get-TMRatePeriod '2026-10-09T10:00:00Z')-eq'off_peak') 'Second peak end boundary'
 Assert ((Get-TMRatePeriod '2026-10-10T07:00:00Z')-eq'off_peak') 'Weekend is off peak'

 $claude=Get-ClaudeTurnRecord ([pscustomobject]@{session_id='claude-session-1';transcript_path=(Join-Path $PSScriptRoot 'fixtures\claude-turn.jsonl')})
 Assert ($claude.quality-eq'DERIVED_REPORTED') 'Claude quality'
 Assert ($claude.normalized_usage.effective_input_tokens-eq185) 'Claude input aggregation'
 Assert ($claude.normalized_usage.generated_output_tokens-eq12) 'Claude output aggregation'
 Assert (@($claude.pricing_segments).Count-eq2) 'Claude per-message pricing segments'
 Assert ((Get-TMEstimatedCost $claude).status-eq'estimated') 'Claude price estimate'

 $codex=Get-CodexTurnRecord ([pscustomobject]@{session_id='codex-session-1';turn_id='codex-turn-1';transcript_path=(Join-Path $PSScriptRoot 'fixtures\codex-turn.jsonl')})
 Assert ($codex.source_cursor-eq4) 'Codex chooses final cumulative record'
 Assert ($codex.normalized_usage.fresh_input_tokens-eq116) 'Codex cache semantics'
 Assert ($codex.normalized_usage.visible_output_tokens-eq17) 'Codex reasoning subset'
 Assert ($codex.pricing_segments[0].timestamp_source-eq'token_usage_row_timestamp') 'Codex final-record timestamp selection'

 $sharedPath=Join-Path $testRoot 'shared.jsonl'
 [IO.File]::WriteAllText($sharedPath,'{"type":"user","uuid":"shared"}'+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
 $writer=[IO.File]::Open($sharedPath,[IO.FileMode]::Append,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite)
 try{$sharedRows=@(Read-TMJsonLines $sharedPath);Assert ($sharedRows.Count-eq1-and$sharedRows[0].Object.uuid-eq'shared') 'Shared transcript is readable while the CLI holds it open'}
 finally{$writer.Dispose()}

 $syntheticPath=Join-Path $testRoot 'synthetic.jsonl'
 [IO.File]::WriteAllLines($syntheticPath,@(
  '{"type":"user","uuid":"synthetic-turn","timestamp":"2026-10-09T01:00:00Z","message":{"role":"user","content":"hello"}}',
  '{"type":"assistant","uuid":"s1","timestamp":"2026-10-09T01:00:01Z","message":{"id":"synthetic-1","model":"deepseek-flash","usage":{"input_tokens":100,"cache_read_input_tokens":20,"cache_creation_input_tokens":0,"output_tokens":5}}}',
  '{"type":"assistant","uuid":"s2","timestamp":"2026-10-09T01:00:02Z","message":{"id":"synthetic-2","model":"<synthetic>","usage":{"input_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":0}}}'
 ),[Text.UTF8Encoding]::new($false))
 $synthetic=Get-ClaudeTurnRecord ([pscustomobject]@{session_id='synthetic-session';transcript_path=$syntheticPath})
 Assert ($synthetic.model-eq'deepseek-flash') 'Synthetic rows do not override the model'
 Assert (@($synthetic.pricing_segments).Count-eq1) 'Zero-token usage is not priced'
 Assert ((Get-TMEstimatedCost $synthetic).status-eq'estimated') 'Synthetic rows do not break pricing'

 $metaPath=Join-Path $testRoot 'meta-user.jsonl'
 [IO.File]::WriteAllLines($metaPath,@(
  '{"type":"user","uuid":"real-turn","timestamp":"2026-10-09T01:00:00Z","message":{"role":"user","content":"hello"}}',
  '{"type":"assistant","uuid":"m1","timestamp":"2026-10-09T01:00:01Z","message":{"id":"meta-1","model":"deepseek-flash","usage":{"input_tokens":100,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":5}}}',
  '{"type":"user","isMeta":true,"uuid":"meta-row","timestamp":"2026-10-09T01:00:02Z","message":{"role":"user","content":"<local-command-caveat>ignored"}}'
 ),[Text.UTF8Encoding]::new($false))
 $metaTurn=Get-ClaudeTurnRecord ([pscustomobject]@{session_id='meta-session';transcript_path=$metaPath})
 Assert ($metaTurn.turn_id-eq'real-turn') 'isMeta user rows are not turn boundaries'
 Assert ($metaTurn.quality-eq'DERIVED_REPORTED') 'isMeta rows keep the reported usage'

 $thinkingPath=Join-Path $testRoot 'thinking.jsonl'
 [IO.File]::WriteAllLines($thinkingPath,@(
  '{"type":"user","uuid":"thinking-turn","timestamp":"2026-10-09T01:00:00Z","message":{"role":"user","content":"hello"}}',
  '{"type":"assistant","uuid":"t1","timestamp":"2026-10-09T01:00:01Z","message":{"id":"thinking-1","model":"deepseek-flash","usage":{"input_tokens":100,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":100,"output_tokens_details":{"thinking_tokens":40}}}}'
 ),[Text.UTF8Encoding]::new($false))
 $thinking=Get-ClaudeTurnRecord ([pscustomobject]@{session_id='thinking-session';transcript_path=$thinkingPath})
 Assert ($thinking.normalized_usage.reasoning_output_tokens-eq40) 'Thinking tokens are recorded'
 Assert ($thinking.normalized_usage.visible_output_tokens-eq60) 'Visible output excludes thinking'
 Assert ($thinking.normalized_usage.generated_output_tokens-eq100) 'Generated output keeps thinking'
 Assert ($thinking.semantics.source_output_includes_reasoning-eq$true) 'Output reasoning semantics'

 $unmapped=[ordered]@{quality='DERIVED_REPORTED';model='gpt-5.6-sol';normalized_usage=[ordered]@{fresh_input_tokens=10;cache_read_tokens=0;cache_write_tokens=0;effective_input_tokens=10;generated_output_tokens=1};pricing_segments=@([ordered]@{raw_model='gpt-5.6-sol';timestamp_utc='2026-10-10T05:00:00Z';timestamp_source='test';is_fallback=$false;tokens=[ordered]@{fresh_input=10;cache_read=0;cache_write=0;output=1}})}
 $unmappedCost=Get-TMEstimatedCost $unmapped
 Assert ($unmappedCost.reason-eq'model_not_mapped') 'Unpriced model stays unavailable'
 $formattedUnmapped=Format-TMTurnSummary ([pscustomobject]@{cli='codex';model='gpt-5.6-sol';quality='DERIVED_REPORTED';normalized_usage=$unmapped.normalized_usage;estimated_cost=$unmappedCost})
 Assert ($formattedUnmapped-match'gpt-5\.6-sol') 'Unpriced model is named in the cost line'

 $desktopPath=Join-Path $testRoot 'desktop-codex.jsonl'
 [IO.File]::WriteAllLines($desktopPath,@(
  '{"timestamp":"2026-10-09T01:00:00Z","ordinal":1,"type":"session_meta","payload":{"session_id":"desktop-session","id":"thread-1","parent_thread_id":null,"originator":"Codex Desktop","source":"vscode","thread_source":"user"}}',
  '{"timestamp":"2026-10-09T01:00:01Z","ordinal":2,"type":"turn_context","payload":{"turn_id":"desktop-turn","model":"deepseek-v4-pro"}}',
  '{"timestamp":"2026-10-09T01:00:02Z","ordinal":3,"type":"token_usage_record","payload":{"turn_id":"desktop-turn","turn_token_usage":{"input_tokens":180,"cached_input_tokens":64,"cache_write_input_tokens":0,"output_tokens":25,"reasoning_output_tokens":8,"total_tokens":205}}}'
 ),[Text.UTF8Encoding]::new($false))
 $desktop=Get-CodexTurnRecord ([pscustomobject]@{session_id='desktop-session';turn_id='desktop-turn';transcript_path=$desktopPath})
 Assert ($desktop.quality-eq'DERIVED_REPORTED') 'Top-level Desktop threads are counted'

 $nestedPath=Join-Path $testRoot 'nested-codex.jsonl'
 [IO.File]::WriteAllLines($nestedPath,@(
  '{"timestamp":"2026-10-09T01:00:00Z","ordinal":1,"type":"session_meta","payload":{"session_id":"nested-session","id":"thread-2","parent_thread_id":"thread-1","originator":"Codex Desktop","source":{"subagent":{"other":"guardian"}},"thread_source":"guardian_review"}}',
  '{"timestamp":"2026-10-09T01:00:01Z","ordinal":2,"type":"turn_context","payload":{"turn_id":"nested-turn","model":"deepseek-v4-pro"}}',
  '{"timestamp":"2026-10-09T01:00:02Z","ordinal":3,"type":"token_usage_record","payload":{"turn_id":"nested-turn","turn_token_usage":{"input_tokens":10,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0,"total_tokens":11}}}'
 ),[Text.UTF8Encoding]::new($false))
 $nested=Get-CodexTurnRecord ([pscustomobject]@{session_id='nested-session';turn_id='nested-turn';transcript_path=$nestedPath})
 Assert ($nested.quality-eq'EXCLUDED') 'Nested subagent threads are excluded'
 Assert ($nested.turn_id-eq'nested-turn') 'Excluded record keeps its turn identity'

 $emptyMessage=''
 try{$null=Get-CodexTurnRecord ([pscustomobject]@{session_id='s';turn_id='t';transcript_path=''})}catch{$emptyMessage=$_.Exception.Message}
 Assert ($emptyMessage-match'transcript_path') 'Empty Codex transcript path reports a clear error'
 $emptyMessage=''
 try{$null=Get-ClaudeTurnRecord ([pscustomobject]@{session_id='s';transcript_path=''})}catch{$emptyMessage=$_.Exception.Message}
 Assert ($emptyMessage-match'transcript_path') 'Empty Claude transcript path reports a clear error'

 $sample=[ordered]@{
  quality='DERIVED_REPORTED';model='deepseek-v4-1-flash-260910'
  normalized_usage=[ordered]@{fresh_input_tokens=590497;cache_read_tokens=4738816;cache_write_tokens=0;effective_input_tokens=5329313;generated_output_tokens=6103}
  pricing_segments=@([ordered]@{raw_model='deepseek-v4-1-flash-260910';timestamp_utc='2026-10-10T05:00:00Z';timestamp_source='test';is_fallback=$false;tokens=[ordered]@{fresh_input=590497;cache_read=4738816;cache_write=0;output=6103}})
 }
 $sampleCost=Get-TMEstimatedCost $sample
 Assert ($sampleCost.total_usd-eq'0.106452798') 'Known Flash off-peak sample cost'
 $samplePeak=($sample|ConvertTo-Json -Depth 20|ConvertFrom-Json);$samplePeak.pricing_segments[0].timestamp_utc='2026-10-09T01:00:00Z'
 Assert ((Get-TMEstimatedCost $samplePeak).total_usd-eq'0.212905596') 'Known Flash peak sample cost'
 $cacheWrite=[ordered]@{quality='DERIVED_REPORTED';model='deepseek-flash';normalized_usage=[ordered]@{fresh_input_tokens=0;cache_read_tokens=0;cache_write_tokens=1000000;effective_input_tokens=1000000;generated_output_tokens=0};pricing_segments=@([ordered]@{raw_model='deepseek-flash';timestamp_utc='2026-10-10T05:00:00Z';timestamp_source='test';is_fallback=$false;tokens=[ordered]@{fresh_input=0;cache_read=0;cache_write=1000000;output=0}})}
 Assert ((Get-TMEstimatedCost $cacheWrite).total_usd-eq'0.15') 'Cache write uses ordinary input rate'
 $unknown=($sample|ConvertTo-Json -Depth 20|ConvertFrom-Json);$unknown.model='unknown-model';$unknown.pricing_segments[0].raw_model='unknown-model'
 Assert ((Get-TMEstimatedCost $unknown).reason-eq'model_not_mapped') 'Unknown model fallback'
 $invalid=($sample|ConvertTo-Json -Depth 20|ConvertFrom-Json);$invalid.normalized_usage.effective_input_tokens=1
 Assert ((Get-TMEstimatedCost $invalid).reason-eq'invalid_usage') 'Inconsistent usage rejected'

 $mixedPath=Join-Path $testRoot 'mixed-claude.jsonl'
 [IO.File]::WriteAllLines($mixedPath,@(
  '{"type":"user","uuid":"mixed-turn","timestamp":"2026-10-09T00:30:00Z","message":{"role":"user","content":"hello"}}',
  '{"type":"assistant","uuid":"m1","timestamp":"2026-10-09T00:59:00Z","message":{"id":"mixed-1","model":"deepseek-flash","content":[{"type":"text","text":"one"}],"usage":{"input_tokens":100,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":10}}}',
  '{"type":"assistant","uuid":"m2","timestamp":"2026-10-09T01:01:00Z","message":{"id":"mixed-2","model":"deepseek-v4-pro","content":[{"type":"text","text":"two"}],"usage":{"input_tokens":200,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":20}}}'
 ),[Text.UTF8Encoding]::new($false))
 $mixed=Get-ClaudeTurnRecord ([pscustomobject]@{session_id='mixed-session';transcript_path=$mixedPath})
 $mixedCost=Get-TMEstimatedCost $mixed
 Assert ($mixedCost.status-eq'estimated') 'Mixed Claude models remain priceable by segment'
 Assert (@($mixedCost.segments|Select-Object -ExpandProperty model_id -Unique).Count-eq2) 'Mixed Claude model identities'
 Assert (@($mixedCost.segments|Select-Object -ExpandProperty rate_period -Unique).Count-eq2) 'Claude turn spanning rate periods'

 $a=Save-TMTurnRecord $codex
 Assert ($a.Action-eq'appended') 'First append'
 Assert ($a.Record.estimated_cost.status-eq'estimated') 'Saved price snapshot'
 $firstCost=[string]$a.Record.estimated_cost.total_usd
 $badPricePath=Join-Path $testRoot 'bad-prices.json'
 [IO.File]::WriteAllText($badPricePath,'{"schema_version":999}',[Text.UTF8Encoding]::new($false))
 $env:TOKEN_METER_PRICE_TABLE_PATH=$badPricePath
 $again=Save-TMTurnRecord $codex
 Assert ($again.Action-eq'duplicate') 'Exact retry deduplication'
 Assert ([string]$again.Record.estimated_cost.total_usd-eq$firstCost) 'Retry keeps original price after table change'
 $env:TOKEN_METER_PRICE_TABLE_PATH=$null

 $new=[ordered]@{};foreach($k in $codex.Keys){$new[$k]=$codex[$k]};$new.source_cursor=5;$new.normalized_usage=[ordered]@{fresh_input_tokens=120;cache_read_tokens=64;cache_write_tokens=0;effective_input_tokens=184;visible_output_tokens=18;reasoning_output_tokens=8;generated_output_tokens=26};$new.pricing_segments=@([ordered]@{raw_model=$codex.model;timestamp_utc='2026-10-09T01:00:04Z';timestamp_source='token_usage_row_timestamp';is_fallback=$false;tokens=[ordered]@{fresh_input=120;cache_read=64;cache_write=0;output=26}})
 $b=Save-TMTurnRecord $new
 Assert ($b.Action-eq'appended'-and$b.Record.revision-eq2) 'New snapshot revision'
 $late=Save-TMTurnRecord $codex
 Assert ($late.Action-eq'duplicate') 'A-B-A replay cannot roll back'
 $other=[ordered]@{};foreach($k in $codex.Keys){$other[$k]=$codex[$k]};$other.computer_scope='another-pc'
 $cross=Save-TMTurnRecord $other
 Assert ($cross.Action-eq'appended') 'Cross-machine namespace'

 $malformed=[ordered]@{};foreach($k in $codex.Keys){$malformed[$k]=$codex[$k]};$malformed.turn_id='malformed-price-turn';$malformed.source_cursor=7
 $env:TOKEN_METER_PRICE_TABLE_PATH=$badPricePath
 $malformedSaved=Save-TMTurnRecord $malformed
 Assert ($malformedSaved.Record.estimated_cost.reason-eq'price_table_invalid') 'Malformed price table does not fail save'
 $env:TOKEN_METER_PRICE_TABLE_PATH=$null

 $formatted=Format-TMTurnSummary $sample
 Assert ($formatted-match'not recorded') 'Unsaved or old history is not repriced'
 $pricedSample=[pscustomobject][ordered]@{cli='claude';model=$sample.model;quality=$sample.quality;normalized_usage=$sample.normalized_usage;estimated_cost=$sampleCost}
 [Threading.Thread]::CurrentThread.CurrentCulture=[Globalization.CultureInfo]::GetCultureInfo('de-DE')
 $formatted=Format-TMTurnSummary $pricedSample
 Assert ($formatted-match'\$0\.1065 USD') 'USD uses invariant decimal formatting'
 Assert ($formatted-match'88\.92%') 'Ratio uses invariant decimal formatting'
 Assert ($formatted-match'fresh input: 590,497') 'Token counts use invariant separators'
 Assert (-not((Format-TMTurnSummary $pricedSample -Compact)-match'[\r\n]')) 'Compact status stays on one line'
 [Threading.Thread]::CurrentThread.CurrentCulture=$oldCulture

 foreach($wrapper in @('Invoke-ClaudeTurnHook.cmd','Invoke-CodexTurnHook.cmd','Invoke-ClaudeStatusLine.cmd')){Assert ((Get-Content -Raw (Join-Path $PSScriptRoot $wrapper))-match'%USERPROFILE%') "$wrapper portable path"}
 $installer=Get-Content -Raw (Join-Path $PSScriptRoot 'Install-TokenMeter.ps1')
 Assert ($installer-match'-EncodedCommand') 'Installer uses an encoded PowerShell command boundary'
 $activeCommandLines=@($installer -split '\r?\n'|Where-Object{$_ -match '^\$(?:claude|codex|status)Command\s*='})
 Assert (@($activeCommandLines|Where-Object{$_ -match 'cmd\.exe'}).Count-eq0) 'Installer active commands do not start nested CMD'
 $summary=[pscustomobject]@{Passed=$script:passed;Claude='DERIVED_REPORTED';Codex='DERIVED_REPORTED';Pricing='DeepSeek official estimate';Revision='monotonic';Portability='GetFolderPath(UserProfile)';CommandBoundary='PowerShell EncodedCommand'}
}finally{
 [Threading.Thread]::CurrentThread.CurrentCulture=$oldCulture
 $env:TOKEN_METER_DATA_ROOT=$oldRoot
 $env:TOKEN_METER_PRICE_TABLE_PATH=$oldPricePath
 $env:TOKEN_METER_LOCAL_PRICE_TABLE_PATH=$oldLocalPricePath
 if($testRoot.StartsWith([IO.Path]::GetTempPath(),[StringComparison]::OrdinalIgnoreCase)-and(Test-Path -LiteralPath $testRoot)){Remove-Item -LiteralPath $testRoot -Recurse -Force}
}
if($ConfirmVisible){$paths=Initialize-TMDataDirectory;$state=[ordered]@{cli=$ConfirmVisible;state='user_confirmed_visible';confirmed_at=[DateTimeOffset]::Now.ToString('o')};Write-TMAtomicJson (Join-Path $paths.DataRoot ("visibility-$ConfirmVisible.json")) $state}
$summary|Format-List
