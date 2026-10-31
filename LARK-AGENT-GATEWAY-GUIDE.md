# 飞书远程控制 Codex / Claude 使用与部署手册

本文说明如何使用飞书私聊控制本机 Codex、Claude，以及如何把该功能迁移到另一台 Windows 电脑。

## 1. 功能概览

网关目录：

```text
C:\Users\<UserName>\.agents\claude-projects\lark
```

工作流程：

```text
飞书私聊
  -> 飞书事件监听
  -> Claude 自然语言路由
  -> 项目、执行器、Session 确定性校验
  -> Codex 或 Claude 独立 Session
  -> 飞书返回最小摘要
```

主要约束：

- 只接受 `config/gateway.json` 中 `allowedOpenIds` 指定用户的飞书私聊文本。
- 只能操作 `config/projects.json` 中登记的项目。
- Codex 和 Claude 使用相互独立的远程 Session。
- 同一项目中的任务严格串行；不同项目默认最多并发两个。
- Codex 的普通项目内新增、修改可以自动批准；删除、越界写和未知命令需要在飞书二次确认。
- 每条任务消息均包含：`执行器 | 项目 | Session Name | Session ID`。
- 网关任务通过 `LARK_GATEWAY_MANAGED=1` 禁用已有通知 Hook，避免重复发送。

Claude 任务已开启完整执行模式：终端命令、跨目录文件访问、已配置的 MCP 和技能均可使用，
普通工具权限由 `bypassPermissions` 放行。原有会话下一次续接即可生效；例如发送
`claude unityhub 继续打开 Unity 项目并检查 MCP`。这不会自动重放旧任务，也不会替代软件安装、
服务启动或 Windows/管理员权限。排障时检查网关 `run/health.json` 中
`claudeExecutionMode` 是否为 `full_access`。详细配置和回退方式见
[网关 README](claude-projects/lark/README.md)。

## 2. 日常使用

在飞书中私聊已配置的机器人，直接使用自然语言。

### 2.1 新建 Session

```text
让 Codex 在 unity 项目检查资源泄漏
让 Claude 在 unity 项目审查登录模块，并命名为“登录审查”
```

没有明确执行器且无法从上下文继承时，网关会询问使用 Codex 还是 Claude。

### 2.2 继续 Session

```text
继续刚才那个，把第一项修掉
继续“登录审查”Session，只处理空引用问题
```

也可以回复某条带 Session 信息的机器人消息，网关会优先继续该消息绑定的 Session。

升级后的 Codex / Claude 结束或中断通知也支持：使用飞书“回复”回复通知，输入
“继续检查”或“按方案 A 执行”，即可按原生 Session ID 续接；回复数字也是该会话的
任务内容。旧通知没有绑定时，请取消回复并发送 `codex/claude 会话名 任务内容`。
正在占用的会话需先释放；Claude Code 进程即使空闲，也需先退出其持有的会话。
通知回复不能用于批准原生客户端的权限弹窗。

### 2.3 查询与管理

```text
列出最近的 Session
查看“登录审查”的状态
取消“登录审查”
```

### 2.4 审批高风险操作

当消息中出现 `RQ-...` 请求 ID 时，可回复：

```text
批准 RQ-260930-ABC123
拒绝 RQ-260930-ABC123
```

审批默认十分钟过期。不要批准无法确认目标路径或作用范围的操作。

## 3. 本机启动与维护

计划任务名称为 `LarkClaudeGateway`，默认在安装它的 Windows 用户登录后启动。停留在 Windows 登录界面时不会启动。

### 3.1 查看状态

```powershell
Set-Location "$env:USERPROFILE\.agents\claude-projects\lark"
npm run status
Get-ScheduledTask -TaskName "LarkClaudeGateway"
```

正常状态应满足：

- 计划任务状态为 `Running`。
- `health.listenerReady` 为 `true`。
- 飞书事件总线状态为 `running`。
- `im.message.receive_v1` 的 `active_consumers` 为 `1`。

### 3.2 手工启动与停止

