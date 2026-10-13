# Claude Code / Codex 飞书通知卡片设计

## 目标

把 Claude Code 和 Codex 的会话通知从纯文本升级为飞书 Card 2.0，在手机和桌面端兼顾快速扫读与排查信息。两种来源共用版式与语义色，标题、事件解析和统计解析按来源动态切换。

## 状态与配色

卡片根据 Hook 事件选择语义色：

| 状态 | 触发条件 | Header 颜色 | 标签 |
| --- | --- | --- | --- |
| 完成 | `Stop` | `green` | 完成 |
| 失败 | `StopFailure` | `red` | 失败 |
| 等待操作 | `Notification` 且类型为 `permission_prompt`、`idle_prompt` 或 `agent_needs_input` | `orange` | 待处理 |
| 普通 | 保留的默认视觉态；本次不新增生产事件类型 | `default` | 通知 |

普通通知不使用蓝色强调。颜色只表达状态，同一卡片不混用无关主色。本次保留现有事件过滤：Claude Code 只发送 `Stop`、`StopFailure` 和三种需要操作的 `Notification`；Codex 只发送已通过现有持久会话过滤的完成事件。普通态仅用于构造器默认分支和未来兼容，不扩大当前通知范围。

## 信息结构

使用 Card 2.0、`default` 宽度，无按钮和服务端回调。

### Header

- 标题：`会话已完成`、`会话失败`、`等待你的操作` 或 `通知`。标题不包含来源，保持单行显示。
- 副标题：`<来源> · <项目显示名> · <会话显示名>`；来源为 `Claude Code` 或 `Codex`。项目显示名最多保留 12 个 Unicode 文本元素，会话显示名最多保留 20 个 Unicode 文本元素；超出时分别保留前 11/19 个并追加 `…`，不得拆分组合字符或代理项。副标题保持单行；390px 等窄屏允许飞书从“项目 · 会话”尾部区域做原生省略，不保证会话名完整可见。来源、项目和会话只在副标题出现，避免与标题、指标或折叠详情重复。
- Header 的原生 `text_tag_list` 依次放置状态标签与时间标签。状态标签为完成、失败、待处理或通知，沿用对应语义色；时间标签使用本地时间 `HH:mm` 和 `neutral` 配色，位于列表末尾，因此显示在主标题行最右侧。时间不再出现在副标题或正文中。

### Body

1. 结果摘要高亮块
   - 完成：标签为“执行结果”。
   - 失败：标签为“失败原因”。
   - 等待操作：标签为“需要确认”。
   - 普通：标签为“消息”。
   - 完成态只显示一句短结果，例如“已完成通知卡片调整”或“已修复飞书卡片发送”。短结果从完整执行结果的首个非空文本句提取，移除开头的 Markdown 标题、列表符号和多余空白；已以“已完成、已修复、已新增、已更新、已实现、已调整、已移除、已解决、已优化、已配置、已支持”之一开头时原样保留，否则前缀“已完成：”。短结果最多保留 40 个 Unicode 文本元素，超出时保留前 39 个并追加 `…`。
   - 失败和等待操作状态不套用完成态改写，继续在高亮块中展示关键错误或操作要求。
   - 所有摘要继续使用现有脱敏；不增加来源前缀，也不增加“请展开详细信息查看项目目录与会话上下文”等提示性填充。
2. 关键指标
   - 耗时
   - Token
   - 命中率
   - 花费
   - 四项指标使用一个紧凑的四列 `column_set`：`flex_mode: "none"`、`horizontal_spacing: "small"`；每个 `column` 使用 `width: "weighted"`、`weight: 1`、`padding: "4px 2px"`、`vertical_spacing: "2px"`。标签使用 `div` 的灰色 `notation` 单行文本，数值使用 `div` 的 `normal` 单行文本，两者均居中并设置 `lines: 1`。不得使用会在窄屏堆叠增高的 `stretch`。
   - 耗时使用紧凑格式：`42s`、`4m43s`、`1h23m`；超过一小时省略秒。Token、命中率和花费继续使用现有紧凑格式。四个值在 390px 宽度下均须保持单行，不得重叠或被裁切。
   - 指标区不再显示项目，项目只保留在副标题和折叠详情的完整目录中。
   - 卡片统一收紧垂直空间：body padding 为 `8px 12px 12px 12px`，结果摘要块 padding 为 `8px`，顶级非末尾区块下间距为 `8px`；折叠详情仍为末尾区块且默认收起。
