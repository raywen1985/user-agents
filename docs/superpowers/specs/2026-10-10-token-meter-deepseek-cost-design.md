# Token Meter DeepSeek Cost Display Design

## Goal

Extend the existing Windows Token Meter so each reported turn shows the normalized input categories, effective input, output, cache-read ratio, and an estimated DeepSeek cost. Preserve portability when `.agents`, `.claude`, and `.codex` are copied to another Windows user or PC.

The token counts remain provider-reported values when the CLI transcript exposes usage. The calculated price is always an estimate because a third-party relay may rename models, alter billing, or omit usage fields.

## Display

For a provider-reported turn, format the summary as four compact lines:

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

The existing quality labels remain authoritative:

- `REPORTED->TURN`: token counts originate in provider/CLI usage fields and are aggregated or normalized per turn.
- `EST:VISIBLE`: only visible text could be estimated; no billable cost is calculated.
- `UNAVAILABLE`: no defensible token count was found.
- `EST:COST`: only the monetary amount is estimated. It does not downgrade reported token counts.

## Local Price Table

Add `token-meter/model-prices.json`. The module resolves it relative to `$PSScriptRoot`, so it remains portable and requires no installation-specific absolute path.

The table records:

- schema version and currency;
- source URL and verification date;
- official model name and display name;
- exact aliases and conservative regular-expression aliases for relay model names;
- peak and off-peak rates per one million tokens;
- ordinary input, cache read, cache write, and output rates;
- an explanation that cache write uses the ordinary-input/cache-miss rate because DeepSeek does not publish a separate cache-write price.

Initial aliases cover `deepseekv4flash`, `deepseek-flash`, `deepseek-v4-flash`, `deepseek-v4-1-flash-*`, `deepseekv4pro`, and `deepseek-v4-pro*`. Matching is case-insensitive. Exact aliases take priority over patterns.

Official rates retrieved from <https://api-docs.deepseek.com/quick_start/pricing> on 2026-10-10:

| Model | Period | Cache read | Ordinary input / cache write | Output |
| --- | --- | ---: | ---: | ---: |
| DeepSeek V4.1 Flash | Off-peak | $0.003 | $0.15 | $0.60 |
| DeepSeek V4.1 Flash | Peak | $0.006 | $0.30 | $1.20 |
| DeepSeek V4 Pro | Off-peak | $0.022 | $0.66 | $1.98 |
| DeepSeek V4 Pro | Peak | $0.044 | $1.32 | $3.96 |

All values are USD per one million tokens.

## Rate Selection And Cost

Choose the rate period from the turn timestamp. DeepSeek currently defines peak hours as 01:00-04:00 UTC and 06:00-10:00 UTC, Monday through Friday, excluding Chinese public holidays. The implementation applies the weekday and UTC-hour rules but does not maintain a Chinese holiday calendar. Weekends use off-peak rates. This limitation is another reason the amount is labeled as estimated.

Use half-open intervals, `01:00 <= UTC < 04:00` and `06:00 <= UTC < 10:00`, to avoid overlap at boundaries.

Calculate:

```text
cost = fresh input * ordinary input rate / 1,000,000
     + cache read * cache-read rate / 1,000,000
     + cache write * ordinary input rate / 1,000,000
     + generated output * output rate / 1,000,000
```

Use decimal arithmetic and retain an unrounded numeric total in history. Display USD to four decimal places.

## Data Flow And History

Before a record is saved, enrich it with an `estimated_cost` object containing the matched price-table entry, normalized model, selected rate period, individual cost components, total USD, source URL, verification date, and an `approximate` flag. This freezes the estimate used at the time of the turn so later table edits do not rewrite historical meaning.

`Format-TMTurnSummary` reads the saved snapshot. `Show-TokenHistory.ps1` therefore displays the same amount as the original per-turn message. The Claude status line may display the same formatted latest-turn summary without making network requests.

The hook never contacts DeepSeek. Price maintenance is a local JSON edit distributed with `.agents`.

## Failure Handling

- Missing, malformed, or unsupported price-table versions do not fail the hook. Token counts still print, followed by `[EST:COST] unavailable`.
- An unmatched or empty model prints `[EST:COST] unavailable | model not mapped`.
- Missing usage categories are treated according to the existing normalization rules, not invented by pricing code.
- A malformed timestamp uses the current UTC time and marks the rate-period source as fallback.
- A relay's model alias is never silently mapped to an unrelated model family.
- Pricing errors are logged through the existing Token Meter error log and do not interrupt Claude Code or Codex CLI.

## Testing

Extend `Test-TokenMeter.ps1` with deterministic checks for:

- exact and pattern aliases for Flash and Pro;
- unknown-model fallback;
- peak, off-peak, weekend, and boundary-time selection;
- cache-write tokens charged at ordinary-input rate;
- effective-input and cache-read-ratio calculations, including zero input;
- the known sample turn, which is approximately `$0.1065` at Flash off-peak and `$0.2129` at Flash peak;
- price snapshot persistence through save/deduplication/history formatting;
- malformed or missing price table without hook failure;
- existing portable `EncodedCommand` behavior and all current regression tests.

No network access is required by tests or runtime hooks.
