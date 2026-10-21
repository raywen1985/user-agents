# Lark Gateway 确定性 Session 路由设计

## 背景

Gateway 当前把 Session 名称、任务正文和路由动作一起交给 Claude Router 推断。对于：

```text
codex 飞书通知 方案A
```

路由器曾返回 `session_name=飞书通知方案A`，导致实际存在且空闲的 `飞书通知`
Session 未被精确命中，随后错误进入工程选择。此前围绕模糊匹配阈值、候选回复、原生
Session 发现和工程选择的局部修复，没有消除这个入口歧义。

本设计在 LLM 路由之前增加确定性命令解析和显式状态机。标准远程命令不再由模型拆分；
LLM 只处理非标准自然语言技能以及缺省新 Session 名称的短名称生成。

## 目标

- 标准命令始终按固定位置解析，Session 名和任务正文边界不受模型输出影响。
- 能精确续接 Codex Desktop 和 Claude Code 的现有原生 Session。
- Session 未找到或未指定时，使用编号完成“选择相似 Session / 新建 Session”。
- 回复消息和同聊天短时上下文可以继续既有 Session。
- Session 选择和工程选择是两个独立阶段，不共享含糊的候选对象。
- 真正忙碌的 Session 不允许并发续接，历史或 Gateway 自身状态不造成永久假忙。
- 消息重投、重复编号、进程重启和候选过期不会造成重复执行。

## 非目标

- 不允许 Session 名包含空格，也不增加引号转义语法。
- 不允许 Codex Desktop、Claude Code 和 Gateway 同时写同一个原生 Session。
- 不自动终止占用 Session 的本地进程，不删除或伪造原生锁。
- 不改变审批、停止 Session、CC Switch、语音转写等技能的业务语义。
- 不用本次改动重写 Session Catalog、Scheduler 或执行器。

## 用户命令语法

### 续接或查找

```text
<claude|codex> <session-name> <content>
```

第一个词是执行器，第二个词是无空格 Session 名，第二个词之后的非空剩余文本全部是
任务内容。例如：

```text
codex 飞书通知 方案A
```

必须解析为：

```text
executor     = codex
session_name = 飞书通知
content      = 方案A
```

### 显式新建

```text
<claude|codex> <新建|new> <session-name> <content>
```

`new` 大小写不敏感，`新建` 和 `new` 是保留关键字，不能作为 Session 名。显式新建
不会续接回复绑定的 Session；若当前消息是回复，回复 Session 只可为新 Session 提供
工程上下文。

新 Session 名必须在相同执行器下没有精确同名 Session。若已存在同名 Session，
Gateway 要求用户换一个名称，例如 `飞书通知-2`，不能用显式新建绕过同名忙碌 Session。

### 语法错误

- 缺少任务内容时，返回标准格式及一个与原消息对应的示例。
- Session 名含空格无法表达为标准命令，Gateway 不实现猜测或引号合并。
- 仅有执行器时同时缺少 Session 名和任务正文，直接返回格式错误，不创建候选状态。
- 解析器只裁掉命令各字段边界的空白，任务正文的内部内容保持不变。

“Session 未指定”只来自带有非空任务正文的自然语言 `continue` 意图，例如回复 Session
消息后发送“继续检查测试”。它不是 `codex` 或 `claude` 单独出现时的隐式语法。

## 入口优先级

入口协调层按以下顺序处理消息：

1. 检查回复消息或同聊天唯一开放状态是否绑定候选集，并处理纯数字、`上一页`、
   `下一页` 等候选操作。
2. 用确定性解析器识别显式新建或标准命令。
3. 其余文本先调用现有 Claude Router 分类为审批、查询、停止、CC Switch、继续任务等
   自然语言意图。
4. 只有 Router 明确返回带有非空正文、但没有 Session 引用的 `continue` 意图时，才按
   回复 Session、同一 `chat_id + sender_id` 的最近上下文依次补全目标。
5. Router 返回其他技能或未知意图时，不应用最近 Session，也不把消息投进项目任务。

