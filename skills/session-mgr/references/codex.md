# Codex 适配器

通过本机 `codex app-server` 的 JSON-RPC 接口管理持久化会话。官方接口说明：<https://developers.openai.com/codex/app-server/>。当前实现已用本机 CLI 0.164.0 的生成 schema 与临时数据验证；其他版本须具备下列方法及字段，缺失时返回错误，不推测替代布局。

## 连接与列表

- 使用统一 `resolveCodexExecutable()`，依次选择 `--codex-bin`、`CODEX_APP_RUNTIME_CLI_PATH`、PATH 中的 `codex`。Windows 同时解析 `.exe/.com/.cmd/.bat`，同目录优先原生程序；npm 启动脚本经本机 `ComSpec`（或 `SystemRoot/System32/cmd.exe`）启动，关闭 delayed expansion 并逐参数引用，保留空格及特殊字符。启动独立 `app-server --stdio` 辅助进程，运行时传入选定的 `CODEX_HOME`。可显式 `--server-socket` 连接已有本地服务的 proxy；用户应确认它使用同一数据根。
- PATH 正常时无需设置兜底变量；`codex_not_found` 与 `codex_start_failed` 分别表示未找到、已找到但启动失败。测试探测复用同一解析器，只能在确实未找到时跳过原生测试；安装损坏或方法不兼容应测试失败。设备迁移时在本机重新解析路径，不提交机器专属绝对路径。
- 初始化声明 `experimentalApi: true`。不执行 turn/start、thread/resume、模型请求或服务端审批；关闭时只结束本工具启动的辅助进程。
- `thread/list` 用完全部游标，分别读取 `archived: false/true`，包含所有模型提供方。列表包括 cli、vscode、exec、appServer、unknown 来源的主会话；子代理属于关联数据。
- 规范化原生 `id`、`name`、`preview`、`cwd`、`path`、`parentThreadId`、`sessionId`、`status`。名称优先 `name`，否则首条输入 `preview`；活动时间优先 `recencyAt`，回退 `updatedAt`、`createdAt`（原生秒时间戳）。不以复制后的文件 mtime 排序。
- `cwd` 精确匹配当前项目，规范化真实路径并在 Windows 忽略大小写。无可靠项目路径的记录仅在 all 范围展示。`id` 是删除对象；`sessionId` 可能是父级会话树，不可互换。

`list/delete` 始终使用 app-server；`overview/active` 的发现模块使用只读 SQLite。overview 以 state.threads 的用户记录为全集，名称索引只补名，不作为枚举全集。默认排除 `thread_source=guardian_review/subagent`，`thread_source` 缺失的旧记录仅接受 cli/vscode/exec/appServer/unknown 等已知用户来源；缺少验证所需列时报不完整。普通与已归档用户会话均保留，不能把内部子会话标成独立可续接目标。

## 预览与删除

使用原生 `thread/delete {threadId}`，不直接修改 SQLite。Codex 的 state、history、queue、goals 等数据库存在内部关联，原生接口负责其持久化数据清理。`thread/archive` 不等于永久删除，不作为替代方案。

原生删除会包含该 thread 的 spawned descendants。预览对 `ancestorThreadId` 查询全部普通/归档记录和子代理来源；展示完整 targets、descendants 并按活动时间排序。独立 fork 不因 `forkedFromId` 相同而当作派生子代理。需要用户确认连带目标（`--allow-descendants`）；当前项目范围中出现其他项目的子会话时拒绝。

原生字段无法提供子会话名称时，预览从 `session_index.jsonl` 的最新同 ID 标题补名；仍缺失时，从已验证身份的 rollout 前缀读取首条用户输入或代理标签，最后才显示 `(unnamed)`。名称只用于展示与指纹，不改变删除身份或范围。

已知 rollout 必须处于数据根的 `sessions/` 或 `archived_sessions/` 下，逐路径拒绝 symlink/junction，并核对第一行 `session_meta.payload.id`。不要使用 `payload.session_id` 作为 thread ID。预览指纹绑定 harness、root、项目范围、目标和子会话身份、活动状态、元数据及文件哈希。

执行重新预览并校验指纹，再发一次原生删除。成功后重新完整列出普通/归档/子代理记录、读取目标及检查已知 rollout 是否消失。`thread not loaded` 本身不能证明已删除；核验必须结合列表和文件。失败或残留返回 `partial`；断连或超时可能发生在原生提交之后，只读复查，不自动重发。

`fileCount` / `deletedFiles` 仅统计已知 rollout 文件，不代表原生清理的全部存储对象。`sharedRecordCount: null` 表示原生内部记录数未知。删除不承诺清除桌面 UI 缓存、备份、Git 历史、第三方数据库、云端副本或安全擦除磁盘。技能不清理无法证明归属的文件。

原生方法没有“仅在此指纹仍成立时删除”的条件参数。预览与提交之间仍存在并发窗口，尤其有新派生线程时；需要稳定删除范围应先让会话及其派生任务停止写入。技能会在提交前重查，但不能声称是跨进程事务。

## 活跃与当前会话

原生状态 `active`、`idle` 都算活跃；`notLoaded` 仅说明此服务未加载。对另一个进程，检查 `thread-writer-locks/<id>.lock`：Windows 被持有的独占锁读取返回 EBUSY，标记 active；文件不存在或可读取且未被持有时标记 inactive。其他平台存在 advisory lock 时保守 unknown；无法访问/未知状态也为 unknown。锁文件不删除、不改写。

`--current-session` 要求本次原生 shell 环境的 `CODEX_THREAD_ID`、`CODEX_SESSION_ID`、`CODEX_TOOL_CALL_ID`。再以 `thread/read` 核对 thread/tree ID、验证本地 rollout 和活跃 writer。没有可信证据拒绝自删，不能用最新或唯一活跃目标代替。传入 UUID 必须等于当前 thread；恢复 A 再 B 后不能沿用 A 的 ID/确认。

自删 `confirmationFingerprint` 绑定身份、范围、活动状态与连带目标，允许同一身份的普通日志追加；执行使用同次最新文件指纹，提交前再次核验身份。所有自删须另行活跃确认。独立辅助服务可能无法删除其他服务正在使用的线程；用户授权不绕过原生拒绝，也不代表可以结束该进程。此时退出目标后从另一会话按明确 ID 删除。不能验证 writer 的平台/旧版本同样拒绝自删，普通名称/ID 工作流仍可用。
