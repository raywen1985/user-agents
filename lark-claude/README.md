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
- `codexControl`：可选的原生 Codex 精确停止控制通道。未配置时仍会列出
  Codex Desktop Session，但显示 `停止: 不可用 (control_unreachable)`。
  最多登记四个 endpoint；仅接受 `%USERPROFILE%\.codex\app-server-control`
  下的本地 proxy socket，或带有本地 token 文件的显式 loopback `ws://`
  地址。不要把 Codex Desktop 进程或共享 app-server 作为停止目标。

示例（默认关闭原生 Codex 控制）：

```json
{
  "codexControl": {
    "endpoints": []
  }
}
```

`config/projects.json`：可选的工程别名和排除策略，不再是工程允许列表。Gateway 会从本机 Claude Code 与 Codex 的原生历史元数据中自动发现工程，并只信任经过验证的原始 `cwd`。消息里的任意路径不会自动成为工作目录。

示例：

```json
{
  "excludedRoots": ["D:\\private"],
  "projects": [
    {
      "alias": "unity_asset",
      "displayName": "unity_asset",
      "path": "D:\\WA\\unity_asset",
      "aliases": ["unity", "unity项目"]
    }
  ]
}
```

`projects` 中的条目只是该精确路径的本地可信别名覆盖；未列出的工程仍可通过原生 Session 历史发现和续接。`excludedRoots` 下的工程不会显示、导入、新建或续接。没有历史 Session 的全新目录仍需通过本地配置加入，不能从飞书消息直接提供路径。

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
- `Codex unity 资源泄漏排查，继续修复第一项`
- `Claude unity 资源泄漏，继续上次工作`
- `继续资源泄漏那个 Session，修复第一项`
- `列出最近的 Session`
- `取消资源泄漏那个 Session`
- `批准 RQ-260930-ABC123`
- `查询当前 PC 上所有正在工作的 Agent Session`
- `查看本机 Claude Code 和 Codex 项目、会话概况`
- `查看 client 项目的会话概况`
- `查看 Claude Code 的导入设置优化会话`
- `会话 fb0f2ece-ee8e-46fb-a7e4-84d1c662a62a 属于哪个项目`
- `停止 ST-0123456789ABCDEF0123456789ABCDEF`
- `查看 CC Switch 状态`
- `CC Switch 当前 Provider 和健康状态`
- `CC Switch 本地路由是否开启`
- `查询 CC Switch 今天 token 消耗`
- `CC Switch 最近 7 天用量`

所有任务消息都会包含 `执行器 | 项目 | Session Name | Session ID`。相同或父子目录工程严格串行，不相关工程最多并发两个。Codex 的项目内普通新增/修改可自动批准；删除、越界写和未知命令需要在飞书二次确认。

按 Session 名称发送工作时，网关会在 Gateway、所有本机 Codex Desktop 历史记录
和所有本机 Claude Code 历史记录中查找，不要求预先登记工程。名称支持大小写、
标点、词序、包含关系和有限拼写差异的确定性模糊匹配。一个明确且可安全恢复的
结果会继续原 Session；完整查询确认没有匹配结果后，才允许新建 Session。多个、
同名或低置信度结果会返回带工程信息的编号候选，必须直接回复该候选消息中的编号，
单独发送数字不会选择 Session。没有匹配且未指定工程时，会返回已发现工程的绑定
编号列表，不会默认到唯一配置或最近工程。

匹配结果正在被 Codex Desktop、Claude Code 或 Gateway 使用，原生 `cwd` 无法验证，
本地身份存在冲突，或者任一相关历史数据源查询不完整时，网关会停止本次操作，
不会创建同名替代 Session。不完整的任一相关元数据扫描也不会自动选择现有会话。
恢复原生 Codex 使用 `thread/resume`，恢复原生 Claude Code 使用 `--resume`；实际
恢复前会再次检查原生所有权、工程授权和占用状态。明确要求“新建”
可以跳过模糊复用，但不能绕过同一执行器/项目内的 Session 名称占用检查。

Gateway 管理的 Claude Worker 当前仍只启用 `Read/Edit/Write/Glob/Grep`，没有 Bash。
因此会话可以正确恢复，但 `git status`、`git diff` 等 shell 任务仍需后续单独开放受控
命令能力。

与项目无关的本机操作仅允许调用网关源代码中登记的内部技能。其中
`inspect_agent_workspace` 只读查询本机 Claude Code、Codex 与 Gateway 的项目和
Session 元数据，支持全部概况、单个项目和单个 Session，并可明确限制为 Claude
Code 或 Codex。结果包含项目归属、执行器、活动状态、恢复能力、最近活动时间和
会话 ID；名称不唯一或相关数据源不完整时只显示候选，不会按最近时间猜测。

该概况技能不会读取提示词、回复、摘要、工具输出或其他会话正文，也不会新建、
恢复、停止、重命名或删除 Session。项目查询只接受别名或目录名称，不接受消息
提供的路径作为文件系统访问权限。

另外登记了“查询正在工作的 Agent Session”和“精确停止 Agent Session”。活动
查询会只读汇总 Codex、Claude Code 与网关队列，并为通过完整所有权校验的结果
显示一个 `停止ID`。停止时必须单独发送完整的 `ST-` ID；名称、PID、Session
UUID、Gateway ID、模糊描述和“停止所有”均不会执行。

还登记了只读 `ccswitch` 内部技能，可查询概况、Provider、健康状态、本地
路由状态，以及今天、昨天、最近 7 天或最近 30 天的已观察用量。用量包含请求
数、成功率、按存储口径分开的输入 token、输出/cache token、估算费用与
app/Provider/model 汇总。CC Switch 没有管理 HTTP API 或 CLI，因此技能从固定的
`%USERPROFILE%\.cc-switch\cc-switch.db` 创建限时只读快照；它不接受消息提供的
路径、SQL、Provider ID、模型或端口。

该技能不会切换 Provider、启停路由、编辑配置、导入导出或显示凭据。由于 CC
Switch 3.20.1 没有公开的 retention/finalization 水位，结果明确标记为“仅已观察
数据”，不能作为请求期内完整性的证明。

`停止ID` 是一次查询生成的 128 位不透明引用，有效期十分钟。重复发送同一个
ID只会复用同一次停止操作，不会重复发送终止信号。Gateway 任务按查询时绑定的
完整任务集合取消；Claude Code 只终止匹配 PID 与创建 FILETIME 的进程；Codex
Desktop 只通过已验证 app-server owner 的 `turn/interrupt` 停止精确 turn，绝不
终止 Codex Desktop 或共享 app-server 进程。其他自由形式的本机命令不会执行。
