# Claude Code 与 Codex 飞书通知可靠性设计

## 背景与根因

现有通知系统同时服务 Claude Code 与 Codex。Claude Code 通过 `~/.claude/settings.json` 的 `Stop`、`StopFailure` 和 `Notification` Hook 调用公共飞书脚本；Codex 原先通过 `~/.codex/hooks.json` 的 `Stop` Hook 调用同一脚本。

Windows 重启并启动新版 Codex Desktop 后，用户级 `~/.codex/config.toml` 中的 `notify` 被配置为 Codex 自带的 `codex-computer-use.exe turn-ended`。实际日志显示飞书脚本最后一次被 Codex 调用停在 2026-10-15 09:02，之后没有成功、失败或跳过记录；飞书机器人身份仍为 `bot`，状态为 `available=true`、`tokenStatus=ready`。Claude Code 配置也曾在重启后丢失，说明两个客户端都必须纳入持续自检，而不是只修复 Codex。

OpenAI 官方文档说明，用户级 `notify` 会在 `agent-turn-complete` 时调用一个外部程序，并将事件作为单个 JSON 参数传入。当前配置只能指定一个命令，因此飞书通知需要与 Codex 自带通知共享这一入口。

## 目标

- Claude Code 正常完成、失败或等待用户输入时，按现有规则可靠发送飞书卡片。
- Codex 正常 Turn 完成后可靠发送飞书卡片。
- 保留 Codex 自带的 `turn-ended` 通知行为。
- 保留 `hooks.json` 作为支持本地 Hook 的客户端或会话的兼容入口。
- 两条入口同时触发时只发送一条飞书消息。
- Windows 登录后自动检查并恢复配置，避免重启后再次失效。
- Claude Code 与 Codex 使用同一套卡片构造、发送、日志脱敏和幂等基础设施。
- 安装、登录自检和测试都不主动发送飞书消息。

## 方案

Claude Code 继续使用其官方生命周期 Hook，不增加旁路监听器：

- `Stop`：会话正常结束。
- `StopFailure`：会话失败结束。
- `Notification`：只匹配 `permission_prompt|idle_prompt|agent_needs_input`。

`Initialize-LarkNotify.ps1` 按现有安全合并规则持续确保这三个 Hook 存在、参数正确且各只有一个发送路径。若 Claude Code 启动、升级或其他工具覆盖 `settings.json`，周期 bootstrap 会恢复缺失 Hook；未知 Hook、permissions、plugins、env 与其他配置保持不变。

新增 `hooks/Invoke-CodexNotifyBridge.ps1`，作为 `config.toml` 的唯一 `notify` 命令。它接收 Codex 追加的单个 `agent-turn-complete` JSON 参数，并执行两个彼此隔离的输出分支：

1. 调用 Codex 自带的 `codex-computer-use.exe turn-ended <payload>`，保留原生行为。
2. 将 `notify` 负载规范化为现有 `lark-notify.ps1` 可处理的 Codex `Stop` 负载，再通过标准输入调用该脚本。

桥接器不承担卡片构造、飞书 API 调用或业务过滤；这些继续由 `lark-notify.ps1` 统一负责。桥接器只负责协议转换和扇出，以减少重复逻辑。

## 配置所有权

`Initialize-LarkNotify.ps1` 扩展为同时管理以下配置：

- `~/.claude/settings.json`：维持现有 Claude Code Hook。
- `~/.codex/hooks.json`：维持现有 Codex `Stop` Hook，作为兼容后备。
- `~/.codex/config.toml`：幂等确保顶层 `notify` 指向桥接器。
- `%LOCALAPPDATA%/lark-notify/codex-native-notify.json`：保存桥接前的 Codex 原生通知命令数组。

若 `config.toml` 的 `notify` 已指向桥接器，则不重写文件。若它指向 Codex 自带的 `codex-computer-use.exe turn-ended`，引导脚本先安全保存该数组，再改为桥接器。若它是未知的用户自定义命令，引导脚本不得静默覆盖，而应报告冲突并失败，避免破坏用户配置。

原生命令文件只保存可执行文件与固定参数，不保存事件正文、令牌或会话内容。可信原生根目录固定为 `%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node`；候选必须是其规范化子路径 `*\bin\node_modules\@oai\sky\bin\windows\codex-computer-use.exe`，固定参数必须是 `turn-ended`。引导脚本每次检查都枚举候选，以所属 `cua_node\<hash>` 目录的 `LastWriteTimeUtc`、再以规范化路径作稳定排序，选择最新候选并更新原生命令文件，因此旧运行时仍存在也不会阻止刷新。若 `config.toml` 当前包含新的官方原生命令，则它优先于枚举结果。