回复绑定高于最近上下文。显式 `新建/new` 是控制命令，不续接回复 Session。若标准
命令与回复绑定 Session 的执行器或名称冲突，Gateway 返回冲突提示，不静默选择其中
一方；名称一致时按回复绑定的精确身份续接。

最近上下文有效期为 30 分钟，只在任务成功加入执行队列后更新。上下文包含 Session
身份、执行器、工程和更新时间，并严格按飞书聊天与发送者隔离。查找失败、忙碌、仅
展示候选或任务入队失败均不得更新上下文。

这里的“成功加入执行队列”定义为 Store 事务已创建状态为 `queued` 的持久化任务。
该事务同时更新最近上下文；内存 Scheduler 队列只是持久化队列的可恢复投影。进程在
事务提交后的任何时刻退出，重启后都恢复同一任务和同一上下文，不存在二者只提交一个
的窗口。

提交前先检查 Scheduler 的停止栅栏；已在停止中的 Session 不创建任务。检查后若与停止
操作发生竞态，持久化任务仍是事实来源：Scheduler 将 `SESSION_STOPPING` 视为暂缓投影，
不把任务标成失败；停止栅栏释放、Gateway 启动以及低频安全对账都会重新读取 Store 中
尚未投影的 `queued` 任务并幂等入队。任务不会因为一次内存投影失败而永久搁置。

## Session 查找规则

Session Catalog 继续聚合 Gateway、Codex 和 Claude 的 Session 与工程事实。解析后的
请求按执行器过滤，再对 Session 名进行匹配：

“身份精确匹配”和“模糊相似匹配”使用不同的规范化函数：

- 身份精确键为名称裁掉首尾空白后执行 Unicode NFC 和默认 Unicode 小写映射的结果。
- 身份精确比较保留所有内部空白、连字符、下划线、标点和全半角差异；
  `飞书通知-2` 与 `飞书通知2` 不是精确匹配。
- 候选主名称和 Session Catalog 已验证的历史别名都可产生身份精确匹配，同一候选按
  identity 去重。标准 UUID 形式的原生 Session ID 则按小写 UUID 精确匹配。
- 模糊规范化可以折叠标点或计算相似度，但其结果只能进入候选列表，永远不能触发
  无确认续接，也不能用于判断新 Session 名是否冲突。

1. **唯一精确且可续接**：重新校验原生身份和占用后直接入队，无需确认。
2. **唯一精确但忙碌**：报告忙碌，不新建替代 Session，也不展示相似候选。
3. **多个精确匹配**：只展示这些精确 Session 供编号选择；不把相似项混入，也不提供
   隐式新建。用户需要新建时发送显式 `新建/new` 命令和不同名称。
4. **没有精确匹配**：展示达到最低展示质量的相似 Session，并在列表末尾增加
   “在新 Session 中执行”。相似度只负责过滤和排序，绝不自动决定执行目标。
5. **没有相似匹配**：列表只包含“在新 Session 中执行”，仍通过同一状态机确认。

候选显示执行器、工程、Session 名、可续接状态和更新时间。忙碌或不可续接项可以显示
以解释匹配结果，但选择后仍必须重新校验，不能入队。

### 未指定目标的继续任务

Claude Router 返回带有非空正文的 `continue`，但回复和最近上下文都无法补全 Session
时，Gateway 从完整 Catalog 创建 `session-choice`：已知执行器时列出该执行器最近更新
的 Session，未知执行器时列出 Codex 和 Claude 的最近 Session，并都提供“在新 Session
中执行”。因为没有名称查询词，这些条目明确标记为“最近 Session”，不宣称是相似匹配。

用户选择现有 Session 后重新校验并入队。选择新建且执行器未知时，先进入只有 Codex
和 Claude 两项的 `executor-choice`；执行器确定后生成短 Session 名，再按新建流程解析
工程。若 Catalog 中没有现有 Session，根列表仍显示“在新 Session 中执行”，不会丢弃
原任务正文。