```powershell
Set-Location "$env:USERPROFILE\.agents\claude-projects\lark"
./scripts/start.ps1
./scripts/stop.ps1
```

前台执行 `start.ps1` 时，关闭该 PowerShell 窗口会停止网关。日常运行应使用计划任务。

### 3.3 恢复计划任务

```powershell
Start-ScheduledTask -TaskName "LarkClaudeGateway"
```

重新注册计划任务：

```powershell
Set-Location "$env:USERPROFILE\.agents\claude-projects\lark"
./scripts/install-task.ps1
```

### 3.4 日志和数据

```text
日志：%LOCALAPPDATA%\lark-claude\gateway.log
回退日志：<网关目录>\logs\gateway.log
健康状态：<网关目录>\run\health.json
Session 数据：<网关目录>\data\gateway.sqlite
```

`data`、`logs`、`run` 都是运行时目录，不属于部署源码。

## 4. 修改配置

修改配置前先停止计划任务：

```powershell
Stop-ScheduledTask -TaskName "LarkClaudeGateway"
Set-Location "$env:USERPROFILE\.agents\claude-projects\lark"
./scripts/stop.ps1
```

修改完成后重新运行 `./scripts/install-task.ps1`。

### 4.1 网关配置

文件：`config/gateway.json`

关键字段：

| 字段 | 说明 |
|---|---|
| `allowedOpenIds` | 允许控制网关的飞书用户 `open_id` 列表 |
| `recipientOpenId` | 状态和结果接收人的 `open_id` |
| `maxConcurrentProjects` | 不同项目最大并发数 |
| `routerModel` | 自然语言路由使用的 Claude 模型 |
| `workerModel` | Claude 执行任务使用的模型 |
| `summaryLength` | 飞书最小摘要的最大长度 |
| `executables` | Node、lark-cli、Claude、Codex 的绝对路径 |

不要把飞书密钥、模型 Token 或密码写入该文件。

### 4.2 项目白名单

文件：`config/projects.json`

```json
{
  "projects": [
    {
      "alias": "unity_asset",
      "displayName": "unity_asset",
      "path": "D:\\WA\\unity_asset",
      "aliases": ["unity", "unity项目"],
      "commands": {}
    }
  ]
}
```

要求：

- `alias` 在所有项目中唯一。
- `path` 必须是新电脑上的真实绝对目录。
- 不要登记相互包含或重叠的项目根目录。
- 飞书消息中的任意绝对路径不会自动加入白名单。

## 5. 迁移到另一台电脑

推荐采用干净迁移：只复制源码和配置模板，在新电脑重新安装 CLI、认证并注册计划任务。

### 5.1 源电脑：停止并导出

```powershell
$SourceGateway = Join-Path $env:USERPROFILE ".agents\claude-projects\lark"
$SourceSessionMgr = Join-Path $env:USERPROFILE ".agents\skills\session-mgr"
$TransferRoot = Join-Path $env:USERPROFILE "agent-transfer"
$TransferGateway = Join-Path $TransferRoot "claude-projects\lark"
$TransferSessionMgr = Join-Path $TransferRoot "skills\session-mgr"

Stop-ScheduledTask -TaskName "LarkClaudeGateway" -ErrorAction SilentlyContinue
& (Join-Path $SourceGateway "scripts\stop.ps1")

New-Item -ItemType Directory -Path $TransferGateway -Force | Out-Null
robocopy $SourceGateway $TransferGateway /E /XD .git data logs run
robocopy $SourceSessionMgr $TransferSessionMgr /E /XD .git node_modules
```

`robocopy` 退出码 `0` 到 `7` 通常都表示复制完成；`8` 及以上表示失败。

将整个 `agent-transfer` 目录带到目标电脑。项目概况、活动会话和 Claude 历史读取现由
SessionMgr 提供；单独复制 Gateway 子目录会缺少运行依赖。

默认不要复制：

