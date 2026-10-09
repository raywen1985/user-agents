# Windows Claude Code 与 Codex CLI 逐轮 Token 统计设计

日期：2026-10-09

## 目标

在 Windows 上为 Claude Code 和 Codex CLI 提供统一的逐轮 Token 统计，同时满足：

- Claude Code 通过第三方中转、OpenAI 兼容接口或 ccswitch 登录。
- Codex CLI 通过 OpenAI API Key 登录。
- 支持逐轮打印、状态栏和历史查询。
- 明确区分 API 返回的真实用量、基于真实累计值推导的用量和文本估算值。
- 用户目录下的 `.agents`、`.claude`、`.codex` 可以复制到其他 PC 和其他用户目录后继续使用。
- 不读取、复制或记录 API Key，不代理模型请求。

当前验证基线为 Claude Code `2.1.252` 和 Codex CLI `0.153.4`。

## 方案选择

采用本地会话记录和生命周期 hook 采集方案：

- Claude 使用原生 `statusLine` 和每轮触发的 `Stop` hook。
- Codex 使用原生 `tui.status_line` 和每轮触发的 `Stop` hook；hook 在完成边界读取 session JSONL。
- 两端写入统一 JSONL 历史格式。

不采用 OpenTelemetry 作为主路径，因为它需要额外 Collector，且不能单独解决本地状态栏和历史查询。不采用本地 API 代理，因为它会与中转、ccswitch、流式响应及密钥管理产生耦合。

## 文件布局与可移植性

共享、可复制代码放在：

```text
~/.agents/token-meter/
├─ Install-TokenMeter.ps1
├─ Uninstall-TokenMeter.ps1
├─ Test-TokenMeter.ps1
├─ TokenMeter.psm1
├─ ClaudeStatusLine.ps1
├─ ClaudeTurnHook.ps1
├─ CodexTurnHook.ps1
├─ Repair-TokenHistory.ps1
├─ Show-TokenHistory.ps1
├─ Invoke-ClaudeStatusLine.cmd
├─ Invoke-ClaudeTurnHook.cmd
├─ Invoke-CodexTurnHook.cmd
└─ fixtures/
```

每台机器、每个用户的运行数据放在：

```text
~/.agents/.token-meter-data/<computer>/<user>/
├─ history.jsonl
├─ latest/
│  ├─ claude/<session-hash>.json
│  └─ codex/<session-hash>.json
├─ staging/<record-id>.json
├─ collector-state.json
├─ install-manifest.json
└─ errors.log
```

`.agents/.gitignore` 增加：

```gitignore
# Per-machine token usage data
/.token-meter-data/
```

脚本只能通过 `$HOME`、`[Environment]::GetFolderPath('UserProfile')`、`$env:COMPUTERNAME`、`$env:USERNAME` 和 `Join-Path` 构造路径，不保存安装机器的绝对用户目录。计算机名和用户名在作为目录名之前必须清理 Windows 非法文件名字符。

不能把 `~` 直接传给 `powershell.exe -File`，因为 Windows PowerShell 不会在该位置展开它。配置统一调用仓库内的 `.cmd` 入口；`.cmd` 使用 `%USERPROFILE%` 解析脚本位置并对含空格路径加引号。例如：

```json
{
  "statusLine": {
    "type": "command",
    "command": "cmd.exe /d /c \"\"%USERPROFILE%\\.agents\\token-meter\\Invoke-ClaudeStatusLine.cmd\"\""
  }
}
```

入口文件内部使用：

```bat
@powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\.agents\token-meter\ClaudeStatusLine.ps1"
```

安装测试必须覆盖用户名和用户目录含空格的情况。这样无论 Claude Code 经 Git Bash 还是 PowerShell 启动状态栏，复制到其他用户目录后都不依赖原用户名，也不依赖 shell 对 `~` 的处理。

## 统一数据模型

历史记录按行写入 UTF-8 JSONL。记录同时保留来源原始值和可比较的规范化值，不把不同 API 的同名字段直接相加。每条逐轮记录至少包含：

