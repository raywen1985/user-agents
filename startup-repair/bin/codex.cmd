@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\.agents\startup-repair\Invoke-AIClient.ps1" -Client codex %*
exit /b %ERRORLEVEL%