## 候选状态机

候选集和候选项使用显式类型：

```text
candidate_set.kind = session-choice | executor-choice | project-choice

session-choice item.kind = existing-session | create-new
executor-choice item.kind = executor
project-choice item.kind = project
```

每个候选集持久化原始消息 ID、聊天、发送者、执行器、Session 名、任务正文、类型、
候选快照、父候选集、页面版本、创建时间、过期时间和消费状态。默认有效期为 30 分钟。

候选状态为 `open`、`transitioned`、`superseded`、`consumed` 或 `expired`：

- `open` 可接受编号或翻页操作。
- `transitioned` 表示父候选集已选择下一阶段，并已关联一个子候选集。
- `superseded` 表示该列表已被同请求的刷新结果或同聊天的新请求替代。
- `consumed` 表示选择已原子提交为任务。
- `expired` 不再接受输入。

现有 `request_message_id` 的单候选集唯一约束必须迁移为父子结构：同一请求可有一个根
候选集和一个或多个替代/子步骤，每个子集通过 `parent_set_id` 关联，父集通过
`transition_set_id` 指向当前子集；替代集通过 `replaces_set_id` 和
`replacement_set_id` 双向关联。

数字选择规则：

- 优先使用飞书回复关系绑定到对应候选页面版本。
- 没有回复关系时，仅当同一聊天和发送者只有一个未过期、已成功发送且未消费的候选集，
  才允许独立发送数字，并按该候选集的当前活动页面解释。这里严格只统计
  `state='open'`、未过期且活动页面 outbox 已标记发送成功的叶子候选集；
  `transitioned`、`superseded`、`consumed` 和 `expired` 均不参与计数。
- 同类的新候选集替代旧的开放候选集，避免多个编号列表同时有效。
- 数字必须落在列表范围内，且候选集类型必须与处理器一致。
- 候选集只可原子消费一次；重复消息返回既有结果，不创建第二个任务。

每页最多显示 10 个可编号项。多个精确 Session 和工程列表支持确定性的 `上一页`、
`下一页` 文本操作；相似列表每页最多显示 9 个 Session，并始终保留第 10 个位置给
“在新 Session 中执行”。完整 Catalog 的有序候选快照随候选集持久化，并受 Catalog
自身的安全上限约束；Catalog 报告不完整或超限时不创建列表，按 `snapshot_incomplete`
保守失败，不能静默截断候选。

首次需要交互时，Store 在一个事务中创建或复用 lookup request、根候选集、首个不可变
页面和对应 outbox，并把 inbox 标记为等待选择。飞书事件写入 inbox 后、该事务开始前
退出时，Gateway 启动会重放所有未处理 inbox；事务提交后、消息发送前退出时由 outbox
恢复发送。根候选不会处于“已创建但永远没有列表消息”的状态。

每次渲染页面都创建不可变 `candidate_page`，记录候选集 ID、快照版本、页码和该页的
编号到候选 identity 映射。候选列表消息绑定 `candidate_page_id`，而不是只绑定候选集。
回复旧页面中的编号时按旧页面不可变映射解释，再复验目标；独立编号按当前活动页面解释。
翻页事务创建或复用目标页面、更新活动页面并写入页面 outbox。页面发送前崩溃由 outbox
恢复，不会出现页面已切换但消息未持久化的状态。

outbox 发送候选页面时始终复用其确定性 idempotency key。飞书返回远端 `message_id`
后，Store 用一个事务同时把 outbox 标为 `sent`、记录远端 ID、创建
`remote_message_id -> candidate_page_id` 绑定并标记该页面已成功发送。进程在远端发送
成功后、事务提交前退出时，以相同 idempotency key 重试并获得同一远端消息，再完成同一
事务；不能先标记 sent 再单独绑定页面。

