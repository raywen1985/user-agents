# Lark Agent Gateway

用户级飞书私聊网关：用自然语言创建或继续独立 Codex / Claude Session，并把最小摘要回发给本人。

## 配置

`config/gateway.json` 保存可复用基础配置，`config/gateway.local.json` 保存安装器在
当前机器上生成的覆盖配置。后者被 Git 忽略，不应复制到其他机器。

- `allowedOpenIds`：允许控制网关的飞书用户 `open_id` 列表。
- `recipientOpenId`：状态与结果接收人的 `open_id`。
- `routerModel` / `workerModel`：Claude 路由和执行模型。
- `executables`：基础配置只保留可移植的 Codex `auto`。安装器发现并验证
  Node、lark-cli、Claude、FFmpeg 和 SVN 后，把运行时需要的绝对路径写入
  `gateway.local.json`。Codex 也可通过安装参数指定本机路径；默认 `auto` 会在每次任务启动前
  优先发现 `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`，找不到可用
  桌面版本时回退到当前架构的默认用户级 npm 安装；自定义 npm prefix 请
  使用本机覆盖。候选文件必须通过相应的版本或能力预检。
- `codexControl`：可选的原生 Codex 精确停止控制通道。未配置时仍会列出
  Codex Desktop Session，但显示 `停止: 不可用 (control_unreachable)`。
  最多登记四个 endpoint；仅接受 `%USERPROFILE%\.codex\app-server-control`
  下的本地 proxy socket，或带有本地 token 文件的显式 loopback `ws://`
  地址。不要把 Codex Desktop 进程或共享 app-server 作为停止目标。
- `voice`：语音消息转文字设置。语音识别接口只支持 `16k_auto` 引擎，因此
  `engineType` 固定为 `16k_auto`；`maxDurationMs` 和 `maxBytes` 限制单条语音；
  `echoTranscript` 控制是否先把识别结果回发确认；`enabled=false` 时忽略语音消息。
  语音链路需要安装器发现 FFmpeg，并需要应用具备
  `speech_to_text:speech` 权限。

示例（默认关闭原生 Codex 控制）：

```json
{
  "codexControl": {
    "endpoints": []
  }
}
```

`config/projects.json` 保存可移植的空策略；本机工程别名和排除策略写入被忽略的
`config/projects.local.json`。Gateway 会从本机 Claude Code 与 Codex 的原生历史元数据中自动发现工程，并只信任经过验证的原始 `cwd`。消息里的任意路径不会自动成为工作目录。

示例：

```json
{
  "excludedRoots": ["<absolute-local-excluded-root>"],
  "projects": [
    {
      "alias": "unity_asset",
      "displayName": "unity_asset",
      "path": "<absolute-local-project-path>",
      "aliases": ["unity", "unity项目"]
    }
  ]
}
```

`projects` 中的条目只是该精确路径的本地可信别名覆盖；未列出的工程仍可通过原生 Session 历史发现和续接。`excludedRoots` 下的工程不会显示、导入、新建或续接。没有历史 Session 的全新目录仍需通过本地配置加入，不能从飞书消息直接提供路径。

## 安装与运行

需同时安装仓库中的 `skills/session-mgr/`，保持它与 `claude-projects/lark/` 的相对位置。
项目/会话概况、活动会话与原生历史读取由 SessionMgr 提供；Gateway 保留兼容入口。
安装器会在修改配置前检查共享模块，换机时必须一起复制完整技能目录。无需新增本机路径配置。

先用只读发现检查依赖；全部通过后执行安装：

```powershell
./scripts/install-task.ps1 -DiscoveryOnly
./scripts/install-task.ps1
```

发现不到程序时通过 `-NodePath`、`-LarkCliPath`、`-ClaudePath`、`-FfmpegPath`
或 `-SvnPath` 指定当前机器上的 `.exe`。显式路径同样要通过常规文件、重解析点、
版本和能力校验。安装器生成本机配置、更新 `.claude/settings.local.json`，然后注册并
验证计划任务；任何失败都会恢复安装前文件和任务。已有 Gateway 正在运行时安装会拒绝，
需先执行 `./scripts/stop.ps1`。

计划任务 `LarkClaudeGateway` 会在用户登录时启动。手工前台启动、停止和查看状态：