3. 默认折叠的“详细信息”
   - 完成态的完整执行结果；使用脱敏后的原始描述，不应用短结果截断
   - 完整目录
   - Hook 事件类型
   - 不显示会话名；会话名只保留在副标题

## 指标定义

- `耗时`：当前 turn 的开始时间到最后一个结果事件时间。Claude Code 使用首条顶层用户消息到末条顶层助手消息；Codex 使用匹配 `turn_id` 的首个 turn 事件到末个 turn 事件。时间戳缺失或顺序无效时显示 `--`。
- `Token`：`effective_input_tokens + generated_output_tokens`。数值用紧凑格式显示，例如 `464k`、`7.71M`；没有 provider-reported 数据时显示 `--`。
- `命中率`：`cache_read_tokens / effective_input_tokens * 100`，显示整数百分比；分母为零或数据不可用时显示 `--`。
- `花费`：先用 `Get-ClaudeTurnRecord` 或 `Get-CodexTurnRecord` 取得只读记录，再调用 `Get-TMEstimatedCost`；绝不调用 `Save-TMTurnRecord`。仅当成本状态为 `estimated` 时显示 `total_usd`，例如 `$0.0327`，否则显示 `--`。

这些数值是本地估算和 transcript 派生值，不作为供应商账单。

## 数据流

1. Claude Code 或 Codex 把 Hook JSON 写入通知脚本的 stdin。
2. 通知脚本保留现有事件过滤、脱敏和会话名解析；先把本地路径或 `file://` URI 统一规范化为本地绝对路径，再交给会话校验、耗时解析和 token-meter。
3. 根据来源从 transcript 计算耗时，并调用 token-meter 对应的只读解析逻辑获取本轮指标，不重复写 history。Token 和命中率仅接受 `PROVIDER_REPORTED` 或 `DERIVED_REPORTED` 质量的数据。
4. 生成 Card 2.0 JSON，使用 `lark-cli im +messages-send --msg-type interactive --content <json>` 发送。

通知脚本不得依赖 token-meter 的 Stop Hook 已先执行。Hook 可能并发，因此统计数据必须直接从 transcript 计算，不能依赖 history 的写入时序。

## 幂等规则

- Codex 的 `event_identity` 优先使用 `turn_id`；Claude Code 优先使用 `prompt_id`，缺失时使用 `Get-ClaudeTurnRecord` 返回的逻辑 `turn_id`。
- 如果上述 ID 均不可用，`event_identity` 为 `SHA256` 对 `source`、`session_id`、规范化 transcript 路径、`event`、`notification_type`、脱敏摘要组成的规范字段序列求得的十六进制值；禁止使用随机 GUID。
- `seed` 始终由 `source`、`session_id`、`event_identity`、`event`、`notification_type` 组成。规范字段序列按固定顺序把每个字段编码为 UTF-8 的 `十进制字节长度:字段值`，字段之间不加可歧义的自由分隔符。事件名和通知类型始终参与，因此同一 Claude `prompt_id` 的等待通知和后续完成通知不会碰撞。
- 卡片键为 `SHA256(seed + "|card")` 的前 40 位，纯文本回退键为 `SHA256(seed + "|fallback")` 的前 40 位。相同输入在飞书一小时幂等窗口内必须生成相同键。
- 并发或重试不得改变键。

## 降级与错误处理

- transcript 或 token-meter 不可用：仍发送卡片，对应指标显示 `--`。
- Card 2.0 本地构造/验证失败：没有发出卡片请求，直接使用 fallback key 发送现有纯文本通知。
- 所有发送命令显式使用 `--format json` 并解析 typed envelope。仅当进程非零退出、JSON 可解析为 `ok:false`，且 `error.type` 为 `validation`、`api` 或 `authorization` 时，判定为明确未发送；记录具体错误，然后使用 fallback key 发送现有纯文本通知。
- 进程启动失败、超时、输出为空或非 JSON、`error.type` 为网络/transport 类，或任何未知 `error.type`，都判定为结果不明确。卡片可能已被服务端接受，为避免重复通知，不发送纯文本回退，只记录失败供排查。
- 卡片和纯文本都失败：记录最终失败；Hook 仍返回 `{}`，不阻断 Claude Code 或 Codex。
- Claude Code 与 Codex 使用相同降级策略。
- Card 2.0 正文完整显示要求飞书/Lark 客户端版本不低于 7.20；旧客户端只显示 Header 属于客户端能力限制，服务端成功响应无法触发自动纯文本回退。

