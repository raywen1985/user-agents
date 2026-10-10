# Windows CLI Token Meter

Run the installer once after copying `.agents`, `.claude`, and `.codex` to a Windows user profile. The hook commands resolve `%USERPROFILE%`, so no source-machine absolute path is stored.

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.agents\token-meter\Install-TokenMeter.ps1"
```

History is written to `.agents/.token-meter-data/<computer>/<user>/history.jsonl` and is intentionally ignored by Git. `REPORTED->TURN` means a per-turn value derived from provider-reported CLI usage. `EST:COST` is a local USD estimate using `model-prices.json`; it is not a provider invoice. `EST:VISIBLE` is only a visible-text estimate and is not a billable total. `UNAVAILABLE` means no defensible number was present.

The bundled DeepSeek table was verified against the official pricing page on 2026-10-10. It contains peak and off-peak prices for DeepSeek V4.1 Flash and V4 Pro. DeepSeek publishes cache-hit and cache-miss input rates, but no separate cache-write rate, so cache-write tokens use the normal cache-miss input rate. Runtime hooks never access the network. Update the JSON file locally when official prices change.

The installer records `configured_unverified`. After each CLI runs a normal real turn, its hook writes `hook-invoked-claude.json` or `hook-invoked-codex.json` beside the history. Use `Test-TokenMeter.ps1 -ConfirmVisible claude` or `-ConfirmVisible codex` only after personally seeing the per-turn message.

Useful commands:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.agents\token-meter\Show-TokenHistory.ps1" -Last 20
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.agents\token-meter\Show-TokenHistory.ps1" -Period Today
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.agents\token-meter\Show-TokenHistory.ps1" -AllMachines
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.agents\token-meter\Test-TokenMeter.ps1"
```
