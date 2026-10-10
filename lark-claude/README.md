# Lark Agent Gateway

用户级飞书私聊网关：用自然语言创建或继续独立 Codex / Claude Session，并把最小摘要回发给本人。

## 配置

`config/gateway.json`：

- `allowedOpenIds`：允许控制网关的飞书用户 `open_id` 列表。
- `recipientOpenId`：状态与结果接收人的 `open_id`。
- `routerModel` / `workerModel`：Claude 路由和执行模型。
- `executables`：Node、lark-cli、Claude 使用绝对路径。Codex 可使用绝对
  `codex.exe` 路径，或设置为 `auto`。`auto` 会在每次 Codex 任务启动前
  优先发现 `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`，找不到可用
  桌面版本时回退到当前架构的默认用户级 npm 安装；自定义 npm prefix 请
  配置明确的绝对路径。候选文件必须通过 `app-server --help` 能力预检。

`config/projects.json`：登记允许操作的项目。每项必须包含唯一 `alias`、绝对 `path` 和可选 `aliases`。消息里的任意路径不会自动成为工作目录，必须先在这里登记。

示例：

```json
{
  "alias": "unity_asset",
  "displayName": "unity_asset",
  "path": "D:\\WA\\unity_asset",
  "aliases": ["unity", "unity项目"]
}
```

## 安装与运行

在 PowerShell 中执行：

```powershell
./scripts/install-task.ps1
```

计划任务 `LarkClaudeGateway` 会在用户登录时启动。手工前台启动、停止和查看状态：

```powershell
./scripts/start.ps1
./scripts/stop.ps1
npm run status
```

日志优先位于 `%LOCALAPPDATA%\lark-claude\gateway.log`；目录不可写时回退到项目的 `logs/gateway.log`。运行状态位于 `run/health.json`。

## 使用

在飞书中私聊机器人“温光辉的飞书 CLI”，直接描述意图，例如：

- `让 Codex 在 unity 项目检查资源泄漏`
- `让 Claude 在 unity 项目审查刚才的修改`
- `继续资源泄漏那个 Session，修复第一项`
- `列出最近的 Session`
- `取消资源泄漏那个 Session`
- `批准 RQ-260930-ABC123`

所有任务消息都会包含 `执行器 | 项目 | Session Name | Session ID`。同一项目严格串行，不同项目最多并发两个。Codex 的项目内普通新增/修改可自动批准；删除、越界写和未知命令需要在飞书二次确认。