候选有效期按 30 分钟无活动计算。根页面创建时给首次发送 30 分钟期限；每次候选页面
成功发送的完成事务把候选集 `expires_at` 延长到完成时间后 30 分钟。flush 在调用飞书前
检查候选仍为 `open` 且未过期；已过期页面 outbox 不发送，而是在一个事务中标记候选集
和页面 outbox 过期，并创建普通的“候选已过期，请重新发送原命令”通知。普通通知不再
绑定候选页面。这样离线超过有效期后不会向用户发送一张到达即失效的选择列表。

同请求因目标消失或身份变化而自动刷新时，Store 在一个事务中创建替代候选集和首个
页面、把旧集标记为 `superseded`、写入双向替代链接并创建 outbox。重复刷新返回同一个
替代集。不同新请求替代同聊天同发送者的旧开放列表时也原子标记旧集，但旧消息回复只
提示“已被新请求替代”，不得把旧编号解释为新请求的候选。

从 `session-choice` 进入 `executor-choice` 或 `project-choice`，以及从
`executor-choice` 进入 `project-choice` 时，Store 必须在同一事务中校验并把父集标记
为 `transitioned`、创建并关联子集及首个页面、写入子列表 outbox。若进程在发送前退出，
outbox 恢复发送；重复选择父项返回同一个子集和既有 outbox 结果。最终选择工程时，
事务内创建任务、把叶子集标记为 `consumed` 并提交根请求。任何崩溃点都不能丢失原请求
或创建第二个子集/任务。

回复提示统一为：

```text
请使用飞书的“回复”功能回复本消息中的编号；若当前聊天只有一个有效候选列表，也可直接发送编号。
```

## 新 Session 和工程选择

用户选择 `create-new` 或发送显式新建命令后，Gateway 执行以下流程：

1. 命令已有 Session 名时沿用该名称。
2. 未指定 Session 名时，使用任务正文生成简短、无空格名称；自动名称冲突时追加
   `-2`、`-3` 等最小可用序号。
3. 工程只允许从以下来源按顺序推断：请求中显式给出且在完整 Catalog 中唯一精确匹配
   的工程、回复 Session 的已验证工程、同聊天最近成功上下文的已验证工程。
4. 不使用“唯一配置工程”、最近扫描工程或其他隐式来源。上述来源缺失或不能唯一验证
   时，创建独立的 `project-choice` 候选集；显式工程无效时直接提示，不回退猜测。
5. 工程选择完成后，原始执行器、名称和任务正文保持不变，并原子创建 Session 与任务。

Session 候选和工程候选不出现在同一个编号列表中。工程候选来自完整 Session Catalog
发现的可用工程，不要求用户预先登记；配置中的工程覆盖项仍可提供别名和策略，但不是
发现 Session 的前置条件。

## 忙碌与状态变化

忙碌判断针对目标原生 Session，而不是 Codex Desktop/ChatGPT 应用是否打开：

- Gateway 的 `queued`、`running` 和 `waiting_approval` 用于展示和防止再次提交。
- 目录预检不是唯一互斥点；任务提交事务必须再次检查目标 Gateway Session 的活动任务，
  防止两个并发飞书消息都在预检空闲后排入同一 Session。
- 执行前复验忽略当前任务自身造成的 Gateway `running`，并重新检查 Codex turn、
  writer lock 或 Claude live owner。
- 不新增 Session 租约。继续使用 Scheduler 的工程串行与 Session 活动映射；Gateway
  重启时沿用 `recoverInterrupted` 将遗留的 `running/waiting_approval` 标为中断并恢复
  已持久化的排队任务。
- 原生占用由 Codex turn/writer lock 或 Claude live owner 判断；owner PID 已不存在或
  进程创建时间不符时视为失效，不得永久判忙。
- 原生恢复调用仍是最终互斥边界；预检后发生竞争时，恢复失败且不启动新 turn。

用户看到列表后状态可能变化。消费候选前必须重新构建或定点复验：

- 目标仍可续接时入队。
- 目标变为忙碌时说明占用并保留可操作的新建命令示例。
- 目标消失或身份变化时保留原任务载荷，自动刷新 Session 候选，不要求用户重输任务。
- 目录扫描不完整时保守失败并允许针对原请求重试，不能据此创建同名 Session。

