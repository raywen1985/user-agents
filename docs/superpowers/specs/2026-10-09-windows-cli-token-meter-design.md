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

采用本地会话记录采集方案：

- Claude 使用原生 `statusLine` 和每轮触发的 `Stop` hook。
- Codex 使用原生 `/statusline` 支持的内置项目，并由伴随 PowerShell watcher 读取 session JSONL 中的 Token 事件。
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
├─ Watch-CodexTokens.ps1
├─ Show-TokenHistory.ps1
└─ fixtures/
```

每台机器、每个用户的运行数据放在：

```text
~/.agents/.token-meter-data/<computer>/<user>/
├─ history.jsonl
├─ latest.json
├─ collector-state.json
└─ errors.log
```

`.agents/.gitignore` 增加：

```gitignore
# Per-machine token usage data
/.token-meter-data/
```

脚本只能通过 `$HOME`、`$env:USERPROFILE`、`$env:COMPUTERNAME`、`$env:USERNAME` 和 `Join-Path` 构造路径，不保存安装机器的绝对用户目录。计算机名和用户名在作为目录名之前必须清理 Windows 非法文件名字符。

Claude 的命令配置使用 `~`、正斜杠和显式 PowerShell 入口，例如：

```json
{
  "statusLine": {
    "type": "command",
    "command": "powershell -NoProfile -ExecutionPolicy Bypass -File ~/.agents/token-meter/ClaudeStatusLine.ps1"
  }
}
```

这样无论 Claude Code 在 Windows 上经 Git Bash 还是 PowerShell 启动状态栏，复制到其他用户目录后都不依赖原用户名。

## 统一数据模型

历史记录按行写入 UTF-8 JSONL。每条记录至少包含：

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
  "input_tokens": 31465,
  "cached_input_tokens": 4224,
  "cache_write_input_tokens": 0,
  "output_tokens": 157,
  "reasoning_output_tokens": 0,
  "total_tokens": 31622,
  "quality": "REAL_API",
  "source": "codex.token_usage_record.turn_token_usage"
}
```

可信度枚举：

- `REAL_API`：API 响应或 CLI 会话事件明确返回的 usage。
- `DERIVED_REAL`：仅对真实累计字段求差或对多次真实 API 调用去重汇总。
- `ESTIMATED_TEXT`：只能根据可见文本和已知 tokenizer 规则估算；数字显示 `~` 前缀。
- `UNAVAILABLE`：无法形成有意义的数字；记录原因但不伪造为 0。

`total_tokens` 保留上游定义。若上游没有 total，则由明确存在的各字段求和，并记录 `total_is_derived: true`。缓存 Token 不得既包含在 input 中又重复计入 total；采集器必须按来源适配器定义处理。

## Claude 数据流

### 状态栏

`ClaudeStatusLine.ps1` 从 stdin 读取 Claude 提供的状态栏 JSON：

- 使用 `context_window.current_usage` 显示最近一次 API 响应的真实分类数据。
- 使用 `context_window.used_percentage` 显示上下文占用。
- 使用 `session_id` 和 `prompt_id` 查找本机 `latest.json`，显示最近完成的一轮汇总。
- 状态栏自身不追加历史，避免 Claude 的多次刷新造成重复记录。

状态栏数据表达的是最近 API 响应或最近已完成轮次，不把它描述为账单权威值。`cost.total_cost_usd` 是 Claude 客户端按价格表计算的估算费用，若展示必须标记为估算。

### 逐轮 Hook

`ClaudeTurnHook.ps1` 作为 `Stop` hook：

1. 从 hook stdin 获取 `session_id`、`prompt_id` 和 `transcript_path`。
2. 只读取当前用户轮次之后的 assistant 记录。
3. 按 API message ID 去重；同一消息出现流式或持久化重复项时只保留最终 usage。
4. 汇总该轮可能包含的多次模型调用。
5. 原子追加历史并更新 `latest.json`。
6. 通过 hook 的用户可见消息输出一行统计；若当前 Claude 版本或策略不显示该消息，历史写入仍然成功。

Anthropic 风格字段包括 `input_tokens`、`cache_creation_input_tokens`、`cache_read_input_tokens`、`output_tokens`。中转或 OpenAI 兼容层若被 Claude 正常化为这些字段，仍标记为 `REAL_API`；没有 usage 时才允许降级为 `ESTIMATED_TEXT` 或 `UNAVAILABLE`。

## Codex 数据流