```powershell
./scripts/start.ps1
./scripts/stop.ps1
./scripts/restart.ps1
npm run status
```

日志优先位于 `%LOCALAPPDATA%\lark-claude\gateway.log`；目录不可写时回退到项目的 `logs/gateway.log`。运行状态位于 `run/health.json`。
`restart.ps1` 使用 `run/restart-request.json` 与运行中的 Gateway 做原子交接：有运行、
待审批或排队任务时会拒绝本次重启并保持服务；空闲时才退出旧进程并启动计划任务。

## 使用

在飞书中私聊机器人“温光辉的飞书 CLI”。项目任务优先使用固定格式，Session 名不能
包含空格：

```text
<claude|codex> <session-name> <任务内容>
<claude|codex> <新建|new> <session-name> <任务内容>
```

例如：

- `codex 飞书通知 方案A`
- `claude 导入设置优化 检查是否需要提交`
- `codex new 飞书通知-2 并行实现方案B`
- `claude 新建 导入设置优化-2 从头检查导入流程`

第一个词选择执行器，第二个词是完整 Session 名，后面的全部文本才是任务内容。
`codex 飞书通知 方案A` 因而只查找 `飞书通知`，不会把 `方案A` 拼进 Session 名。
标准格式由 Gateway 直接解析，不交给 LLM 猜字段边界。

其他管理和查询功能仍可使用自然语言，例如：

- `列出最近的 Session`
- `取消资源泄漏那个 Session`
- `批准 RQ-260930-ABC123`
- `查询当前 PC 上所有正在工作的 Agent Session`
- `查看本机 Claude Code 和 Codex 项目、会话概况`
- `列出所有claudecode会话`（全部项目，逐条自动分批发完）
- `列出所有 Codex 会话`
- `查看 client 项目的会话概况`
- `查看 Claude Code 的导入设置优化会话`
- `会话 fb0f2ece-ee8e-46fb-a7e4-84d1c662a62a 属于哪个项目`
- `停止 ST-0123456789ABCDEF0123456789ABCDEF`
- `查看 CC Switch 状态`
- `CC Switch 当前 Provider 和健康状态`
- `CC Switch 本地路由是否开启`
- `查询 CC Switch 今天 token 消耗`
- `CC Switch 最近 7 天用量`

成功入队后，Gateway 会在同一飞书聊天和同一发送者范围内记住该 Session 30 分钟。
这段时间内可直接发送“继续检查测试”等短指令；使用飞书的回复功能回复某个 Session
消息时，回复绑定优先于短时上下文。审批、停止 Session、CC Switch 和概况查询不会
被短时上下文误当成项目任务。固定格式命令若与所回复的 Session 名称或执行器冲突，
会明确拒绝，不会静默选择其中一个。

### 回复会话通知

启用新版通知 Hook 和 Gateway 后，可使用飞书的“回复”功能回复 Codex / Claude 的
结束或中断通知，直接输入“继续检查”或“按方案 A 执行”，无需再写执行器和会话名。
卡片通知及发送失败后降级的文字通知均支持。网关按通知保存的原生 Session ID 续接，
因此会话改名、名称含空格或与其他会话同名，都不会影响目标定位。回复通知中的数字
（例如 `1`）是该会话的任务内容，不会选中其他候选列表。

仅支持升级后成功保存绑定的新通知。旧通知、绑定丢失或会话无法验证时会明确提示，
不会自动改投最近会话或创建替代会话；请取消回复，改发 `codex/claude 会话名 任务内容`。
回复通知也不能批准原生客户端的权限弹窗；Gateway 的 `RQ-...` 审批仍按原有规则处理。

原生会话必须可续接：已归档的 Codex 会话需先在本机取消归档；原生历史丢失时不能仅凭
Gateway 记录续接。所有 Codex 候选都会检查写锁，空闲但被 Desktop 加载的会话也会显示占用。
Codex 正在执行任务时需等待结束；Claude Code 进程即使空闲，
若仍持有该 Session，也需先退出该会话再回复。网关不会向另一个正在占用会话的客户端
直接注入消息。

