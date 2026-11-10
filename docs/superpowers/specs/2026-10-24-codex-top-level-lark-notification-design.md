# Codex 顶层 Turn 单入口飞书通知设计

## 背景

现有 Codex 飞书通知同时由 `~/.codex/hooks.json` 的 `Stop` Hook 和
`~/.codex/config.toml` 的 `notify` 入口触发。`notify` 收到的是
`agent-turn-complete` 事件；桥接器在 `session_index.jsonl` 未命中时还会仅凭
transcript 文件存在继续发送。

实际日志已经出现 `codex-hook` 与 `codex-notify` 双入口发送，以及
`evidence=session-transcript` 的子代理 Turn 通知。子代理 transcript 中包含
`session_meta.payload.source.subagent`，但这些会话不在 `session_index.jsonl`。

本设计取代
`2026-10-16-claude-code-codex-lark-notify-reliability-design.md` 中以下规则：

- 不再保留 Codex `hooks.json` 飞书 Hook 作为兼容入口。
- 不再接受 transcript-only 会话作为发送证据。
- 不再依赖跨入口幂等来掩盖双入口，而是在配置层保证只有一个业务发送入口。

Claude Code 的通知路径和策略不变。

## 目标

- Codex 每个顶层用户请求完成后最多发送一条飞书卡片。
- 子代理、内部 Turn、临时会话和仅有 transcript 的会话不发送飞书消息。
- Codex 原生 `codex-computer-use.exe turn-ended` 通知继续保留。
- bootstrap 自动移除历史遗留的自有 Codex 飞书 Hook，且不删除未知 Hook。
- Windows 登录及每 10 分钟自检不会重新创建第二条 Codex 飞书入口。

## 非目标

- 不尝试判断整个聊天何时关闭。Codex 当前公开事件是
  `agent-turn-complete`，没有稳定的聊天关闭事件。
- 不通过助手正文、时间间隔或关键词猜测任务是否完成。
- 不改变 Claude Code 的 `Stop`、`StopFailure` 或 `Notification` 行为。
- 本次不处理 lark-cli 超时、日志轮转、token 统计性能或卡片文案。

## 方案

### 单一业务入口

Codex 飞书业务通知只从 `~/.codex/config.toml` 的 `notify` 进入
`Invoke-CodexNotifyBridge.ps1`。Codex Desktop 可在桥接器外包装官方原生通知，
形成 `codex-computer-use.exe turn-ended --previous-notify <bridge>`；该链仍视为
同一个业务入口。

`Initialize-LarkNotify.ps1` 不再向 `~/.codex/hooks.json` 添加飞书 Hook。每次
bootstrap 都停用其中由本功能拥有的 Codex `lark-notify.ps1 -Source codex`
命令，包括直接命令和可识别的编码命令。停用遵循现有安全合并边界：

- 只替换可确认由本功能拥有的 hook command。
- 自有 Hook 原位替换为现有的无副作用占位 Hook，不删除数组元素，从而保持所有
  未知 entry/hook 的索引、顺序、内容和位置相关信任不变。
- 不清理 entry、`Stop` 数组或 `hooks` 对象；entry 级 matcher 和未知元数据原样保留。
- description、未知事件、未知 Hook、permissions、plugins 和其他字段保持不变。
- 文件原本不存在时不为 Codex 创建空 `hooks.json`。
- `-CheckOnly` 只报告是否需要清理，不写文件。

### 顶层会话资格

`Invoke-CodexNotifyBridge.ps1` 的飞书分支仅接受同时满足以下条件的事件：

1. `type` 严格等于 `agent-turn-complete`。
2. `thread-id` 非空。
3. 在有界重试期间，`~/.codex/session_index.jsonl` 中存在 `id` 与
   `thread-id` 完全相等的有效 JSON 记录。

索引未命中时仅以 `non-top-level-codex-session` 跳过飞书分支。桥接器不再遍历
`~/.codex/sessions`，不再返回 `session-transcript` 证据，也不向飞书负载提供
transcript fallback 路径。

`session_index.jsonl` 是当前系统区分顶层会话和子代理的允许列表。索引读取失败、
文件暂时不存在或记录尚未落盘都采用 fail-closed 策略：在现有约 3 秒有界重试后
跳过飞书，不以 transcript 降级。下一次顶层 Turn 仍可正常发送，不阻断 Codex。

