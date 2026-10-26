$ErrorActionPreference = 'Stop'
Start-ScheduledTask -TaskPath '\' -TaskName 'LarkClaudeGateway'
