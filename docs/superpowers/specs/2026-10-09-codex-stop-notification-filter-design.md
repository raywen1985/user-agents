# Codex Stop 通知过滤设计

## 背景

用户级 Codex `Stop` Hook 会接收 Codex Desktop 内部后台 Turn，包括 `ambient_suggestions` 和 `ambient_suggestion_safety`。这些 Turn 没有用户交互，但当前通知脚本对所有 Codex `Stop` 无条件发送飞书消息，造成成对的误通知。

## 目标

- 真实、已持久化的 Codex 用户会话在 Turn 结束时继续发送通知。
- Codex Desktop 未持久化的后台临时 Turn 不发送通知。
- Claude Code 的既有通知行为保持不变。
- 过滤依据以正式会话身份为主，不依赖易变化的摘要文本。

## 方案

在 `hooks/lark-notify.ps1` 中增加 Codex 正式会话判定，并在 `Test-ShouldNotify` 处理 Codex `Stop`/`StopFailure` 时调用：

1. Codex Home 优先读取 `$env:CODEX_HOME`，未设置时回退到 `$env:USERPROFILE\.codex`。
2. 一次读取 `session_index.jsonl`，按 `session_id` 查找正式会话并同时取得 `thread_name`。坏行逐行忽略，不影响后续记录。
3. `transcript_path` 只有在文件存在、规范化路径位于 `<CodexHome>\sessions` 目录内，且文件名包含相同的非空 `session_id` 时，才构成正式会话证据。普通临时文件不构成证据。
4. `session_id` 命中 index 或 transcript 通过上述严格校验，任一成立即视为正式会话。
5. 无正式会话证据的 Codex Turn 视为临时内部 Turn，记录本地 skip 原因但不发送飞书消息。
6. 位于 `$env:LOCALAPPDATA\OpenAI\Codex\bin` 的 Turn 作为诊断信号写入 skip 原因，但不覆盖有效持久化证据，避免误杀用户从该目录启动的真实会话。

脚本不根据 `suggestions` 或 `exclude` 等摘要内容判断，避免后台输出格式变化导致过滤失效。路径先解析本地文件 URI，再用 `GetFullPath` 规范化；目录边界以大小写不敏感的“路径相等或位于根目录分隔符之后”判断，不能使用裸字符串前缀。

决策表：

| Index 命中 | 合法 session transcript | 位于 Codex bin | 结果 |
|---|---|---|---|
| 是 | 任意 | 任意 | 通知 |
| 否 | 是 | 任意 | 通知 |
| 否 | 否 | 是 | 跳过，原因标记为 Codex 内部目录 |
| 否 | 否 | 否 | 跳过，原因标记为未持久化会话 |

## 数据流

`Stop` Hook JSON -> 读取事件、session、transcript、cwd -> Codex 正式会话判定 -> 允许时生成并发送消息，拒绝时写 skip 日志并返回空 JSON。

## 异常处理

- session index 不存在时按未找到处理；读取失败时做有限短重试，仍失败则把 index 状态记为 `ReadFailed`，继续校验 transcript。合法 transcript 仍允许通知；只有 transcript 也无效时才 fail-closed 跳过并记录 `session-index-read-failed`，不影响 Codex。
- session index 的坏行逐行忽略并继续查找后续记录。
- transcript 路径为空或文件不存在时继续尝试 session index。
- 过滤过程不抛出影响 Codex 的异常；继续沿用脚本当前的日志和空 JSON 返回约定。

## 验证

使用临时 `USERPROFILE`、`CODEX_HOME`、`LOCALAPPDATA` 及 fixture index/transcript、`.agents\lark-notify.json`，隔离真实用户状态。断言 stdout、退出码和 skip 日志原因，覆盖：

- Codex session 目录中、文件名包含相同 session id 的正式 transcript：允许通知。
- session index 中存在的 Codex `Stop`：允许通知。
- 无 transcript、无 index 记录的建议生成 Turn：跳过。
- Codex `bin` 目录中的安全检查 Turn：跳过。
- Codex `bin` 目录但有有效持久化身份：允许通知。
- 空 `session_id`：跳过。
- index 坏行后存在有效记录：允许通知。
- index 持续不可读：跳过并记录读取失败原因。
- index 持续不可读但 transcript 合法：允许通知。
- 目录根、哈希子目录、大小写变化、尾分隔符、本地 file URI、相似前缀目录的路径边界。
- Codex `StopFailure` 使用相同正式会话过滤规则。
- Claude `Stop` 与既有 `Notification` 条件：行为不变。

同时更新 `ai-install.md` 的 Hook 验收示例：允许样本创建隔离的正式 transcript；原 `deployment-test` 无持久化证据样本改作“应跳过”的验证。

## 非目标

- 不关闭 Codex Desktop 的环境建议功能。
- 不修改 Codex Hook 事件类型。
- 不改变飞书消息格式、收件人或 Claude Code 配置。