原生通知与飞书资格独立：其最低条件仅为负载是合法 JSON 且 `type` 严格等于
`agent-turn-complete`。direct bridge 对这类事件仍调用已保存的 native command，
即使 `thread-id` 为空、索引损坏或索引未命中；native-chain 中官方 native 已在
bridge 之前运行，bridge 不重复调用。因此子代理和索引未命中的 Turn 可以保留
Codex 原生通知，但绝不会进入飞书分支。

### 负载与日志

合格事件仍转换为现有 `Stop` 负载，以复用卡片格式、项目名称、耗时和 token
统计。`lark_ingress` 固定为 `codex-notify`，`transcript_path` 为空；下游可使用
`session_id` 自行解析顶层 session index 对应信息。

跳过日志记录 reason 和 thread id 的安全摘要，不记录助手正文、用户输入或完整
事件 JSON。桥接器始终退出 0，通知故障不影响 Codex Turn。

## 迁移与自恢复

首次 bootstrap 按以下顺序迁移：

1. 规划并校验 `~/.codex/config.toml` 的 bridge/native-chain 配置。
2. 成功写入并复验 native-state 与 TOML；任一步失败都保留旧 Hook 不变。
3. 新入口健康后，将 `~/.codex/hooks.json` 中本功能拥有的 Codex 飞书 Hook
   原位替换为无副作用占位 Hook。

步骤 3 写入、并发复检或原子替换失败时，bootstrap 使用步骤 2 写入后记录的内容
哈希进行 compare-and-swap 检查；仅当 TOML 仍是本次写入的版本时，才原子恢复迁移
前的 TOML。若 TOML 已被 Codex Desktop 或用户再次修改则禁止覆盖，只记录降级状态。
跨入口幂等键在迁移完成后仍保留，作为回滚失败期间的最后一道防线，确保同一
session/turn/event 的 Hook 与 notify 请求使用相同飞书幂等键。故障状态下
`Healthy=false`，计划任务下一次运行继续收敛到单入口。

只有第三项需要变更时，摘要中的 `CodexChanged=true`；健康状态要求自有 Codex
飞书 Hook 数量为 0、TOML notify 处于已知 bridge 或已知 native-chain 状态，且
direct bridge 所需的 native-state 存在、可信并与当前选定 native command 一致。
任一部分 `WouldChange=true` 时 `Healthy=false`。`-CheckOnly` 一次性规划所有部分，
但不写 native-state、TOML 或 hooks 文件。

周期任务后续不得重新创建 Codex Hook。旧客户端如果只支持 `hooks.json` 而不支持
官方 `notify`，将不再发送飞书消息；这是为保证单入口和消除重复通知接受的兼容性
取舍。

### Codex runtime 升级恢复

Codex Desktop 升级可能先删除旧 `cua_node/<hash>` runtime，再将 `config.toml` 留在
指向旧 `codex-computer-use.exe` 的 native-chain 状态。此时链的第一个进程无法启动，
bridge 不会收到事件；旧逻辑又因 native 文件不存在而把整条链视为未知配置，导致
周期自恢复持续失败。

bootstrap 将“结构可信”与“当前可执行”分开判断。仅当以下条件全部满足时，缺失
native 文件的链才可作为本功能管理的 stale chain 恢复：

1. 命令严格为四项：native 路径、`turn-ended`、`--previous-notify`、previous JSON。
2. native 文件名严格为 `codex-computer-use.exe`，规范化路径位于当前用户的
   `%LOCALAPPDATA%/OpenAI/Codex/runtimes/cua_node` 下，并匹配官方固定后缀
   `bin/node_modules/@oai/sky/bin/windows/codex-computer-use.exe`；仅缺少文件这一项。
3. previous JSON 可解析为字符串数组，且 argv 必须完整匹配两种受管形式之一：
   legacy canonical 为 `powershell.exe -NoLogo -NoProfile -NonInteractive
   -ExecutionPolicy Bypass -File <bridge>`；marked canonical 只允许在其末尾固定增加
   恰好一个 `-Chained`。不接受其他额外参数、重复 `-File`、替代宿主或仅“碰巧
   引用”同一 bridge 的自定义 wrapper。
4. 官方 runtime 根目录下存在新的可用 native 候选。候选必须通过固定官方后缀、
   合理最小长度、`MZ` PE 文件头及短间隔两次长度/写入时间稳定性校验；最新候选
   不合格时继续选择次新合格候选。