绑定保存在 `~/.agents/claude-projects/lark/data/notification-bindings/`，只记录消息 ID、
原生 Session ID、执行器、接收人、可用的聊天 ID 和时间；新版还保存从原生日志核验的工程路径、
显示别名及证据来源，不记录通知正文或 Token。回复时重新核验原生 ID、唯一日志来源与原始 cwd；
后续切换工作目录不再被当成多个会话归属。真正存在多份原生日志、绑定工程不符或身份冲突时仍拒绝。
Gateway 重启后仍可使用；该目录属于本机运行数据，已被 Git 忽略，换机时不复制。
绑定有效期 30 天，启动及每小时清理，最多保留最新 5000 条。过期或被轮转后的通知请改用会话名发命令。

### 语音与执行规则

也可以直接发送语音消息：网关先通过 lark-cli 下载语音，用 ffmpeg 转成 16k PCM，
再调用飞书语音识别接口，最后把识别出的文字当作普通指令路由；默认会先回发识别
结果，识别失败时会提示改用文字。
图片、文件、视频等不支持的消息会写入 inbox 并明确提示，不再静默丢弃。
启动时使用机器人身份查询 `/open-apis/application/v6/scopes`，并将权限状态写入
`run/health.json` 的 `voice.permission`；识别结果另记为 `voice.recognition`，权限已授予不等于服务已可用。
`auth scopes` 在当前 CLI 返回用户权限，不能用来断定机器人缺少语音权限。语音接口官方文档注明
免费版不支持；持续 `99991400` 应核查租户套餐与服务配额。确认缺权限时不会再下载音频或重试识别。

所有任务消息都会包含 `执行器 | 项目 | Session Name | Session ID`。相同或父子目录工程严格串行，不相关工程最多并发两个。Codex 的项目内普通新增/修改可自动批准；非 PowerShell 的删除、越界写和未知命令仍需要在飞书二次确认。

按用户此前明确选择，继续保留 `config/gateway.json` 的 `powershellApprovalMode=always_allow`：只要 Codex
审批请求的外层程序是启动时校验过的系统 `powershell.exe` 或 `pwsh.exe`，Gateway
就会先写入持久审计记录，然后直接批准，不再发送 RQ。内层脚本不受路径、网络、
注册表、凭据或破坏性操作限制，这等同于允许已授权飞书账号远程执行任意 PowerShell。
审计记录位于 `%LOCALAPPDATA%\lark-claude\powershell-approval-audit.jsonl`，不记录命令
正文。把配置改回 `review` 并执行 `./scripts/restart.ps1` 即可恢复逐项审查。

Claude 任务执行已启用 `claudeExecutionMode=full_access`：提供默认内置工具（包括终端），
采用 `bypassPermissions`，加载用户、项目和本地设置，以及已配置的 MCP 和技能。
选择的工程是会话的初始工作目录，不再限制任务只能读写该目录；可按用户指令访问其他工程、
启动已安装的软件。项目 `.mcp.json` 中的服务器会自动启用，真实的系统权限、显式工具禁用、
管理员策略和服务可用性仍然生效。队列仍按会话归属工程调度，跨工程操作需避免与另一任务冲突。

旧 Session 在下一次续接时会刷新系统提示并获得相同能力，无需重建。例如可发送
`claude unityhub 继续打开 Unity 项目并检查 MCP`。权限变更本身不会重放之前失败的任务，
也不会自动安装或启动 Unity/MCP 服务。消息分类器仍使用无工具的受限模式。

配置加载时缺省为 `restricted`（仅文件工具）。需要回退时，在 `config/gateway.local.json`
设置 `"claudeExecutionMode": "restricted"`，保留其他配置并运行 `./scripts/restart.ps1`。
此重启会等待网关空闲；在 `run/health.json` 查看实际加载的 `claudeExecutionMode` 和
`listenerReady`，只有重启成功后新配置才生效。完整模式要求支持 `--system-prompt-snapshot`
的 Claude Code 版本，本机已验证 2.1.312；迁移时先检查 `claude --help`。

按 Session 名称发送工作时，网关会在 Gateway、所有本机 Codex Desktop 历史记录
和所有本机 Claude Code 历史记录中查找，不要求预先登记工程。唯一精确且空闲的结果
会直接续接；模糊相似结果永远不会自动执行。没有精确结果时，Gateway 会显示相似
Session 和“在新 Session 中执行”；完全没有相似项时也会先要求确认新建，不会直接
创建。多个精确同名结果只显示精确项，不提供隐式新建。