原生命令状态文件必须先通过同目录临时文件、复解析、哈希复检和原子替换成功落盘，之后才能把 `config.toml` 切换到桥接器，避免配置已切换但桥接器没有可用原生目标。

### TOML 无损更新

PowerShell 没有内置 TOML 写入 API，因此这里只实现受限的顶层 `notify` 无损补丁，不对整个文件反序列化后重写：

1. 按原始编码和换行读取文件，识别注释、单引号、双引号、数组括号和首个表头，只查找顶层 `notify` 赋值。
2. 仅接受缺失、已知官方原生命令或本功能桥接命令三种状态；重复键、无法闭合的多行值、非字符串数组和未知命令都拒绝修改。
3. 缺失时在首个表头前插入单行赋值；已知值只替换该赋值的精确字节范围，其他注释、空行、键顺序、未知表和文件尾保持不变。
4. 候选文件写入同目录临时文件，并以当前 Codex CLI 的官方 TOML 解析器加载临时 `CODEX_HOME` 后运行 `codex doctor --json` 验证；同时断言移除目标赋值后其余字节与原文件相同。
5. 替换前复检目标哈希；并发变化时基于新内容重做，最多 3 次。临时文件和固定单份备份继承目标 owner/DACL，使用原子替换，失败时原文件保持不变。
6. 崩溃残留处理沿用现有 bootstrap 规则：正式目标可解析时删除残留；目标损坏时保留目标、备份和临时文件并失败，禁止猜测恢复版本。

上述安全写入契约同时用于原生命令状态 JSON；状态 JSON 成功落盘后才允许更新 TOML。

## 负载转换

官方 `notify` 字段按以下规则转换：

| `notify` 字段 | Hook 字段 |
|---|---|
| `type=agent-turn-complete` | `hook_event_name=Stop` |
| `thread-id` | `session_id` |
| `turn-id` | `turn_id` |
| `cwd` | `cwd` |
| `last-assistant-message` | `last_assistant_message` |
| `input-messages` | 仅保留在桥接器内部，不写日志 |

桥接器通过 `session_id` 查询 `~/.codex/session_index.jsonl` 和会话目录，补充 `transcript_path`。为容忍索引落盘竞态，按 100、200、400、800、1500 毫秒做有界重试。只有 session index 命中，或 transcript 位于受信 `~/.codex/sessions` 根目录且文件名包含相同非空 session id，才允许进入发送路径；只有 `agent-turn-complete` 而没有正式会话证据时跳过并记录原因，避免内部或临时 Turn 误报。

负载新增独立元数据 `lark_ingress=codex-notify`。Hook 入口使用 `lark_ingress=codex-hook`；过滤与诊断日志读取 ingress，但业务来源始终规范化为 `codex`，不改变现有 `Source` 参数约束。

## 去重

两条入口可能在同一 Turn 同时到达。继续使用 `lark-notify.ps1` 的幂等键，主键优先包含：

1. source=`codex`
2. session/thread id
3. turn id
4. event=`Stop`

因此 `hooks.json` 和 `notify` 对同一 Turn 生成相同的卡片幂等键。`lark_ingress` 不参与幂等键。飞书 API 的幂等请求键负责最终去重；本地日志明确记录来自 `codex-hook` 或 `codex-notify` 的入口，便于排障。

## 错误隔离

- 负载不是合法 JSON或 `type` 不是 `agent-turn-complete`：记录脱敏错误并退出 0，不影响 Codex。
- 原生与飞书分支并发启动，互不等待；原生分支硬超时 10 秒，飞书分支硬超时 30 秒。
- 任一分支超时后终止其完整进程树并记录错误，不影响另一分支继续。
- 原生通知命令失败：记录错误，但不取消飞书分支。
- 飞书分支失败：记录错误，但不取消原生分支。
- 两个分支都失败：桥接器仍退出 0，避免通知附属功能阻断 Codex Turn；失败详情写入 `%LOCALAPPDATA%/lark-notify/notify.log`。
- 未知用户 `notify` 冲突：引导脚本拒绝覆盖并返回非零。
- `config.toml` 无法解析或并发变化：不覆盖，按现有安全替换策略重试或失败。

日志不记录完整 JSON、用户输入、助手正文、token、App Secret 或收件人 ID。

## 登录自恢复

现有 `LarkNotifyBootstrap` 计划任务继续在当前用户登录时运行 `Initialize-LarkNotify.ps1`。登录后会同时修复 Claude Code 的三个 Hook、Codex Hook 与 Codex `notify` 桥接配置。