## 组件边界

### 确定性命令解析器

新增无数据库依赖的纯函数模块，输入规范化后的文本，输出 `continue-or-create`、
`create-new`、`number-selection`、`page-navigation`、`invalid-command` 或
`not-command` 等带类型结果。它只
负责语法，不访问 Session Catalog，也不决定工程。

### 入口协调层

在 `gateway.mjs` 的 inbox 处理和 `ClaudeRouter.route` 之间增加协调层，集中实现回复、
数字、标准命令、最近上下文和自然语言回退的优先级。`text`、纯文本 `post` 和成功转写
的 `audio` 都进入同一个协调入口，避免不同消息类型出现不一致路由。

### Session Lookup Service

`session-lookup-service.mjs` 接收已经结构化的请求，只负责目录查询、精确/相似匹配、
候选状态转换、原生复验和提交任务。它不再从自由文本推断 Session 名或正文边界。

### Scheduler 投影

Store 中的 `queued` 任务是队列事实来源。Scheduler 提供幂等对账方法，将尚未出现在
`knownTaskIds`、内存 queue 或 active map 中的持久化任务投影到内存。该方法在任务提交
后、停止栅栏释放后、Gateway 启动时和低频安全定时器中运行。停止栅栏导致的投影拒绝
只延后任务，不改变其持久化状态；下一次对账继续处理。

### Store

在现有 `session_lookup_requests`、`session_candidate_sets` 和消息绑定基础上：

- 为候选集增加 `kind` 和完整请求载荷，或使用等价的强类型持久化结构。
- 允许同一根请求拥有父子候选集，并持久化 `parent_set_id`、`transition_set_id`、
  替代链接和 `open/transitioned/superseded/consumed/expired` 状态；迁移时移除旧的单
  候选集唯一约束。
- 为每次展示持久化不可变候选页面，并让消息绑定同时指向候选集和页面版本。
- 增加按 `chat_id + sender_id` 唯一的最近 Session 上下文表。
- 保持任务 `message_id` 唯一约束、候选原子消费和 outbox 去重；创建持久化 `queued`
  任务与更新最近上下文必须在同一个事务中完成。
- 所有继续或新建任务提交都使用 `BEGIN IMMEDIATE` 等价事务：先按消息 ID 返回已有任务，
  再解析/创建目标 Gateway Session，然后在同一事务内检查该 Session 是否已有
  `queued`、`running` 或 `waiting_approval` 活动任务；存在则不创建任务并返回 busy，
  不存在才插入任务和更新最近上下文。两个不同消息并发命中同一 Session 时只有第一个
  能提交。
- outbox 完成操作在同一事务中更新发送状态、远端消息 ID、Session 消息绑定和候选页面
  绑定；候选页面不得在绑定缺失时单独进入 sent 状态。
- inbox 保留可重放处理状态；Gateway 启动时重新处理尚未进入回复、选择或任务终态的
  入站消息，所有后续创建操作按原消息 ID 幂等。
- 数据库迁移必须兼容已有数据库；旧的开放候选集可在迁移时过期，不能被误解释为新类型。

### 名称声明迁移

现有 `session_name_claims` 使用 `(executor, project_key, compact_name)`，其 compact key
会移除标点，不能继续承担新的身份精确语义。数据库升级必须在一个迁移事务中：

1. 新建 `session_exact_name_claims`，主键为 `(executor, exact_name)`，其中 `exact_name`
   使用本设计的 trim + NFC + 小写规则；唯一性范围与用户命令一致，为同一执行器全局。
2. 枚举所有现有 Gateway Session 并按新键分组。唯一分组写入 claim；同键多 Session
   写入新的 exact-name conflict 表，不静默选择赢家，也不覆盖任何 Session。
3. 迁移完成后旧 compact claim/conflict 表不再参与读写；只有新表全部建立成功才切换
   schema 版本，失败则整体回滚。