候选选择与工程选择是两个独立步骤。请优先使用飞书的“回复”功能回复列表中的编号；
若当前聊天只有一个有效候选列表，也可单独发送编号。新请求会替代同一聊天中的旧同类
列表。候选超过 10 项时发送 `下一页` 或 `上一页`，回复旧页面仍按旧页面的编号快照
解释。候选 30 分钟无活动后过期。

显式 `new/新建` 只创建新 Session，不续接所回复的 Session，但可沿用回复 Session
已经验证的工程。同一执行器下 Session 名全局唯一；已存在精确同名 Session 时必须换名，
例如使用 `飞书通知-2`。新建时无法从显式工程、回复 Session 或短时上下文确定工程，
才会显示单独的工程编号列表，不会默认到唯一配置或最近扫描工程。

匹配结果正在被 Codex Desktop、Claude Code 或 Gateway 使用，原生 `cwd` 无法验证，
本地身份存在冲突，或者任一相关历史数据源查询不完整时，网关会停止本次操作，
不会创建同名替代 Session。不完整的任一相关元数据扫描也不会自动选择现有会话。
恢复原生 Codex 使用 `thread/resume`，恢复原生 Claude Code 使用 `--resume`；实际
恢复前会再次检查原生所有权、工程授权和占用状态。打开或关闭 Codex Desktop 本身
不等于 Session 忙碌；只有实际 Codex turn/writer lock、Claude live owner 或 Gateway
活动任务会阻止并发续接。显式新建可以跳过模糊复用，但不能绕过精确同名占用。

### 远程操控速查

| 目的 | 发送内容 |
| --- | --- |
| 查找并继续 | `codex 会话名 任务内容` 或 `claude 会话名 任务内容` |
| 下班检查（只读） | `下班检查` 或 `SessionMgr 下班检查` |
| 下班关闭客户端 | `下班` 或 `SessionMgr 下班`，会停止正在执行的 Agent 工作 |
| 强制新建 | `codex new 新名称 任务内容` 或 `claude 新建 新名称 任务内容` |
| 继续刚才会话 | 30 分钟内直接发送任务内容，或回复该 Session 消息 |
| 回复结束/中断通知 | 使用飞书“回复”回复升级后的通知，直接输入任务内容 |
| 选择候选 | 回复候选消息中的 `1` 到 `10`；只有一个有效列表时可独立发编号 |
| 翻页 | 回复候选消息发送 `下一页` 或 `上一页` |
| 批准请求 | `批准 RQ-...` |
| 查询活动 Session | `查询当前 PC 上所有正在工作的 Agent Session` |
| 精确停止 | 先查询，再单独发送完整 `停止 ST-...` |

`下班` 由 SessionMgr 执行，范围是当前 Windows 用户已识别的 Claude Code/Claude Desktop、
Codex CLI/Desktop、OpenCode CLI/Desktop，包含空闲但持有 Session 的客户端。
它会中断正在执行的 Agent 工作，取消网关原有排队任务，先正常关闭桌面窗口，再终止剩余精确进程。
保留已保存文件、会话记录、网关和飞书监听；未保存输入可能丢失。

命令必须单独以纯文字发送，不加 `codex` 或 `claude` 前缀；语音、富文本、引用示例和任务正文
不会触发全局关闭。执行期间的新任务需在完成后重发。同一条消息重复投递不会再次关停新客户端。
结果会报告保留项、身份不明项和残留占用；普通终端窗口可能留在提示符处，不整窗关闭共享终端。
预览里的数量是进程数，不是 Session 数。OpenCode 历史查询/续接不在此功能范围内。
详见 [SessionMgr 下班说明](../../skills/session-mgr/references/off-work.md)。

### 简短故障排查

新建 Session 的工程候选按完整路径升序排列，忽略大小写、按自然数字顺序比较；排序后再分页和绑定编号。

- **没有找到同名 Session**：确认第二个词就是无空格 Session 名；从相似列表选择，
  或选择“在新 Session 中执行”。
- **Session 正在使用中**：原生客户端即使空闲也可能持有写锁。退出持有会话的客户端，
  或先发 `下班检查` 查看，再用 `下班` 统一关闭；网关自身任务可等待执行结束后再发。