为消除“任务先运行、客户端后启动并覆盖配置”的竞态，同一任务使用两个触发器：用户登录时立即检查，以及每天开始后每 10 分钟重复一次的轻量自检。每次脚本通常只读并在配置健康时立即退出，不常驻。若 Claude Code 删除 Hook，或 Codex 把 `notify` 改回原生命令，最迟 10 分钟内会自动恢复。登录触发仍保留失败重试。

计划任务不发送测试消息。配置正确时不重写任何文件；只有缺失、被 Codex 更新覆盖或原生运行时路径发生变化时才修复。任务仍以普通用户、隐藏窗口运行。配置更改对新 Turn 是否热加载由 Codex 客户端决定；bootstrap 在日志中记录“已修复，当前已运行会话若未热加载则下次启动生效”，但不自动终止或重启 Codex。

### 无闪窗启动

任务计划程序不再直接启动控制台子系统的 `powershell.exe`。即使使用 `-WindowStyle Hidden`，Windows 仍可能在隐藏窗口前短暂创建控制台，导致每 10 分钟闪现一次命令窗口。

新增 `Run-LarkNotifyBootstrap.vbs` 作为无控制台启动器。计划任务通过系统目录下的绝对 `wscript.exe` 路径及 `//B //Nologo "<launcher>"` 参数调用该启动器。启动器从自身目录解析初始化脚本，使用 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`，以窗口样式 `0` 同步执行 `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "<initializer>"`，并通过 `WScript.Quit` 透传 PowerShell 退出码。所有可执行文件与脚本路径均按 Windows 命令行规则加双引号，不依赖当前工作目录或 `PATH`。这样保留现有登录触发、每 10 分钟自检、任务最近结果和失败重试语义，同时避免创建可见控制台窗口；启动器自身无法创建进程时也必须返回非零退出码。

## 测试

新增桥接器测试并扩展 bootstrap 测试，全部使用临时目录、伪造原生程序和 `-DryRun`/测试注入，不访问飞书网络：

- 官方 `agent-turn-complete` JSON 能转换为现有 `Stop` 字段。
- thread id、turn id、cwd、摘要和 transcript 查找正确。
- Hook 与 notify 对同一 Turn 生成相同幂等键。
- 非目标事件、空参数、损坏 JSON 不调用任一发送分支。
- 原生分支失败或永久阻塞时仍调用飞书分支；飞书分支失败或永久阻塞时不影响原生分支，超时后完整进程树被终止。
- 新旧原生运行时同时存在时选中可信根目录下更新时间最新的候选；未知根目录和同名伪程序被拒绝。
- `config.toml` 无 `notify`、原生 `notify`、已桥接 `notify` 和未知自定义 `notify` 四种情况分别按设计处理。
- TOML 的注释、未知表、键顺序、编码与换行保持不变；并发改写、候选解析失败、替换失败和崩溃残留路径均不丢失原配置。
- 连续运行 bootstrap 不改字节和文件时间。
- `-CheckOnly` 报告状态但不写文件。
- bootstrap 成功后配置被 Codex 再次覆盖时，周期触发能重新捕获并恢复；日志不包含负载正文或敏感信息。
- 未持久化内部 Turn 被跳过；索引延迟但在有界重试中出现时正常发送。
- Claude Code 三类 Hook 缺失、参数漂移、重复和被启动后再次删除时，bootstrap 能恢复为一个发送路径；未知配置保持不变。
- Claude Code `Stop`、`StopFailure`、三种允许的 `Notification` 和其他被过滤的 `Notification` 使用隔离负载验证，且不访问飞书网络。
- 计划任务动作使用系统绝对路径的 `wscript.exe //B //Nologo` 调用固定的 VBS 启动器，不直接启动控制台程序；启动器保留 PowerShell 的非交互与执行策略参数，以隐藏窗口执行并透传退出码。测试覆盖含空格路径、PowerShell 返回 0、返回非零和进程启动失败。

## 验收

1. 运行全部通知脚本与 bootstrap 自动化测试。
2. 运行 `Initialize-LarkNotify.ps1`，确认 `Healthy=true`，Claude Code 三类 Hook 完整，Codex `notify` 指向桥接器，原生命令已保存。
3. 再次使用 `-CheckOnly`，确认不需要变更。
4. 查询 `LarkNotifyBootstrap`，确认任务启用、状态正常、最近结果为 0。
5. 不手工发送测试卡片；由下一次正常结束的 Codex 或 Claude Code Turn 验证真实通知。
