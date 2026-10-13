# 飞书通知登录后自动启用设计

## 目标

Windows 用户登录后自动检查 Claude Code 与 Codex 的飞书结束通知配置，并在配置缺失时安全恢复。通知仍由客户端的生命周期 Hook 触发；登录任务只做一次性自检和配置修复，不常驻、不发送测试消息，也不要求管理员权限。

## 方案

安装名为 `LarkNotifyBootstrap` 的 Windows 计划任务。任务的触发器和 principal 都绑定安装时当前用户的 SID，使用 `InteractiveToken`（仅当该用户已登录时运行）、`Limited` 权限和无密码凭据运行隐藏的 PowerShell 引导脚本。引导脚本成功后退出；失败时由任务计划程序每分钟重试，最多 5 次。

该方案只保证用户登录后的自动启用。机器停留在 Windows 登录界面时不运行，也不引入系统服务或保存服务账户密码。

## 组件

### 引导脚本

新增 `hooks/Initialize-LarkNotify.ps1`，负责：

1. 定位 `~/.agents/hooks/lark-notify.ps1`、`~/.agents/lark-notify.json`、`~/.claude/settings.json`、`~/.codex/hooks.json` 和 `lark-cli`。
2. 验证通知配置包含非空 `recipientOpenId`、受支持的 `identity`，并能找到通知脚本与 `lark-cli`。
3. 用结构化 JSON API 读取并合并 Hook，不用字符串拼接修改 JSON。解析普通 `-File` 命令和可解码的 PowerShell `-EncodedCommand`；只有最终解析为当前 `lark-notify.ps1` 且 `-Source` 与事件来源匹配的命令才视为本功能拥有的 Hook。
4. 仅在目标 Hook 缺失时写回；配置已正确时不改文件时间和字节，避免无意义地改变 Codex Hook 信任状态。
5. 以 `Local\LarkNotifyBootstrap-<当前用户 SID 哈希>` 命名的跨进程 mutex 覆盖检查、读取、合并和替换全过程。计划任务同时设置 `MultipleInstances=IgnoreNew`，避免安装后立即运行与登录触发重叠。
6. 写入前在同目录创建临时文件，重新解析并验证。替换前再次计算目标文件哈希；若与读取时不同，丢弃候选文件并从最新内容重试完整合并，最多 3 次，禁止用旧快照覆盖并发修改。验证完成后原子替换目标文件。
7. 每个目标只保留一个固定名称的最近备份。目标已存在时，临时文件和备份复制目标文件的 owner 与 DACL，不新增任何 allow ACE，因此访问权限绝不比目标更宽；新建目标时才使用仅当前用户、SYSTEM 与 Administrators 可访问的显式 ACL。完成、验证失败或替换失败后清理本次临时文件。
8. 发现上次崩溃残留的临时文件时先验证正式目标：目标仍可解析则删除残留；目标无法解析则不自动恢复、不删除目标、备份或残留临时文件，记录三个路径并失败退出，留给人工判断，避免猜测哪份内容更新。
9. 将结果写入 `%LOCALAPPDATA%\lark-notify\bootstrap.log`，不记录令牌、App Secret 或消息正文。

脚本支持 `-CheckOnly`。该模式执行全部验证并报告缺失项，但不修改文件，供测试和排障使用。

### Claude Code Hook

在 `~/.claude/settings.json` 中幂等确保以下通知 Hook 存在：

- `Stop`：同步执行 `lark-notify.ps1 -Source claude`，超时 30 秒。
- `StopFailure`：同步执行相同命令，超时 30 秒。
- `Notification`：仅匹配 `permission_prompt|idle_prompt|agent_needs_input`，异步执行，超时 30 秒。

合并时保留所有现有 `env`、permissions、plugins、status line、其他事件与其他 Hook。`matcher` 属于外层 entry，不能在含未知 sibling hook 的共享 entry 上原地修改。每个必需事件按以下规则收敛为一个发送路径：

- 若第一个本功能 Hook 是其 entry 中唯一的 hook，则可在原位置规范化外层 matcher 以及内层 timeout、async 和命令。
- 若本功能 Hook 与未知 hook 共享 entry，则保持外层 matcher 和未知 sibling 不变，把该本功能 Hook 在原位置替换为成功退出的无操作 Hook，并在事件数组末尾追加独立的规范 entry。
- 其他本功能重复项都在原位置替换为无操作 Hook，避免改变后续数组索引。
- 真正未知的 Hook 完全保留；没有可安全原位规范化的本功能 Hook 时才追加独立规范 entry。

### Codex Hook

在 `~/.codex/hooks.json` 中幂等确保 `Stop` 包含 `lark-notify.ps1 -Source codex`，超时 30 秒。保留 description、其他事件和其他 Hook，不注册 `PermissionRequest`。

Codex 会把信任键绑定到 Hook 的事件名和数组位置。因此引导脚本不得排序、展平或重建已有事件、entry、hook 数组；已有未知 Hook 的索引和命令序列化值必须保持不变。若需要修复已有本功能 Hook，只在其原位置替换；额外的本功能重复项在原位置改为无操作 Hook；若不存在则追加到数组末尾。这样只有新增或被修复的本功能位置需要重新确认，不使无关 Hook 的信任键失效。

配置正确时不得重写 `hooks.json`。如果确实补入或修复了 Codex Hook，脚本在日志中明确记录“需要在 Codex 中确认更新后的用户 Hook”；不伪造或直接修改 `config.toml` 中的信任哈希。