```json
{
  "schema_version": 1,
  "timestamp": "2026-10-09T15:30:12+08:00",
  "cli": "codex",
  "computer": "WORKSTATION-01",
  "user": "alice",
  "session_id": "...",
  "turn_id": "...",
  "model": "gpt-5.6-sol",
  "quality": "DERIVED_REPORTED",
  "source": "codex.token_usage_record.turn_token_usage",
  "source_usage": {
    "input_tokens": 31465,
    "cached_input_tokens": 4224,
    "cache_write_input_tokens": 0,
    "output_tokens": 157,
    "reasoning_output_tokens": 23,
    "total_tokens": 31622
  },
  "normalized_usage": {
    "fresh_input_tokens": 27241,
    "cache_read_tokens": 4224,
    "cache_write_tokens": 0,
    "effective_input_tokens": 31465,
    "visible_output_tokens": 134,
    "reasoning_output_tokens": 23,
    "generated_output_tokens": 157
  },
  "semantics": {
    "source_input_includes_cache": true,
    "source_output_includes_reasoning": true
  }
}
```

可信度枚举：

- `PROVIDER_REPORTED`：单次 API 响应或 CLI 会话事件直接保存的 provider-reported usage。中转可能改变这些值，因此“真实”仅表示不是本地文本估算。
- `DERIVED_REPORTED`：对 provider-reported 字段求差、去重或汇总形成的逐轮数据。
- `ESTIMATED_VISIBLE_TEXT`：只能根据会话文件中的可见文本估算；数字显示 `~` 前缀，并携带 `estimate_scope = "visible_text_only"`。
- `UNAVAILABLE`：无法形成有意义的数字；记录原因但不伪造为 0。

来源适配规则：

- Claude 的 `input_tokens` 不包含 `cache_read_input_tokens` 和 `cache_creation_input_tokens`；`effective_input_tokens` 为三者之和。
- Codex/OpenAI 的 `input_tokens` 包含缓存输入；`fresh_input_tokens` 为 input 减去可确认属于其子集的 cache-read/cache-write，且结果必须非负。
- Codex 的 `reasoning_output_tokens` 是 `output_tokens` 的子集；不能再次加到 reported total。
- 原始 `total_tokens` 原样保存在 `source_usage.total_tokens`。只有来源语义已知时才生成 `normalized_usage`，不以规范化值冒充上游账单 total。
- 可见文本估算只填写 `estimated_visible_input_tokens` 或 `estimated_visible_output_tokens`，API 输入、缓存、推理和总量保持 `null`，不得产生与 provider-reported total 可直接比较的合计。

## Claude 数据流

### 状态栏

`ClaudeStatusLine.ps1` 从 stdin 读取 Claude 提供的状态栏 JSON：

- 使用 `context_window.current_usage` 显示最近一次 API 响应的 provider-reported 分类数据。
- 使用 `context_window.used_percentage` 显示上下文占用。
- 使用 `session_id` 的 SHA-256 摘要查找 `latest/claude/<session-hash>.json`，显示该会话最近完成的一轮汇总。
- 状态栏自身不追加历史，避免 Claude 的多次刷新造成重复记录。

状态栏数据表达的是最近 API 响应或最近已完成轮次，不把它描述为账单权威值。`cost.total_cost_usd` 是 Claude 客户端按价格表计算的估算费用，若展示必须标记为估算。

### 逐轮 Hook

`ClaudeTurnHook.ps1` 作为 `Stop` hook：

