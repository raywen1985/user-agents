# Harness 适配器契约与 OpenCode 预留

统一入口 `scripts/session-manager.mjs` 仅负责参数、JSON 输出和退出码；`harnesses.mjs` 负责目标 harness 解析、合并排序、跨 harness 候选选择及指纹命名空间。每个适配器独立处理原生存储/API、活跃探测和当前调用者身份，不能复用另一 harness 的环境变量或路径猜测。

目前注册 `claude`、`codex`。`--harness all` 表示所有已注册适配器；任一失败会保留其他列表但标记 incomplete，跨 harness 删除解析则拒绝继续，用户可明确选择单一可用 harness。all 永不直接执行删除。

项目概况、工作状态和 Gateway 复用的原生发现接口见 [共享查询接口](queries.md)。Claude 适配器的读取逻辑位于 `claude-reader.mjs`，`session-store.mjs` 保留删除与兼容导出；新适配器应同样区分只读观察和副作用操作。

## 接口

在 `adapters` 注册 `{name, list, preview, execute, previewCurrent, executeCurrent}`，方法均接收 options 并返回 Promise：

| 方法 | 责任 |
| --- | --- |
| `list(options)` | 返回 `{root, scope, currentProject, complete, warnings, unassignedCount, total, sessions}`，完整分页；不隐藏错误 |
| `preview(options)` | 名称/ID 定位，返回 not_found / selection_required / ready；模糊结果不自动选择 |
| `execute(options)` | 仅完整 ID + 最新 fingerprint；重新验证范围/活动/文件；返回 deleted / partial |
| `previewCurrent(options)` | 从本次调用运行时独立验证身份；返回 currentIdentity、confirmationFingerprint；无法证明则拒绝 |
| `executeCurrent(options)` | 复核当前身份与确认指纹，提交前再次核验；不退回普通 ID 模式绕过 |

公共 options：`root`、`scope`（默认 current）、`project`、`query`/`id`/`currentSessionId` 三选一、`expect`、`allowActive`、`allowUnknown`。需要连带删除的适配器使用 `allowDescendants`。RPC、runtimeEnv 等依赖注入仅供隔离测试，不能把伪造环境用于真实自删。

每条会话至少包含 `{id, name, project, projects, lastActiveAt, updatedAt, activity:{state, reason, owners}}`；共享层添加 `harness`。ID 的格式由适配器验证，不要求未来 harness 一定使用 UUID。显示排序使用 `byRecentActivity`，匹配用 `matchSessions`；如未来 ID 大小写敏感，须扩展匹配策略，不能套用当前忽略大小写规则。

ready 包含 `session`、`fingerprint`、`files`、`fileCount`、`localDataPresent`，可附 `targets`、`descendants`、`requiresActive`、`requiresUnknown`、`requiresDescendantConfirmation`。数量不可得时用 null。指纹应覆盖数据根/范围/精确身份/所有连带目标/活动证据/文件或原生版本。共享层额外以 harness 绑定公开 fingerprint 与 confirmationFingerprint，外部不得直接复用适配器内部指纹。

所有副作用必须限制在已证明归属的本地记录中，优先可信原生 API；未知布局、链接越界、扫描不完整必须阻止删除。实际核验错误不可报告成功。各适配器明确其并发边界和永久删除的覆盖范围。

## OpenCode 后续接入

保留键 `opencode` 的设计，目前不注册空实现，也不猜测 `ses_...` 的删除路径；调用会返回 `unsupported_harness`。

实施时先确认所装 OpenCode 版本的会话 list/get/delete API、分页、项目目录与 workspace 标识、父子会话关系，以及本次 shell 是否提供可靠当前 Session ID。使用 OpenCode 原生 Session ID，不能套用 Claude/Codex UUID 校验。数据根按其运行时配置及 XDG 规则解析，不硬编码用户路径。

若原生 delete 连带子会话，复用 targets/descendants 确认及跨项目限制；若原生仅归档，不宣称永久删除。活跃状态来自原生运行时而非文件 mtime。未找到可信的“本次会话身份”接口前，列出/明确 ID 删除可以接入，自删返回 current_session_unverified。

接入验收至少覆盖：全部分页与归档、当前项目和 all、同名/模糊选择、全局活跃排序、跨 harness 同 ID 不混淆、active/unknown 确认、resume A/B 身份、删除范围与派生树、预览过期、原生失败/部分完成、临时原生数据删除及未选中数据保留。更新 SKILL.md、帮助、兼容说明及自然语言案例后再列为已支持。