4. 冲突键禁止显式新建和名称自动续接；现有 Session 仍可通过编号候选或完整原生 ID
   选择。用户解决冲突后才生成唯一 claim。
5. 新建提交前先用完整 Catalog 检查尚未导入 Gateway 的原生同名 Session，再在创建
   Session 的同一事务中插入全局 exact claim；唯一约束负责阻止并发同名创建。

### Claude Router

`router.mjs` 和 `resolver.mjs` 保留自然语言技能解析。标准 Session 命令不进入模型；模型
输出也不能覆盖确定性解析结果。LLM 仅可为无名称新任务生成候选名称，生成结果仍经过
无空格、安全字符、保留词和唯一性校验。

## 用户提示与恢复

错误消息必须说明发生了什么以及下一步，不使用笼统的“状态已变化，请重新发送”。例如：

```text
Session“飞书通知”正在使用中，未创建替代会话。
如需并行执行，请发送：codex 新建 飞书通知-2 <任务内容>
```

可恢复状态尽量保留原请求：候选刷新、工程重选和短暂目录失败不丢失任务正文。候选已
过期时，明确提示原请求已过期并要求重新发送原始命令；不得把编号交给自然语言路由器。

## 幂等与安全

- inbox 继续以飞书消息 ID 去重，任务表继续以消息 ID 保证一次提交。
- 候选选择消息和原请求消息均持久化，事务内消费候选、创建 Session/任务和绑定消息。
- 重复事件、重复编号、outbox 重试和 Gateway 重启只返回或补发既有结果。
- Session 身份、执行器、工程路径和原生 ID 在提交前重新校验。
- 任何不完整目录、身份冲突、排除目录或未知占用状态均保守失败。

## 测试

### 解析器单元测试

- `codex 飞书通知 方案A` 精确切分为三个字段。
- `claude new 导入优化 检查是否提交` 和中文 `新建` 均为强制新建。
- 多空白、中文正文、保留词、缺字段、空正文和非法 Session 名均有确定结果。
- 解析器不调用 LLM，任务正文内部内容不被改写。

### 优先级和上下文测试

- 回复绑定高于最近上下文；显式新建不续接回复 Session。
- 标准命令与回复 Session 冲突时返回冲突，不静默误投。
- 最近已有 Session 时发送审批、Session 查询/停止或 CC Switch 命令，仍进入对应技能，
  不会成为旧 Session 的任务正文。
- 最近上下文只对同一聊天和发送者生效，并在 30 分钟后过期。
- 只有成功入队更新上下文；忙碌、失败和展示候选不更新。
- 持久化任务与最近上下文在同一事务提交；事务提交后、内存 Scheduler 投影前崩溃，
  重启仍恢复该任务及对应上下文。
- Scheduler 预检后与停止栅栏发生竞态时，任务保持 `queued`；栅栏释放或安全对账后只被
  投影并执行一次，不会永久搁置。
- 两个不同消息并发命中同一空闲 Session 时，`BEGIN IMMEDIATE` admission 只允许一个
  任务提交，另一个返回 busy 且不更新最近上下文。

### 查找和状态机测试

- 唯一精确空闲直接入队，唯一精确忙碌只报告忙碌。
- 精确匹配只折叠首尾空白、NFC 和大小写；连字符、下划线、标点和全半角保持不同，
  `飞书通知-2` 不会直接续接 `飞书通知2`。
- 多个精确结果只列精确项；无精确结果列相似项和 `create-new`。
- 模糊匹配永远不能直接执行。
- 无回复和最近上下文的 targetless `continue` 列出最近 Session 和新建；执行器未知并
  选择新建时依次进入 `executor-choice` 和必要的 `project-choice`。
- `session-choice`、`executor-choice` 和 `project-choice` 不能相互消费。
- 回复编号和唯一开放候选集下的独立编号均可用；歧义、越界、过期和重复选择被拒绝。
- 父集为 `transitioned`、旧集为 `superseded` 时，独立编号只统计已发送页面的 `open`
  叶子集，因此多阶段选择不会被旧状态误判为歧义。
