# Token Meter DeepSeek Cost Display Design

## Goal

Extend the existing Windows Token Meter so each reported turn shows the normalized input categories, effective input, output, cache-read ratio, and an estimated DeepSeek cost. Preserve portability when `.agents`, `.claude`, and `.codex` are copied to another Windows user or PC.

The token counts remain provider-reported values when the CLI transcript exposes usage. The calculated price is always an estimate because a third-party relay may rename models, alter billing, or omit usage fields.

## Display

For a provider-reported turn, hook and history output use four compact lines:

```text
[REPORTED->TURN] Claude | model deepseek-v4-1-flash-260910
fresh input: 590,497 | cache read: 4,738,816 | cache write: 0
input: 5,329,313 | out: 6,103 | cache read ratio: 88.92%
[EST:COST] $0.1065 USD | DeepSeek Flash off-peak
```

`input` means effective input:

```text
fresh input + cache read + cache write
```

The cache-read ratio is:

```text
cache read / effective input
```

If effective input is zero, the ratio is `0.00%`.

`ClaudeStatusLine.ps1` must not embed this multiline text. It calls `Format-TMTurnSummary -Compact` and shows one line:

```text
[TURN] in 5,329,313 | out 6,103 | cache 88.92% | cost ~$0.1065
```

The existing quality labels remain authoritative:

- `REPORTED->TURN`: token counts originate in provider/CLI usage fields and are aggregated or normalized per turn.
- `EST:VISIBLE`: only visible text could be estimated; no billable cost is calculated.
- `UNAVAILABLE`: no defensible token count was found.
- `EST:COST`: only the monetary amount is estimated. It does not downgrade reported token counts.

## Local Price Table

Add `token-meter/model-prices.json`. The module resolves it relative to `$PSScriptRoot`, so it remains portable and requires no installation-specific absolute path. JSON rate values are decimal strings and are parsed with invariant culture.

The table records:

- schema version and currency;
- source URL and verification date;
- official model name and display name;
- exact aliases and conservative regular-expression aliases for relay model names;
- peak and off-peak rates per one million tokens;
- ordinary input, cache read, cache write, and output rates;
- an explanation that cache write uses the ordinary-input/cache-miss rate because DeepSeek does not publish a separate cache-write price.

Model names are normalized with `Trim()` and `ToLowerInvariant()` only. Exact aliases take priority over anchored, full-string regular expressions. Initial aliases are:

- Flash exact: `deepseekv4flash`, `deepseek-flash`, `deepseek-v4-flash`.
- Flash regex: `^deepseek-v4-1-flash(?:-[0-9]{6})?$`.
- Pro exact: `deepseekv4pro`, `deepseek-v4-pro`.
- Pro regex: `^deepseek-v4-pro(?:-[0-9]{4})?$`.

This deliberately does not use glob syntax or substring matches.

The supported price-table schema is:

```json
{
  "schema_version": 1,
  "currency": "USD",
  "unit_tokens": 1000000,
  "source_url": "https://api-docs.deepseek.com/quick_start/pricing",
  "verified_on": "2026-10-10",
  "models": [
    {
      "id": "deepseek-v4.1-flash",
      "official_model": "deepseek-flash",
      "display_name": "DeepSeek V4.1 Flash",
      "aliases_exact": ["deepseekv4flash", "deepseek-flash", "deepseek-v4-flash"],
      "aliases_regex": ["^deepseek-v4-1-flash(?:-[0-9]{6})?$"],
      "rates": {
        "off_peak": {
          "fresh_input_usd_per_million": "0.15",
          "cache_read_usd_per_million": "0.003",
          "cache_write_usd_per_million": "0.15",
          "output_usd_per_million": "0.60"
        },
        "peak": {
          "fresh_input_usd_per_million": "0.30",
          "cache_read_usd_per_million": "0.006",
          "cache_write_usd_per_million": "0.30",
          "output_usd_per_million": "1.20"
        }
      },
      "cache_write_rule": "use_cache_miss_rate"
    }
  ]
}
```

The Pro entry has the same fields and the rates listed below. Only `schema_version: 1`, `currency: USD`, and `unit_tokens: 1000000` are accepted. Every rate must parse as a nonnegative invariant-culture decimal.

Official rates retrieved from <https://api-docs.deepseek.com/quick_start/pricing> on 2026-10-10:

| Model | Period | Cache read | Ordinary input / cache write | Output |
| --- | --- | ---: | ---: | ---: |
| DeepSeek V4.1 Flash | Off-peak | $0.003 | $0.15 | $0.60 |
| DeepSeek V4.1 Flash | Peak | $0.006 | $0.30 | $1.20 |
| DeepSeek V4 Pro | Off-peak | $0.022 | $0.66 | $1.98 |
| DeepSeek V4 Pro | Peak | $0.044 | $1.32 | $3.96 |

All values are USD per one million tokens.

## Rate Selection And Cost

DeepSeek currently defines peak hours as 01:00-04:00 UTC and 06:00-10:00 UTC, Monday through Friday, excluding Chinese public holidays. The implementation applies the weekday and UTC-hour rules but does not maintain a Chinese holiday calendar. Weekends use off-peak rates. This limitation is another reason the amount is labeled as estimated.

Use half-open intervals, `01:00 <= UTC < 04:00` and `06:00 <= UTC < 10:00`, to avoid overlap at boundaries.

Timestamp precedence and aggregation are explicit:

- Claude creates one pricing segment per deduplicated assistant message containing usage. Each segment uses that assistant transcript row's parseable `timestamp`; otherwise it uses the initiating human row's parseable `timestamp`; otherwise it receives the single fallback UTC instant captured once when the parser starts. Each segment is priced using its own model and period. If any contributing segment has an empty or unmapped model, the entire turn's cost is unavailable rather than partially priced. Mixed canonical DeepSeek models and turns spanning price periods remain priceable because segments are calculated separately.
- Codex uses the selected final cumulative `token_usage_record` row's parseable `timestamp`. If absent, it uses the matching turn-context timestamp; if absent, it receives the single fallback UTC instant captured once when the parser starts. The final cumulative usage is priced as one segment. A Codex turn spanning two rate periods cannot be split from the available cumulative record, so its entire usage uses the final record's period and remains explicitly estimated.
- Every selected or fallback UTC instant and its source are persisted in the estimate. The fallback is captured once, not recalculated while saving or retrying.

Calculate:

```text
cost = fresh input * ordinary input rate / 1,000,000
     + cache read * cache-read rate / 1,000,000
     + cache write * ordinary input rate / 1,000,000
     + generated output * output rate / 1,000,000
```

Use decimal arithmetic. Persist invariant-culture decimal strings without display rounding and format USD and percentages with invariant culture. Display USD to four decimal places.

## Data Flow And History

The parsers add source-derived `pricing_segments` to the record. Each segment contains raw model, token categories, the selected transcript timestamp when present, and its timestamp source. `pricing_segments` participates in the source snapshot hash because it is source evidence relevant to cost. A parser fallback timestamp is carried in the segment but excluded from the snapshot hash so a retry cannot acquire a new identity near a rate boundary.

`Save-TMTurnRecord` keeps the current logical-turn and source-snapshot identity rules, with `pricing_segments` added to the source snapshot. `estimated_cost`, price-table metadata, computed rate period, and fallback timestamp are explicitly excluded from identity. Under the history mutex, the save path checks for an existing source record before calculating cost. An exact retry always returns the original saved record and original estimate, even if the table, current time, or rate period has changed.

For a new source record, enrich it once with this additive history field:

```json
{
  "estimated_cost": {
    "status": "estimated",
    "reason": null,
    "approximate": true,
    "currency": "USD",
    "total_usd": "0.106452798",
    "components_usd": {
      "fresh_input": "0.08857455",
      "cache_read": "0.014216448",
      "cache_write": "0",
      "output": "0.0036618"
    },
    "price_table": {
      "schema_version": 1,
      "source_url": "https://api-docs.deepseek.com/quick_start/pricing",
      "verified_on": "2026-10-10"
    },
    "segments": [
      {
        "raw_model": "deepseek-v4-1-flash-260910",
        "model_id": "deepseek-v4.1-flash",
        "display_name": "DeepSeek V4.1 Flash",
        "rate_period": "off_peak",
        "priced_at_utc": "2026-10-10T05:00:00.0000000+00:00",
        "pricing_time_source": "assistant_row_timestamp",
        "tokens": {"fresh_input": 590497, "cache_read": 4738816, "cache_write": 0, "output": 6103},
        "rates_usd_per_million": {"fresh_input": "0.15", "cache_read": "0.003", "cache_write": "0.15", "output": "0.60"},
        "total_usd": "0.106452798"
      }
    ]
  }
}
```

Unavailable estimates use the same top-level shape with `status: "unavailable"`, a stable machine-readable `reason` such as `model_not_mapped`, `mixed_or_missing_segment_data`, `invalid_usage`, or `price_table_invalid`, `total_usd: null`, empty components/segments as appropriate, and any available raw model. The additive field does not increment the existing history `schema_version: 1` because old readers ignore unknown fields.

`Format-TMTurnSummary` reads only the saved snapshot. `Show-TokenHistory.ps1` therefore displays the same amount as the original per-turn message. Old history records that lack `estimated_cost` render `[EST:COST] unavailable | not recorded`; they are never repriced from the current table. `ClaudeStatusLine.ps1` requests compact formatting and also performs no pricing or network requests.

The hook never contacts DeepSeek. Price maintenance is a local JSON edit distributed with `.agents`.

## Failure Handling

- Missing, malformed, or unsupported price-table versions do not fail the hook. Token counts still print, followed by `[EST:COST] unavailable`.
- An unmatched or empty model prints `[EST:COST] unavailable | model not mapped`.
- Missing usage categories are treated according to the existing normalization rules, not invented by pricing code.
- A missing or malformed timestamp uses the parser's one captured UTC fallback and marks the rate-period source as fallback.
- A relay's model alias is never silently mapped to an unrelated model family.
- Normalized token counts must be nonnegative, effective input must equal the input categories, and cache read cannot exceed effective input. Invalid usage yields an unavailable cost instead of a negative amount or ratio above 100%.
- Pricing errors are logged through the existing Token Meter error log and do not interrupt Claude Code or Codex CLI.

## Testing

Extend `Test-TokenMeter.ps1` with deterministic checks for:

- exact and pattern aliases for Flash and Pro;
- unknown-model fallback;
- peak, off-peak, weekend, and boundary-time selection;
- cache-write tokens charged at ordinary-input rate;
- effective-input and cache-read-ratio calculations, including zero input;
- per-message Claude pricing for mixed models and turns spanning periods;
- Codex final-record timestamp selection and its documented whole-turn approximation;
- the known sample turn, which is approximately `$0.1065` at Flash off-peak and `$0.2129` at Flash peak;
- price snapshot persistence through save/deduplication/history formatting;
- an exact retry after price-table and clock changes returning the original estimate;
- old history without `estimated_cost` remaining unpriced;
- invariant formatting under a non-English Windows culture;
- malformed or missing price table without hook failure;
- existing portable `EncodedCommand` behavior and all current regression tests.

No network access is required by tests or runtime hooks.