### 任务安装脚本

新增 `hooks/Install-LarkNotifyBootstrapTask.ps1`，负责注册或更新计划任务：

- 任务名：`LarkNotifyBootstrap`
- 触发器：当前 Windows 用户登录
- 运行身份：当前用户
- principal 与登录触发器用户：安装时当前用户 SID
- 登录类型：`InteractiveToken`，仅当用户已登录时运行，不保存密码
- 权限：`Limited`
- 动作：隐藏、非交互 PowerShell，执行 `Initialize-LarkNotify.ps1`
- 重试：失败后每分钟一次，最多 5 次
- 多实例策略：`IgnoreNew`
- 电池策略：允许启动，切换到电池时不停止
- 执行时间上限：5 分钟

安装完成后立即启动一次任务，以便当前会话立即获得结果。安装器先记录任务原有 `LastRunTime`，调用 `Start-ScheduledTask`，然后在有界超时内等待 `LastRunTime` 变新且状态不再是 `Running`，最后检查这一次运行对应的 `LastTaskResult`。若启动被 `IgnoreNew` 忽略、运行时间未更新、等待超时或新结果非零，安装失败。安装脚本重复运行时更新同名任务，不创建重复项。

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
- Hook 已存在但参数不同：仅当 entry 不含未知 sibling 时原位规范化；共享 entry 中的本功能 Hook原位置停用并在末尾追加独立规范 entry。额外本功能重复项原位置停用；未知 Hook 和共享 matcher 不删除、不修改、不重排。
- 并发修改配置：目标哈希变化时丢弃候选并基于最新文件重试，超过 3 次后失败，不覆盖新内容。
- 并行引导：同 SID mutex 串行化；计划任务的第二实例由 `IgnoreNew` 拒绝。
- Codex Hook 被修改：记录需要用户在 Codex 中确认信任，不自动写信任哈希。
- 飞书网络或授权不可用：本次设计只验证本地依赖，不在每次登录时调用远端 API，以免启动网络尚未就绪造成误报。真实发送失败继续由 `notify.log` 记录。

## 安全与隐私

- 计划任务使用当前用户的普通权限，不保存密码。
- 不把飞书凭据复制到任务参数或环境变量。
- 已有目标的临时文件和单份备份精确复制目标 owner/DACL，不扩大访问范围；新目标才使用当前用户、SYSTEM、Administrators 的显式 ACL。一般失败路径清理本次临时文件，只有“发现崩溃残留且正式目标也损坏”时保留目标、备份和残留供人工恢复。
- 日志不包含 `recipientOpenId`、令牌、App Secret、Hook payload 或会话正文。
- 不覆盖或删除不属于本功能的 Hook。

## 测试与验收

PowerShell 测试在临时用户目录中覆盖：

- Claude/Codex 配置不存在时创建最小配置。
- 缺失的三个 Claude Hook 和一个 Codex Hook被补齐。
- 已存在的其他 Hook、env、permissions、plugins 和 description 保持不变。
- 连续运行两次后 Hook 数量、配置内容和文件时间不再变化。
- 路径大小写、引号、普通 `-File`、旧版可解码 `-EncodedCommand` 和等价 PowerShell 参数不会产生重复 Hook。
- timeout、matcher 或 async 错误以及两个既有本功能变体会被收敛为一个发送路径；额外变体原位置变为无操作 Hook。
- 本功能 Hook 与未知 hook 共享同一 entry 时，共享 matcher 和未知 sibling 保持不变，本功能旧位置停用，独立规范 entry 追加到末尾，最终仍只有一个发送路径。
- Codex 包含多个已有 Stop entry/hook 时，未知 Hook 的索引和序列化命令保持不变；只修改本功能拥有的位置或在末尾追加。
- 损坏 JSON、缺失通知配置、缺失通知脚本和缺失 `lark-cli` 时拒绝破坏性写入并返回非零。
- `-CheckOnly` 不写文件。
- 日志完成脱敏，不包含接收人 ID 或其他敏感值。
- 两个并行引导实例和注入的读后并发编辑均不会丢失未知配置改动。
- 注入验证失败和替换失败时目标字节不变、当前运行的临时文件被清理、每个目标最多保留一个备份，且已有目标的临时/备份 owner 与 DACL 和目标一致。
- 残留临时文件且正式目标损坏时不自动恢复或删除任何恢复文件，返回失败并记录人工恢复路径；正式目标有效时残留临时文件被清理。
- 任务定义断言触发器与 principal 都使用当前用户 SID、`InteractiveToken`、无密码、`Limited` 权限、`IgnoreNew`、隐藏运行、5 次一分钟重试和 5 分钟上限。
- 安装后等待逻辑覆盖快速成功、非零结果、已运行实例导致启动被忽略和等待超时，不读取旧的 `LastTaskResult` 冒充本次成功。

实际安装后执行以下只读验收：

1. 查询 `LarkNotifyBootstrap` 的触发器、动作、当前用户 SID principal、`InteractiveToken`、无密码、`Limited`、`IgnoreNew` 和重试设置。
2. 手动启动计划任务，确认最近运行结果为成功。
3. 确认 `bootstrap.log` 报告 Claude 与 Codex Hook 均已启用。
4. 再次运行引导脚本，确认配置文件未被重写。

验收过程不发送飞书测试消息。真实通知由下一次正常结束的 Claude Code 或 Codex 会话验证。
