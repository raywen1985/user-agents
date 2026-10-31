# Claude Code 本地数据范围

默认在运行时解析 `CLAUDE_CONFIG_DIR` 或 `os.homedir()/.claude`。所有可删除目标都从该根目录内的已知布局推导，不使用历史文件中的 `fullPath`、`cwd` 等字段作为删除路径。拒绝目录中的符号链接和 Windows junction，避免越界。Claude 文件历史中的普通硬链接可以处理：只 unlink 目标路径，不原地改写共享内容，其他链接保留；共享历史和索引也通过替换目标目录项更新。

## 列表与名称

列表、查询、删除预览和执行统一使用 `--scope current|all`，默认 `current`。当前项目由调用进程的工作目录或 `--project` 决定，采用目录精确匹配，不自动推断 Git 根目录或包含子目录。优先解析真实路径以兼容项目目录链接，Windows 比较忽略大小写，统一路径分隔符与末尾斜杠。`--root` 仅选择 Claude 数据根目录，不决定当前项目。

项目归属来自日志 `cwd`、索引 `projectPath` / `originalPath`、共享历史 `project` 和运行时 `cwd`。没有这些路径信息的会话仅在全部项目范围展示；不反向猜测有歧义的编码目录名。底层仍聚合已知存储布局，再按项目路径过滤返回值，因此其他位置的扫描异常也会体现在 `complete` 和警告中。

当前范围无结果时不自动扩大。预览指纹绑定范围和当前项目，执行时再次校验。`projects` 保留历史工作目录供展示和发现，执行过 `cd` 不代表记录存放在多个项目。删除守卫使用 `projectDirs` 与 `recordProjects`：优先索引的 `projectPath/originalPath`，无索引归属时使用每个原生日志最初的工作目录；仅剩共享历史/注册记录时保守沿用其项目证据。同 ID 出现在多个项目目录，或存储归属在当前项目之外，仍返回 `cross_project_session`。错误信息分别给出记录归属与历史观察路径；只有用户明确要求才改为全部项目。

聚合 `projects/<project>/<uuid>.jsonl`、同项目的 UUID 目录、`sessions-index.json`、根目录 `history.jsonl` 和 `sessions/*.json`，以完整 UUID 合并同一 Session。子代理日志保留在父 Session 下，不作为独立用户会话列出。没有日志的历史条目、活跃注册条目仍可出现在列表中。仅剩已退出进程的过期注册信息时，不再作为会话展示；只剩活跃注册信息时，预览会标注没有本地数据可删。

标题来源：活跃注册信息中的 `name`、`<uuid>/custom-title.json` 中的 `customTitle`、日志中的 `custom-title` 记录、项目索引标题、日志摘要、首条用户输入。标题文件与运行时名称取更新时间较新的来源；已过期的运行时名称不覆盖持久标题。日志扫描使用流式读取，不读取工具输出作为名称。

精确匹配忽略大小写，先匹配完整 ID，再匹配完整显示名称。其他情况按名称或 ID 的子串、名称中的有序字符、相似拼写查找，返回候选，绝不自动把最高分当删除目标。

所有列表与候选统一按 `lastActiveAt` 降序、完整 ID 升序排序，未知时间置后；匹配分数只决定是否入选，进程是否仍存活不改变时间排序。最近活跃时间取日志中 user/assistant/system 事件、共享历史、项目索引及运行时活动记录的最新时间；运行时优先使用 `lastActiveAt` / `lastActivityAt`，其次是 `statusUpdatedAt`、`updatedAt`、`startedAt`。没有上述时间才回退到文件更新时间，因此复制文件或只修改标题不会盖过已知活动时间。原 `updatedAt` 字段保留用于兼容。

## 永久删除