1. 从 hook stdin 获取文档化的 `session_id` 和 `transcript_path`，不假设 hook payload 存在 `prompt_id`。
2. 从 transcript 末尾向前定位最近一条顶层人类 user 记录；排除 `isSidechain = true`、工具结果和元数据 user 记录。
3. 优先使用该 user 记录的稳定 UUID；缺失时使用其时间戳、文件偏移和第一条 assistant message ID 生成 SHA-256 `turn_id`。
4. 只读取该边界之后、当前 Stop 之前的 assistant 记录，按 API message ID 去重；同一消息的重复持久化项保留最后一项。
5. 汇总该轮可能包含的多次 provider-reported 模型调用，并标记 `DERIVED_REPORTED`。
6. 以 `cli + session_id + turn_id` 的 SHA-256 为 `record_id`；Stop continuation 或重试先原子覆盖同名 `staging/<record-id>.json`，只有最终 Stop 才提交。
7. 在全局历史锁内检查 `history.jsonl` 是否已有该 `record_id`，修复尾部不完整行，再一次写入完整 JSON 行并 flush。幂等性以 history 中的确定性 ID 为准，不依赖另一个先后更新的索引文件。
8. 提交成功后删除 staging，并更新 `latest/claude/<session-hash>.json`。
9. 向 stdout 返回 Claude hook 文档支持的 JSON `systemMessage`，逐轮显示一行统计。若受 `disableAllHooks`、`allowManagedHooksOnly` 或 workspace trust 阻止，安装器保持 `configured_unverified`，不得标记为 `hook_invoked`。

Anthropic 风格字段包括 `input_tokens`、`cache_creation_input_tokens`、`cache_read_input_tokens`、`output_tokens`。中转或 OpenAI 兼容层若被 Claude 正常化为这些字段，单次响应标记为 `PROVIDER_REPORTED`，逐轮汇总标记为 `DERIVED_REPORTED`；没有 usage 时才允许降级为 `ESTIMATED_VISIBLE_TEXT` 或 `UNAVAILABLE`。

## Codex 数据流

Codex CLI `0.153.4` 已支持 `~/.codex/hooks.json` 的 `Stop` command hook。`CodexTurnHook.ps1` 利用该官方完成边界，不运行常驻 watcher：

1. 从 Stop hook stdin 读取 `transcript_path`、`session_id`、`last_assistant_message` 和 Stop continuation 标记等文档化字段。
2. 用 `last_assistant_message` 关联 transcript 尾部的当前 assistant message 和最新 `task_started`，避免在落盘延迟时误选上一轮。
3. 在最多 1.5 秒的有界轮询内等待该 turn 的 `event_msg/task_complete` 出现在 transcript；轮询间隔从 25 ms 退避到 200 ms，总时长必须小于 hook timeout。
4. 若超时或 Stop 表示还会 continuation，只原子更新 `staging/<record-id>.json` 并输出 `[PENDING]`，不提交完成轮次；下一次 Stop 或修复工具继续处理。
5. 在对应 `task_started` 到 `task_complete` 区间内收集相同 `turn_id` 的 `token_usage_record`。
6. 同一轮会产生多条渐进累计记录，只选择 `task_complete` 之前最后一条 `payload.turn_token_usage`；不得选择第一条，也不得逐条追加。
7. 使用与 Claude 相同的确定性 `record_id` 和历史锁事务提交 `DERIVED_REPORTED` 记录，并更新 `latest/codex/<session-hash>.json`。
8. 向 stdout 返回 Codex hook 文档支持的 JSON `systemMessage`，在 TUI 中逐轮显示统计。

`event_msg/token_count/info.last_token_usage` 只表示一次 API 调用且自身没有 turn ID，不能单独形成逐轮记录。旧会话只有在能通过 `task_started`/`task_complete` 边界无歧义关联并汇总时才记为 `DERIVED_REPORTED`；否则记为 `UNAVAILABLE`。真实 `0.153.4` 集成测试必须证明 Stop 时 `last_assistant_message` 与当前 turn 的关联，并覆盖 `task_complete` 已落盘和延迟落盘两种顺序。

若 Codex 在写出 `task_complete` 后、Stop hook 成功落盘前崩溃，`Repair-TokenHistory.ps1` 可离线扫描完整 `task_complete` 区间进行补录。没有 `task_complete` 的中断轮默认不计入完成轮次，并在修复报告中列为 abandoned。

Codex 状态栏安装值固定为官方示例支持的 `status_line = ["model-with-reasoning", "context-remaining", "current-dir"]`；其中 `context-remaining` 是状态栏的 Token 上下文信号，详细逐轮拆分由 Stop `systemMessage` 显示。`codex exec --json` 只覆盖非交互调用，不作为交互式 CLI 的主实现。

