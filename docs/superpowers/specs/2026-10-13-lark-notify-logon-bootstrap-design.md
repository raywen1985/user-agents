# 飞书通知登录后自动启用设计

## 目标

Windows 用户登录后自动检查 Claude Code 与 Codex 的飞书结束通知配置，并在配置缺失时安全恢复。通知仍由客户端的生命周期 Hook 触发；登录任务只做一次性自检和配置修复，不常驻、不发送测试消息，也不要求管理员权限。

## 方案

安装名为 `LarkNotifyBootstrap` 的 Windows 计划任务。任务以当前用户、`Limited` 权限在该用户登录后运行隐藏的 PowerShell 引导脚本。引导脚本成功后退出；失败时由任务计划程序每分钟重试，最多 5 次。

该方案只保证用户登录后的自动启用。机器停留在 Windows 登录界面时不运行，也不引入系统服务或保存服务账户密码。

## 组件

### 引导脚本

新增 `hooks/Initialize-LarkNotify.ps1`，负责：

1. 定位 `~/.agents/hooks/lark-notify.ps1`、`~/.agents/lark-notify.json`、`~/.claude/settings.json`、`~/.codex/hooks.json` 和 `lark-cli`。
2. 验证通知配置包含非空 `recipientOpenId`、受支持的 `identity`，并能找到通知脚本与 `lark-cli`。
3. 用结构化 JSON API 读取并合并 Hook，不用字符串拼接修改 JSON。
4. 仅在目标 Hook 缺失时写回；配置已正确时不改文件时间和字节，避免无意义地改变 Codex Hook 信任状态。
5. 写入前在同目录创建临时文件，重新解析并验证后原子替换目标文件；保留一个最近备份用于人工恢复。
6. 将结果写入 `%LOCALAPPDATA%\lark-notify\bootstrap.log`，不记录令牌、App Secret 或消息正文。

脚本支持 `-CheckOnly`。该模式执行全部验证并报告缺失项，但不修改文件，供测试和排障使用。

### Claude Code Hook

在 `~/.claude/settings.json` 中幂等确保以下通知 Hook 存在：

- `Stop`：同步执行 `lark-notify.ps1 -Source claude`，超时 30 秒。
- `StopFailure`：同步执行相同命令，超时 30 秒。
- `Notification`：仅匹配 `permission_prompt|idle_prompt|agent_needs_input`，异步执行，超时 30 秒。

合并时保留所有现有 `env`、permissions、plugins、status line、其他事件与其他 Hook。同一事件下已经存在语义等价的通知命令时不重复添加。

### Codex Hook

在 `~/.codex/hooks.json` 中幂等确保 `Stop` 包含 `lark-notify.ps1 -Source codex`，超时 30 秒。保留 description、其他事件和其他 Hook，不注册 `PermissionRequest`。

Codex 会记录用户级 Hook 文件的信任哈希。因此引导脚本不得在配置正确时重写 `hooks.json`。如果确实补入或修复了 Codex Hook，脚本在日志中明确记录“需要在 Codex 中确认更新后的用户 Hook”；不伪造或直接修改 `config.toml` 中的信任哈希。

### 任务安装脚本

新增 `hooks/Install-LarkNotifyBootstrapTask.ps1`，负责注册或更新计划任务：

- 任务名：`LarkNotifyBootstrap`
- 触发器：当前 Windows 用户登录
- 运行身份：当前用户
- 权限：`Limited`
- 动作：隐藏、非交互 PowerShell，执行 `Initialize-LarkNotify.ps1`
- 重试：失败后每分钟一次，最多 5 次
- 电池策略：允许启动，切换到电池时不停止
- 执行时间上限：5 分钟

安装完成后立即启动一次任务并等待其进入完成或失败状态，以便当前会话立即获得结果。安装脚本重复运行时更新同名任务，不创建重复项。

## 数据流

1. 用户登录 Windows。
2. 任务计划程序启动一次引导脚本。
3. 引导脚本验证依赖和 JSON 配置。
4. 缺失 Hook 时安全合并；配置完整时不写入。
5. 引导脚本记录检查结果并退出。
6. 之后 Claude Code 或 Codex 会话结束时，客户端自行调用现有 `lark-notify.ps1` 发送飞书卡片。

计划任务不负责启动 Claude Code、Codex、飞书客户端或本地模型代理。只有用户实际启动 Claude Code/Codex 并产生 Hook 事件时才会发送通知。

## 错误处理

- 通知脚本、通知配置或 `lark-cli` 缺失：记录明确路径并返回非零，触发计划任务重试。
- Claude/Codex JSON 不存在：创建只包含所需最小结构的新文件。
- JSON 无法解析：不覆盖原文件，记录错误并返回非零。
- 写入验证失败：保留原文件并删除无效临时文件。
- Hook 已存在但参数不同：只补入规范 Hook，不删除未知 Hook；避免猜测用户配置意图。
- Codex Hook 被修改：记录需要用户在 Codex 中确认信任，不自动写信任哈希。
- 飞书网络或授权不可用：本次设计只验证本地依赖，不在每次登录时调用远端 API，以免启动网络尚未就绪造成误报。真实发送失败继续由 `notify.log` 记录。

## 安全与隐私

- 计划任务使用当前用户的普通权限，不保存密码。
- 不把飞书凭据复制到任务参数或环境变量。
- 日志不包含 `recipientOpenId`、令牌、App Secret、Hook payload 或会话正文。
- 不覆盖或删除不属于本功能的 Hook。

## 测试与验收

PowerShell 测试在临时用户目录中覆盖：

- Claude/Codex 配置不存在时创建最小配置。
- 缺失的三个 Claude Hook 和一个 Codex Hook被补齐。
- 已存在的其他 Hook、env、permissions、plugins 和 description 保持不变。
- 连续运行两次后 Hook 数量、配置内容和文件时间不再变化。
- 路径大小写、引号和等价 PowerShell 参数不会产生重复 Hook。
- 损坏 JSON、缺失通知配置、缺失通知脚本和缺失 `lark-cli` 时拒绝破坏性写入并返回非零。
- `-CheckOnly` 不写文件。
- 日志完成脱敏，不包含接收人 ID 或其他敏感值。
- 任务定义为当前用户登录触发、`Limited` 权限、隐藏运行、5 次一分钟重试和 5 分钟上限。

实际安装后执行以下只读验收：

1. 查询 `LarkNotifyBootstrap` 的触发器、动作、运行身份和重试设置。
2. 手动启动计划任务，确认最近运行结果为成功。
3. 确认 `bootstrap.log` 报告 Claude 与 Codex Hook 均已启用。
4. 再次运行引导脚本，确认配置文件未被重写。

验收过程不发送飞书测试消息。真实通知由下一次正常结束的 Claude Code 或 Codex 会话验证。