- `.git`：仅用于可选的源码版本管理，不影响运行。
- `data`：包含旧机器 Session 与任务状态；新机器通常无法恢复对应原生 Session。
- `run`：包含旧 PID 和健康状态，复制后会造成误判。
- `logs`：仅用于旧机器排错。
- Claude、Codex、飞书的 Token 或认证缓存。

若确实需要保留历史列表，可以在网关完全停止后单独备份 `data/gateway.sqlite`。但只有同时迁移相应 Claude/Codex 原生 Session 存储时，旧 Session 才可能继续执行，因此不推荐作为普通迁移方案。

`data/notification-bindings/` 保存本机新通知与原生 Session 的关联，也不随普通迁移复制。
新电脑从新发送的通知重新建立关联；旧电脑的通知不能在新电脑自动续接。

### 5.2 目标电脑：准备运行环境

安装并确认以下组件：

1. Windows 10/11。
2. Node.js 24 或更高版本；网关依赖内置 `node:sqlite`。
3. Claude Code CLI，并完成登录或模型供应商配置。
4. Codex CLI，并完成登录或模型供应商配置。
5. lark-cli。

检查命令：

```powershell
node --version
claude --version
codex --version
lark-cli --version
```

安装 lark-cli：

```powershell
npm install -g @larksuite/cli
```

如果 Claude/Codex 使用本地模型代理，例如 CC Switch，还必须在新电脑配置该代理自动启动，并确认对应本地端口可用。网关不会负责启动模型代理。

### 5.3 目标电脑：配置飞书 CLI

首次配置：

```powershell
lark-cli config init --new
```

按照 CLI 返回的链接完成飞书应用配置。不要把源电脑的明文 App Secret 写入迁移包或文档。

检查身份状态：

```powershell
lark-cli auth status --json --verify
lark-cli whoami
```

网关收发私聊使用 Bot 身份。若返回 `missing_scope`，应根据错误中的 `console_url` 在飞书开发者后台给 Bot 开通缺失权限；不要对 Bot 执行用户授权命令。

在启动网关前可做一次有限事件探针：

```powershell
lark-cli event consume im.message.receive_v1 --max-events 1 --timeout 10s --as bot
```

stderr 出现以下标记表示监听建立成功：

```text
[event] ready event_key=im.message.receive_v1
```

### 5.4 目标电脑：复制网关

```powershell
$TargetAgents = Join-Path $env:USERPROFILE ".agents"
$TargetGateway = Join-Path $TargetAgents "claude-projects\lark"
$TargetSessionMgr = Join-Path $TargetAgents "skills\session-mgr"
$TransferRoot = Join-Path $env:USERPROFILE "agent-transfer"

New-Item -ItemType Directory -Path $TargetGateway -Force | Out-Null
robocopy (Join-Path $TransferRoot "claude-projects\lark") $TargetGateway /E
robocopy (Join-Path $TransferRoot "skills\session-mgr") $TargetSessionMgr /E
```

安装前先运行 Gateway 的 `scripts/install-task.ps1 -DiscoveryOnly`，确认 SessionMgr
依赖和本机可执行程序均可用；安装器会按仓库相对位置查找技能，无需填写新的绝对路径。

不要使用会删除目标文件的 `/MIR`，除非已经人工确认目标目录中没有需要保留的内容。

### 5.5 更新新电脑配置

编辑：

```text
<目标用户目录>\.agents\claude-projects\lark\config\gateway.json
<目标用户目录>\.agents\claude-projects\lark\config\projects.json
```

必须更新：

1. `allowedOpenIds` 和 `recipientOpenId`。
2. Node、lark-cli、Claude、Codex 的绝对路径。
3. 每个项目在新电脑上的绝对路径和别名。
4. 模型名称、并发数和超时时间等机器相关配置。

可用以下命令查找程序路径：

```powershell
Get-Command node, lark-cli, claude, codex | Select-Object Name, Source
```

### 5.6 安装 Hook 防重复逻辑

如果新电脑已经配置了 Codex/Claude 会话结束飞书通知 Hook，需要确保 Hook 开头包含：

