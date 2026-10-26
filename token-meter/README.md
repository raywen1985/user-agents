# Windows CLI Token Meter

Run the installer once after copying `.agents`, `.claude`, and `.codex` to a Windows user profile. The hook commands resolve `%USERPROFILE%`, so no source-machine absolute path is stored.

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.agents\token-meter\Install-TokenMeter.ps1"
```

History is written to `.agents/.token-meter-data/<computer>/<user>/history.jsonl` and is intentionally ignored by Git. Codex stats cover top-level user threads (CLI, exec, Desktop, IDE); nested subagent/guardian threads are not counted. `REPORTED->TURN` means a per-turn value derived from provider-reported CLI usage. `EST:COST` is a local USD estimate using `model-prices.json`; it is not a provider invoice. `EST:VISIBLE` is only a visible-text estimate and is not a billable total. `UNAVAILABLE` means no defensible number was present.

The bundled DeepSeek table was verified against the official pricing page on 2026-10-10. It contains peak and off-peak prices for DeepSeek V4.1 Flash and V4 Pro. DeepSeek publishes cache-hit and cache-miss input rates, but no separate cache-write rate, so cache-write tokens use the normal cache-miss input rate. Runtime hooks never access the network. Update the JSON file locally when official prices change.

Local overrides: `model-prices.local.json` beside `model-prices.json` is ignored by Git and merged by model `id` (a local entry replaces the bundled entry with the same id, otherwise it is appended). Set `TOKEN_METER_LOCAL_PRICE_TABLE_PATH` to use another file, or keep `models` empty to disable overrides. Use this for internal gateways and private aliases. Both `off_peak` and `peak` rates are required; the values below are placeholders:

```json
{
  "schema_version": 1, "currency": "USD", "unit_tokens": 1000000,
  "source_url": "internal gateway", "verified_on": "2026-10-25",
  "models": [{
    "id": "gpt-5.6-sol",
    "official_model": "gpt-5.6-sol",
    "display_name": "GPT-5.6 Sol (internal)",
    "aliases_exact": ["gpt-5.6-sol"],
    "aliases_regex": [],
    "rates": {
      "off_peak": {"fresh_input_usd_per_million": "1.00", "cache_read_usd_per_million": "0.10", "cache_write_usd_per_million": "1.00", "output_usd_per_million": "2.00"},
      "peak": {"fresh_input_usd_per_million": "2.00", "cache_read_usd_per_million": "0.20", "cache_write_usd_per_million": "2.00", "output_usd_per_million": "4.00"}
    },
    "cache_write_rule": "use_cache_miss_rate"
  }]
}
```

The installer records `configured_unverified`. After each CLI runs a normal real turn, its hook writes `hook-invoked-claude.json` or `hook-invoked-codex.json` beside the history. Use `Test-TokenMeter.ps1 -ConfirmVisible claude` or `-ConfirmVisible codex` only after personally seeing the per-turn message.

Useful commands:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.agents\token-meter\Show-TokenHistory.ps1" -Last 20
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.agents\token-meter\Show-TokenHistory.ps1" -Period Today
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.agents\token-meter\Show-TokenHistory.ps1" -AllMachines
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.agents\token-meter\Test-TokenMeter.ps1"
```