| 位置 | 行为 |
| --- | --- |
| `projects/<project>/<id>.jsonl` | 删除完整会话日志 |
| `projects/<project>/<id>/` | 删除该会话标题、子代理日志、工具结果等全部附件；逐文件验证后删除 |
| `file-history/<id>/`、`session-env/<id>/`、`tasks/<id>/` | 删除此 ID 的专属数据 |
| `todos/<id>-agent-*.json`、`debug/<id>.txt` | 删除已知旧版会话文件 |
| `history.jsonl` | 仅移除 `sessionId` 精确相等的行，保留其他行原始文本 |
| `projects/<project>/sessions-index.json` | 仅移除 `entries[].sessionId` 精确相等的条目，保留其他属性和条目 |
| `sessions/*.json` | 只用于读取活跃状态，保留运行时注册信息 |

不会删除项目源码、`memory`、共享设置、凭据、插件、无法证明属于该 ID 的计划/粘贴缓存/shell snapshot、外部网关数据库、备份、Git 历史或云端副本。因此这里的“永久删除”指上述本地记录直接删除且不提供恢复，并非安全擦除或所有副本清除。

## 活跃状态

Windows 使用 PID 与注册记录中的进程创建时间（FILETIME）校验，避免把复用 PID 误当原会话。注册中的 `idle` 仍算活跃。其他平台检查 PID 是否存在；如果存在但无法校验启动身份，保守视为活跃，可能产生误报。没有可用注册信息时标注未发现活跃进程；读取或探测失败则为 `unknown`。

不会结束进程或删运行时注册文件。确认删除活跃 Session 后，运行中的进程仍可能重新写入文件；列表也可能继续显示其注册信息。需要稳定消失时，先退出目标 Session，再删除。

## 一致性与版本变化

预览列出精确路径并生成内容指纹，执行时重新扫描、验证路径与指纹、重新检查活跃状态。共享历史和索引在替换前检查是否被修改，再进行同目录原子替换。脚本只锁定本工具的并发删除，Claude 自身不遵守这个锁，因此无法承诺跨进程事务；执行过程中新增内容会导致拒绝、部分完成或在结果中报告残留。需要最强一致性时先退出会写入相关记录的 Claude 进程。

`--current-session auto` 从当前 Claude Code shell 工具继承的 `CLAUDE_CODE_SESSION_ID`、`CLAUDE_PID` 读取本次身份，再读取该 PID 的 `sessions/<pid>.json`，核对 Session ID、PID 与存活进程的启动标识。Windows 使用 FILETIME，Linux 使用 `/proc/<pid>/stat` 的 starttime；其他平台无法证明启动身份时拒绝自删。没有登记、信息损坏、进程已退出或 PID 复用同样拒绝。这个流程不接受技能文本中的缓存 UUID、旧对话或长期驻留 MCP 服务的启动环境作为证明。

`--current-session <UUID>` 在相同核验后还要求显式 UUID 等于当前运行时 UUID；不一致返回 `current_session_mismatch`，不能改成普通 `--id` 绕过。`resume A → resume B` 后，auto 只能解析 B，显式传入 A 必须被拒绝。自删预览额外返回 `currentIdentity` 和 `confirmationFingerprint`，绑定 ID、根目录、范围、当前项目、活跃状态、注册进程及实际调用方身份。预览与执行之间切换会话或更换进程会使确认失效，执行扫描后、写入前也重新核验调用方。普通日志追加不改变这一确认指纹。

自删执行先校验确认指纹，再在同一个命令中取得并使用最新的文件 `fingerprint`，复用普通删除的路径、文件哈希、共享索引及并发检查。若状态未知，仍须同时显式确认 `--allow-unknown`。该模式不忽略执行期间的文件变化，也不持续重试；完成后仍标注 `runtimeStillActive: true`，提醒本会话后续消息可能重新生成记录。普通 ID/名称删除的指纹与确认规则不变。

未知索引结构、损坏的共享 JSON、越界或链接路径会阻止删除。日志损坏行会产生扫描警告，不会执行其中的文本。升级 Claude 后先运行列表和预览确认布局；不猜测未知文件的归属。