采集默认只接受 `session_meta.source` 为 `cli` 或 `exec` 且没有 `parent_thread_id` 的顶层 CLI 会话，排除 Desktop/IDE、guardian、subagent 和其他内部会话，避免重复计量。本版本不导入子代理历史。

## 安装与配置合并

`Install-TokenMeter.ps1` 执行以下动作：

1. 检查 PowerShell、Claude Code、Codex CLI 版本和目录可写性。
2. 用 JSON 结构化方式合并 `~/.claude/settings.json` 和 `~/.codex/hooks.json`，保留未知键和已有 hook。安装器不得读取 `auth.json`，不得查找环境中的 API Key，也不得在日志中输出任何配置值。
3. 在两个 CLI 的现有 `Stop` 列表中追加可由命令路径唯一识别的 Token hook；重复安装检测到相同命令时跳过，不生成重复项。
4. Claude 已有不同 `statusLine` 时默认报冲突并保持原值；只有用户显式传入 `-ReplaceClaudeStatusLine` 才替换。ownership manifest 记录原节点、原节点是否存在、原值哈希和本安装器写入后的哈希。
5. Codex `config.toml` 只定向管理 `[tui]` 下的 `status_line`，安装值固定为 `['model-with-reasoning', 'context-remaining', 'current-dir']`。编辑器识别普通 `[tui]` table、顶层 `tui.status_line` dotted key 和单行/多行数组；若发现 quoted table/key、duplicate definition、inline table 或无法可靠判定的语法，拒绝自动修改并报告用 `/statusline` 手动设置。
6. TOML 编辑只替换已识别的目标值或在明确的 `[tui]` table 末尾插入，其他字节和注释保持不变。候选文件放进临时 `CODEX_HOME`，执行有超时的 `codex --strict-config features list` 非交互校验；退出非零或超时则不替换原文件。
7. 对配置的写入使用同目录临时文件、继承原文件 ACL，并以原子替换完成。安装器会在内存中解析整个 Claude JSON，但把 `env` 等非目标值视为不透明数据：不比较、不记录、不传输，也不创建包含全量配置的持久备份。
8. manifest 只保存本方案拥有的节点路径、安装前目标节点内容、安装后哈希和安装时间；不保存 `env`、provider、认证或其他无关配置。
9. 创建当前 `<computer>/<user>` 数据目录并运行不发模型请求的离线自测。此时安装状态为 `configured_unverified`；任一 CLI 的下一次正常真实回合成功执行 hook 并返回 `systemMessage` 后，该 CLI 单独标记为 `hook_invoked`。程序不能自行断言用户实际看见了消息；`Test-TokenMeter.ps1 -ConfirmVisible claude|codex` 只在用户确认后记录 `user_confirmed_visible`。

其他 PC 或用户复制三个目录后，`.cmd` 入口通过 `%USERPROFILE%` 解析脚本位置。无需 PowerShell profile 或 PATH 修改。如果连同已安装的 `.claude`、`.codex` 配置复制，hook 会惰性创建该用户的数据目录并直接工作；建议首次运行 `Install-TokenMeter.ps1`，用于校验 CLI 版本、策略和配置，而不是修复绝对路径。

`Uninstall-TokenMeter.ps1` 只处理 manifest 能证明由本安装器写入且哈希仍匹配的 hook/status-line 节点。安装前不存在的节点由卸载器删除；通过显式 replace 保存了安装前原值的节点则恢复该原值。如果用户在安装后修改了目标节点，卸载器停止并报告冲突，不用旧值覆盖新配置。卸载不删除历史数据。

## 查询与展示

默认逐轮输出：

```text
[REPORTED→TURN] Claude | fresh 2,299 | cacheR 239,872 | out 1,359
[REPORTED→TURN] Codex  | input 31,465 (cacheR 4,224 included) | out 157 (reasoning 23 included)
[EST:VISIBLE]  Claude | visible-in ~2,180 | visible-out ~1,320 | not billable-total
```

查询脚本支持：