## 测试

- PowerShell 单元测试覆盖三个当前可达状态的“事件过滤 -> 状态映射”端到端路径、卡片根结构、来源无关的单行标题、按“来源 · 项目 · 会话”排序的副标题、项目/会话 Unicode 安全截断、保留的普通默认态中性色和摘要精简。
- 覆盖 Header 原生 `text_tag_list` 的顺序：语义色状态标签在前，`neutral` 时间标签在后；断言时间格式为 `HH:mm`，并且副标题和正文不重复时间。
- 覆盖完成态短结果的已识别状态动词保留、缺少状态动词时补“已完成：”、Markdown 前缀清理、首句提取、40 个文本元素截断和脱敏；断言完整执行结果仅出现在折叠详情。覆盖失败和等待操作状态不被完成态规则改写。
- 覆盖折叠详情不再包含会话字段，仍包含完整目录和 Hook 事件类型；非完成态不在主摘要与详情中重复相同描述。
- 覆盖四列紧凑指标区的顺序、`flex_mode`、等权列、标签字号/颜色/单行限制、数值字号/单行限制、间距和 padding，以及项目字段已移除、`消耗 Token` 已更名为 `Token`。
- 覆盖紧凑耗时格式的秒、分钟和小时边界；使用最大预期值 `1h23m`、`7.71M`、`100%`、`$123.4567` 验证四列值不产生第二行。
- 覆盖 Token 紧凑格式、命中率、USD 成本、耗时及不可用占位符。
- 覆盖 JSON 特殊字符、长摘要、Windows 路径和 `file://` URI。
- 覆盖 Claude Code 与 Codex 卡片发送参数、本地构造失败回退，以及 `validation`、`api`、`authorization` typed envelope 后单次文本回退；表驱动覆盖启动失败、超时、空输出、畸形 JSON、网络/transport 和未知错误类型均不回退。
- 覆盖缺少 token-meter 模块、transcript 缺失/损坏/写入不完整、价格表缺失/损坏时仍发送卡片且统计显示 `--`，并断言通知解析不写 token history。
- 覆盖卡片与文本都失败时仍输出 `{}` 且退出码为 0。
- 覆盖相同输入重试和并发调用时 card/fallback key 稳定；同一 Claude `prompt_id` 先发 `Notification` 再发 `Stop` 时两个 card key 必须不同。保留现有 Codex 内部目录、未持久会话和文件 URI 过滤测试。
- 耗时 fixture 覆盖 Claude 多 turn、sidechain、Codex 同一 `turn_id` 多事件、缺失时间戳及结束时间早于开始时间。
- 使用合成 Hook 输入执行 `-DryRun`，验证 Card JSON 可解析。
- 经用户确认后向现有接收人发送一条测试卡片，验证飞书实际渲染。

## 已批准视觉稿

本地预览：`C:\Users\Administrator\.codex\visualizations\2026\10\10\01a12464-5a18-7fd2-bb52-fbf1e583088a\lark-header-time-preview-standalone.html`

已批准“原生标签”方案：保留 Card 2.0 原生 Header，在状态标签后追加中性时间标签。实现验证必须覆盖桌面端和 390px 宽度，并使用最大预期指标值、12 个文本元素的项目名和 20 个文本元素的会话名（含中英文、CJK 和 emoji）。通过标准是：标题一行；状态与时间标签位于标题行右侧且时间在最右；副标题按来源、项目、会话排序并保持单行，空间不足时允许飞书从“项目 · 会话”尾部区域原生省略，但不得换行或与标签重叠；四个指标标签和值各一行；无文本重叠或裁切；详细信息默认折叠且不重复会话名。
