# AI integration startup repair

This Windows bootstrap repairs the shared Claude Code and Codex integrations
before CLI startup. It covers per-turn Token Meter configuration, Feishu
notifications, and the installed Feishu remote-control gateway.

Reusable scripts resolve the current user profile at runtime. Resolved client
commands and the Codex desktop application ID are stored only in the untracked
machine-local directory `%LOCALAPPDATA%\ai-integration-repair`.

## Install on each PC

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.agents\startup-repair\Install-AIIntegrationRepair.ps1"
```

Open a new terminal after installation. `claude` and `codex` then resolve to
the wrappers under `~/.agents/startup-repair/bin`. Each wrapper runs the
idempotent repair and then invokes the real command recorded for that PC.

The installer also creates `Codex (with self-check).lnk` on the desktop when a
Codex desktop application ID is discoverable. Use that shortcut when startup
repair must run immediately before the desktop app.

The `AIIntegrationRepair` scheduled task runs at user logon and every ten
minutes as a fallback for configuration changes made while a client is already
open. Repair warnings never block CLI startup and no check calls a model or
consumes model tokens.

## Validate

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.agents\startup-repair\Test-AIIntegrationRepair.ps1"
```