```powershell
if ($env:LARK_GATEWAY_MANAGED -eq "1")
{
    [Console]::Out.WriteLine("{}")
    exit 0
}
```

当前机器使用的 Hook 路径为：

```text
C:\Users\<UserName>\.agents\hooks\lark-notify.ps1
```

该判断只抑制网关托管任务的重复通知，不影响普通 Codex/Claude 会话通知。

普通会话通知遵循以下规则：

- Codex/Claude 会话正常结束或失败时发送。
- Claude 明确进入 `permission_prompt`、`idle_prompt` 或 `agent_needs_input`，确实等待用户处理时发送。
- 不发送 Codex `PermissionRequest` Hook 通知。该事件会在自动审核开始前触发，不能说明会话真的停在等待用户响应。
- 飞书网关自身生成的 `RQ-...` 审批仍会发送，因为此时远程任务确实在等待用户决定。

### 5.7 测试并安装计划任务

```powershell
Set-Location "$env:USERPROFILE\.agents\claude-projects\lark"
npm test
./scripts/install-task.ps1
```

计划任务绑定安装时的 Windows 用户。若换了用户账号，需要在对应账号下重新运行安装脚本。

## 6. 部署验收

### 6.1 本地验收

```powershell
Set-Location "$env:USERPROFILE\.agents\claude-projects\lark"
npm test
npm run status
lark-cli event status --json
```

### 6.2 飞书端到端验收

在机器人私聊中发送：

```text
让 Claude 在 unity 项目新建名为“部署验收”的会话，不调用工具，不修改文件，只回复“部署验收成功”
```

预期依次收到入队/开始和最终摘要消息，消息头应类似：

```text
[Claude | unity_asset | 部署验收 | CL-...]
```

然后测试 Codex：

```text
让 Codex 在 unity 项目新建名为“Codex 部署验收”的会话，不调用工具，不修改文件，只回复“Codex 部署验收成功”
```

## 7. 常见问题

### 7.1 飞书消息没有触发

依次检查：

```powershell
Get-ScheduledTask -TaskName "LarkClaudeGateway"
Set-Location "$env:USERPROFILE\.agents\claude-projects\lark"
npm run status
lark-cli event status --json
```

同时确认：

- 消息发送给正确的 Bot 私聊，而不是群聊。
- 消息类型是文本。
- 发送人的 `open_id` 存在于 `allowedOpenIds`。
- `active_consumers` 为 `1`，且 `dropped` 没有增长。

### 7.2 能收到消息，但 Claude/Codex 不执行

- 直接运行 `claude --version`、`codex --version` 检查路径。
- 检查 Claude/Codex 是否已登录或模型代理是否运行。
- 检查 `gateway.json` 中的绝对路径是否仍有效。
- 查看 `%LOCALAPPDATA%\lark-claude\gateway.log`。

### 7.3 收到重复通知

检查 `lark-notify.ps1` 是否包含 `LARK_GATEWAY_MANAGED` 静默退出逻辑。修改后重启计划任务。

### 7.4 修改目录后计划任务仍使用旧路径

重新执行：

```powershell
Set-Location "$env:USERPROFILE\.agents\claude-projects\lark"
./scripts/install-task.ps1
```

### 7.5 登录后没有自动启动

计划任务只在安装它的 Windows 用户登录时触发。确认当前用户与任务 `RunAs` 一致，然后执行：

```powershell
Start-ScheduledTask -TaskName "LarkClaudeGateway"
```

## 8. 安全注意事项

- 不要把飞书 App Secret、访问令牌、Claude/Codex Token 提交到 Git 或放入迁移压缩包。
- 不要将 Codex App Server、Claude 进程或网关端口暴露到公网。
- 只登记确实允许远程操作的项目目录。
- 不要直接修改 SQLite 数据库；变更前先停止网关并备份。
- 不认识的删除、越界写或 Shell 请求应选择拒绝。
- 迁移完成并通过验收后，安全删除包含配置副本的临时迁移目录。