恢复时先选择最新合格 native，原子更新 native-state，再把 TOML notify 写成受管
native-chain。链内 previous bridge 增加固定 `-Chained` 开关，表示当前事件已经由
native 处理。bridge 只依据本次 argv 的 `-Chained` 开关决定是否跳过 native，不再
读取可变的全局 `config.toml` 猜测调用来源；direct bridge 不带该开关并调用
native-state。现有受管但未带标记的 legacy chain 也一次性规范化为带标记 chain；
已标记且 native 有效的 chain 保持字节与时间戳不变。
若 native-state 或 TOML 任一步失败，保留/回滚原配置，不覆盖外部并发修改。

任一结构条件不满足，或找不到新 native 时，继续以未知命令失败关闭，不覆盖配置。
有效 chain 的行为不变；其 native-state 若仍指向旧 runtime，则刷新为当前 chain
头部。`-CheckOnly` 对 stale chain 返回 `Healthy=false` 和待修复状态，但不写文件。

## 测试

### Bridge

- session index 命中的 `agent-turn-complete` 被接受并转换。
- session index 缺失、损坏、未命中时均将 Lark 标记为
  `non-top-level-codex-session`，即使存在匹配 transcript 也必须跳过。
- 伪造子代理 transcript 不触发 Lark；direct 模式仍执行一次 native，chained
  模式不重复执行 native。
- 空 thread id、索引损坏和索引未命中时，飞书跳过而 direct native 恰好调用一次；
  chained 模式不重复 native。
- 非法 JSON和非目标事件不调用 native 或飞书。
- 合格顶层事件的链式 native 行为保持现有测试覆盖。

### Bootstrap

- 新配置不创建 `~/.codex/hooks.json`，只管理 Claude hooks 与 Codex TOML。
- 旧的单个或重复自有 Codex Hook 被全部原位替换为无副作用 Hook。
- 自有 Hook 与未知兄弟 Hook 共存时，只替换自有 Hook，所有 entry/hook 索引不变。
- 带 matcher 或未知 entry 元数据的自有 Hook entry 保留全部元数据。
- 仅包含未知 Hook 的 Codex 配置字节语义保持不变。
- 清理后再次运行不改变文件内容和时间。
- `-CheckOnly` 能报告需要清理但不写文件。
- TOML 已写入后 Hook 停用写入失败时，未发生并发修改则回滚 TOML；发生并发修改则
  不覆盖外部编辑、报告不健康，并验证同一 Turn 的双入口仍生成相同幂等键。
- 链式 notify 识别、未知链拒绝和原生状态刷新测试继续通过。
- stale chain（可信旧路径已不存在、previous 精确匹配、存在新 native）可恢复，
  `-CheckOnly` 不写文件，正式运行后 marked native-chain 和 native-state 均指向
  可用实现。
- stale chain 的 native 位于可信根外、后缀不匹配、previous 未知或没有新候选时拒绝
  覆盖。有效 legacy chain 在 `-CheckOnly` 报 `WouldChange=true` 并规范化一次；有效
  marked chain 不发生额外改写。
- previous 虽引用同一 bridge，但宿主、参数数量/顺序或额外参数不符合规范时拒绝。
- 最新 native 为零字节、截断、非 PE 或仍在写入时跳过，并回退到次新合格候选。
- bridge 的 direct/chained 分支只由本次 `-Chained` argv 决定；测试在调用期间改写
  `config.toml`，证明不会造成 native 丢失或重复。

### 回归

- `test-lark-notify.ps1` 全部通过。
- `test-codex-notify-bridge.ps1` 更新后的全部断言通过。
- `test-lark-notify-bootstrap.ps1` 更新后的全部断言通过。
- 真实配置执行 bootstrap 后，Codex hooks 中自有发送路径为 0，
  `-CheckOnly` 返回健康且无待修改项。

## 验收

1. 三组通知测试通过。
2. bootstrap 先验证 TOML/native-state，再停用当前用户 Codex 自有 Hook；迁移失败时
   旧 Hook 仍可用。
3. 计划任务手动触发结果为 0，后续自检不重新创建 Hook。
4. 顶层 Codex Turn 完成后日志出现一次 `ingress=codex-notify`。
5. 子代理 Turn 日志只出现 `non-top-level-codex-session` 跳过记录，不发送飞书。