- 超过一页的精确 Session、相似 Session 和工程列表可以前后翻页，编号始终映射当前页；
  Catalog 不完整或超限时保守失败，不静默截断。
- 翻到第 2 页后回复第 1 页旧消息中的编号，仍按第 1 页不可变映射选择；无回复的编号
  按当前活动页选择。翻页事务在 outbox 发送前崩溃仍可恢复同一页面。
- 父候选转入执行器或工程子候选的事务在每个可注入崩溃点后均可恢复；重复选择返回
  相同子集，outbox 重试只发送既有页面且最终只生成一个任务。
- 目标状态变化时自动创建原子替代集；刷新各崩溃点和重复刷新均保留原正文、只产生
  一个替代集，旧页面回复不会选择替代请求中的目标。
- 根 lookup request、候选集、首页和 outbox 创建前后注入崩溃时，未处理 inbox 或
  outbox 可恢复同一个根列表，不会永久静默或创建第二个根集。
- 飞书发送候选页返回后、outbox 完成事务前注入崩溃时，相同 idempotency key 重试得到
  同一远端消息，并原子完成 sent 状态和页面绑定；不存在“消息可见但回复无法解析”。
- 候选页面 outbox 延迟超过有效期时不发送页面，只发送不带候选绑定的过期提示；在有效
  期内成功发送或翻页会从完成时刻续期 30 分钟。

### 数据迁移测试

- 旧 compact claim 中 `飞书通知-2` 和 `飞书通知2` 按新 exact key 迁移为两个声明。
- 不同工程下同执行器的真正同名 Session 迁移为一个显式 conflict，不任意保留赢家；
  名称自动续接和新建被阻止，编号或原生 ID 仍可选择现有 Session。
- 迁移中断整体回滚，重启后可幂等重试；迁移成功后旧 compact 表不再参与名称判断。
- 两个并发新建请求争用同一 executor + exact name 时只有一个 claim 和一个 Session
  提交成功，另一个得到明确同名冲突。

### 新建、幂等和忙碌测试

- 选择新建后需要时进入单独工程列表，完成后只创建一个任务。
- 显式新建遇到同执行器精确同名时要求换名；自动名称冲突追加序号。
- 同一飞书消息重复投递、重复选择和 Gateway 重启不重复执行。
- 打开或关闭 Codex Desktop 不产生永久忙碌；真实 writer/live owner 仍阻止续接。
- 当前 Gateway 任务自身的 `running` 不被当作外部原生占用；Gateway 重启会中断遗留
  运行状态，失效的原生 owner 记录不会造成永久忙碌。

### 回归测试

将以下现场失败输入加入端到端测试：

```text
codex 飞书通知 方案A
codex lark-claude 远程控制支持语音消息
```

同时回归审批、Session 查询/停止、CC Switch、语音转文字、纯文本 `post` 路由和全部
`lark-claude` Node 测试，确认入口协调层不会静默过滤其他消息类型。

## 验收标准

- `codex 飞书通知 方案A` 在存在唯一空闲 `飞书通知` 时直接续接，任务内容严格为
  `方案A`。
- 不存在精确 Session 时，用户可用一个 Session 候选列表选择相似会话或新建；需要
  选工程时再看到独立工程列表。
- 用户可用回复编号，或在同聊天只有一个有效候选集时独立发送编号。
- 30 分钟内的同聊天连续消息可沿用最近成功 Session，回复绑定可精确续接指定 Session。
- 同名忙碌 Session 不会触发替代创建；显式新建必须使用不同名称。
- Session 状态变化不会丢失任务正文，也不会产生重复任务。
- 未指定 Session 且无短时上下文时，仍可通过最近 Session/新建、执行器和工程的分步
  编号选择完成任务。
- 标准命令不调用 LLM 做字段切分，所有相关自动化和回归测试通过。