```powershell
./Show-TokenHistory.ps1 -Last 20
./Show-TokenHistory.ps1 -Cli claude
./Show-TokenHistory.ps1 -Cli codex
./Show-TokenHistory.ps1 -Period Today
./Show-TokenHistory.ps1 -AllMachines
```

默认只读取当前机器和用户目录；`-AllMachines` 才递归汇总共享目录中的其他机器和用户，输出必须保留来源列，避免不同用户的数据被误认为一个会话。

## 并发、错误与性能

- JSONL 追加使用文件锁和有限次数短重试；锁失败写 `errors.log`，不得阻止 CLI 正常结束。
- 每会话 latest 文件通过临时文件加同卷替换更新，防止状态栏读取半写文件或并发会话互相覆盖。
- Claude status line 不做全量历史扫描。考虑 Windows PowerShell 冷启动成本，目标执行时间低于 400 ms、硬超时 1 秒；若用户安装了 PowerShell 7，可由安装器选择实测更快的入口。
- hooks 和修复工具都以 history 中的确定性 `record_id` 作为提交事实；`collector-state.json` 仅保存非关键扫描游标，删除后可由 history 重建。
- 解析错误按文件和偏移记录，不把整条会话内容写入错误日志。
- 所有输出默认不包含提示词、回复正文、工具参数、文件内容或密钥。

## 验证

离线测试覆盖：

- Claude 单次调用、多次工具循环、缺少 `prompt_id`、重复 message ID、Stop 重试、无 usage 和 OpenAI 风格字段。
- Codex `0.153.4` 同一 turn 的多条渐进 `token_usage_record`，确认只在 `task_complete` 后采用最后累计值。
- 部分 UTF-8/JSONL 行、文件截断/轮转、缺少 `task_complete` 的 abandoned turn 和修复工具重跑。
- `PROVIDER_REPORTED`、`DERIVED_REPORTED`、`ESTIMATED_VISIBLE_TEXT`、`UNAVAILABLE` 的显示和序列化。
- Claude 与 Codex hook 并发追加、两个同类 hook 同时运行、同时存在多个 CLI 会话时，每行仍可解析且不重复；覆盖“完整行已追加但状态文件尚未更新即崩溃”和“尾部只写入半行”两种故障。
- 用户名、计算机名和用户目录含空格或发生变化后无硬编码路径。
- 顶层 CLI、Desktop/IDE、guardian 和 subagent fixture 的默认过滤正确。
- 已有 status line、已有 Stop hooks、嵌入敏感 env、安装后再次编辑配置、重复安装和冲突卸载。
- 配置处理日志和错误日志不披露敏感值；原文件 ACL 在写入后保持。
- 离线安装结束时明确报告 `configured_unverified`；在真实 Claude Code `2.1.252` 和 Codex CLI `0.153.4` 的下一次正常回合验证 Stop hook 被调用并返回 `systemMessage`，写入 `hook_invoked`。只有用户确认屏幕可见后才写 `user_confirmed_visible`。专门发起 smoke turn 会消耗 Token，只能由用户显式执行。
- 安装和卸载不会破坏原有 Claude hooks、Codex hooks、Codex `notify` 或 provider 配置。
- `git check-ignore -v .token-meter-data/.../history.jsonl` 验证运行数据被排除。

离线解析与配置验证使用本机已有 session 文件，不发起额外模型请求，因此不会为安装测试消耗 Token。UI 可见性只有在下一次正常真实回合或用户显式发起的 smoke turn 后才能验证；安装器必须把两种状态分开报告。

## 已知限制

- Claude 状态栏 `current_usage` 是最近一次 API 响应，不等同于整个用户轮次；整轮数据以 Stop hook 汇总为准。
- 第三方中转如果删去或伪造 usage，客户端无法验证其准确性；因此 UI 使用 “reported” 而不是“账单真实值”。
- 文本估算看不到完整系统提示、工具 schema 或提供商内部处理，只表示可见文本规模，不提供账单总量。
- managed hook 策略或 workspace trust 可以禁止用户 hook；安装器必须检测并报告，不能静默降级为“已部署”。
- 各提供商账单后台仍是费用结算的最终权威来源。