Codex 交互式 TUI 当前没有与 Claude `Stop` command hook 等价的任意脚本输出接口，因此职责分开：

- `/statusline` 配置 Codex 当前版本支持的原生 Token、上下文和模型项目。
- `Watch-CodexTokens.ps1` 使用 `FileSystemWatcher` 或短间隔增量读取 `~/.codex/sessions/**/*.jsonl`。
- 优先读取 `type = token_usage_record` 的 `payload.turn_token_usage`。
- 兼容读取 `event_msg/token_count/info.last_token_usage`，但仅作为旧格式回退。
- 以 `session_id + turn_id` 去重，追加统一历史并在伴随 PowerShell 窗口打印。

`codex exec --json` 可直接消费结构化事件，但它只覆盖非交互调用，不作为交互式 CLI 的通用实现。watcher 不修改 Codex 请求、不读取 `auth.json`，也不依赖 API Key 内容。

## 安装与配置合并

`Install-TokenMeter.ps1` 执行以下动作：

1. 检查 PowerShell、Claude Code、Codex CLI 版本和目录可写性。
2. 为将修改的配置创建带时间戳备份。
3. 用 JSON 结构化方式合并 `~/.claude/settings.json`，保留现有 `env`、模型、权限、主题和 hooks。
4. 在现有 `Stop` hook 列表中追加 Token hook，不覆盖其他 hook。
5. 更新 Claude `statusLine`；如已存在不同配置，备份并在安装报告中明确列出替换内容。
6. 以 Codex 当前版本能识别的配置键设置原生状态栏；不覆盖现有 `model_provider`、`model`、`notify` 或认证配置。
7. 创建当前 `<computer>/<user>` 数据目录并运行离线自测。

其他 PC 或用户复制三个目录后，Claude 状态栏和 hook 因使用 `~` 路径可直接解析。Codex watcher 可通过完整脚本路径启动；安装器还可选择在当前用户 PowerShell profile 中注册便捷函数，但 profile 修改不是统计功能的硬依赖。

`Uninstall-TokenMeter.ps1` 只移除本方案加入的配置项，若无法证明某项由本安装器创建，则恢复备份或停止并报告，不删除历史数据。

## 查询与展示

默认逐轮输出：

```text
[REAL] Claude | in 2,299 | cache-read 239,872 | out 1,359 | total 243,530
[REAL] Codex  | in 31,465 | cached 4,224 | out 157 | reasoning 0 | total 31,622
[EST]  Claude | in ~2,180 | out ~1,320 | partial visible-text estimate
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

- JSONL 追加使用文件锁和有限次数短重试；锁失败写 `errors.log`，不得阻塞 CLI。
- `latest.json` 通过临时文件加同卷替换更新，防止状态栏读取半写文件。
- Claude status line 不做全量历史扫描，目标执行时间低于 150 ms。
- Codex watcher 保存每个 session 文件的字节偏移和已处理 turn ID；重启后不重复导入。
- 解析错误按文件和偏移记录，不把整条会话内容写入错误日志。
- 所有输出默认不包含提示词、回复正文、工具参数、文件内容或密钥。

## 验证

离线测试覆盖：

- Claude 单次调用、多次工具循环、重复 message ID、无 usage 和 OpenAI 风格字段。
- Codex `token_usage_record`、旧 `token_count` 回退、文件追加和 watcher 重启。
- `REAL_API`、`DERIVED_REAL`、`ESTIMATED_TEXT`、`UNAVAILABLE` 的显示和序列化。
- 两个 watcher/Hook 并发追加时 JSONL 每行仍可独立解析。
- 用户名、计算机名和用户目录变化后无硬编码路径。
- 安装、重复安装和卸载不会破坏原有 Claude hooks、Codex `notify` 或 provider 配置。
- `git check-ignore -v .token-meter-data/.../history.jsonl` 验证运行数据被排除。

上线验证使用本机已有 session 文件，不发起额外模型请求，因此不会为测试消耗 Token。

## 已知限制

- Claude 状态栏 `current_usage` 是最近一次 API 响应，不等同于整个用户轮次；整轮数据以 Stop hook 汇总为准。
- 第三方中转如果删去或伪造 usage，客户端无法把估算值提升为真实值。
- 文本估算看不到完整系统提示、工具 schema 或提供商内部处理时，只能标记为部分估算。
- Codex 的详细逐轮拆分显示在伴随 watcher 窗口和历史中，不强行向 TUI 绘制，以免破坏交互界面。
- 各提供商账单后台仍是费用结算的最终权威来源。