- **已归档/原生历史不存在**：先取消原生会话归档，或明确选择其他会话/新建；网关会在入队前拦截。
- **编号没有生效**：使用飞书的回复功能回复目标候选消息；若列表已过期或被新请求替代，
  重新发送原命令。
- **无法关联所回复消息的 Session**：旧通知、本机绑定丢失、超过 30 天或已轮转；取消回复后发送完整会话命令，
  后续使用新版通知回复。回复 Claude 通知提示占用时，需先退出持有该会话的 Claude Code。
- **任务已入队但暂未开始**：同一工程及其父子目录会串行；Gateway 会从持久化队列自动
  对账，重启或停止栅栏释放后继续投影。
- **语音识别失败**：检查 `ffmpeg`、机器人 `speech_to_text:speech` 权限和语音时长/大小限制。
  权限已授予但持续限流时，检查租户套餐/配额，不能反复申请用户权限来解决。
- **查询不完整/工程无法验证**：不要在消息中提供任意路径；修复本机原生历史数据访问或
  在 `config/projects.json` 中添加精确可信路径别名后重试。

会话快照瞬时不完整时只读重试一次，失败不会创建替代会话。Lookup/通知回复的失败日志记录
`messageId`、`executor` 和实际 `reason`，不记录任务正文；outbox 去重键也包含实际原因。
测试日志自动写入临时目录并传递给子进程，不再污染生产日志；需要固定测试日志位置时可设置
`LARK_GATEWAY_LOG_DIR`，不要指向生产日志目录。

Gateway 管理的 Claude Worker 当前仍只启用 `Read/Edit/Write/Glob/Grep`，没有 Bash。
因此会话可以正确恢复，但 `git status`、`git diff` 等 shell 任务仍需后续单独开放受控
命令能力。

与项目无关的本机操作仅允许调用网关源代码中登记的内部技能。其中
`list_agent_sessions` 通过 SessionMgr 的原生列表接口列出全部本机项目的历史会话，
显示序号、名称、完整 ID、所有记录的项目路径、最近活动时间和进程占用状态。
按最近活动倒序自动分批发完，每批最多 25 条且受消息字节上限限制，序号仅供阅读；不受 Gateway 最近会话数限制。
发送中断后继续投递已保存的批次。没有原生标题时使用摘要/首条输入作为代名并标注，
不发送完整会话正文；“进程占用”包括空闲但已加载，不等于正在工作或可以续接。

`inspect_agent_workspace` 只读查询本机 Claude Code、Codex 与 Gateway 的项目和
Session 元数据，支持全部概况、单个项目和单个 Session，并可明确限制为 Claude
Code 或 Codex。结果包含项目归属、执行器、活动状态、恢复能力、最近活动时间和
会话 ID；名称不唯一或相关数据源不完整时只显示候选，不会按最近时间猜测。

`inspect_agent_workspace`、`list_active_agent_sessions` 保留现有飞书指令名，底层实现
已移至 [SessionMgr](../../skills/session-mgr/SKILL.md)。Claude 的历史扫描与技能本地查询
共用 `claude-reader.mjs`；概况与续接查找采用元数据模式，不返回提示词、回复、摘要或工具输出，
也不以这些内容生成会话名。缺少标题的会话仍可按 ID 查询。

概况中的项目路径记录和续接校验分开展示；路径已知但没有通过续接校验时，仍显示
记录的项目路径。同一会话涉及多个项目路径时计入各项目并标注计数可能重叠，
不能将“不可安全续接”解释为“项目未知”。每个项目行均包含路径，便于区分同名工程。

该概况查询不会新建、
恢复、停止、重命名或删除 Session。项目查询只接受别名或目录名称，不接受消息
提供的路径作为文件系统访问权限。

另外登记了“查询正在工作的 Agent Session”和“精确停止 Agent Session”。活动
查询会只读汇总 Codex、Claude Code 与网关队列，并为通过完整所有权校验的结果
显示一个 `停止ID`。停止时必须单独发送完整的 `ST-` ID；名称、PID、Session
UUID、Gateway ID、模糊描述和“停止所有”均不会执行。

仅有索引/运行时记录而没有可信原生日志的会话可被发现，但不会据此续接。Claude
空闲进程可能仍持有 Session；“没有正在工作”不表示该 Session 已释放。扫描超时或
不完整时明确提示，执行前仍重新校验原生身份、项目及占用状态。

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
