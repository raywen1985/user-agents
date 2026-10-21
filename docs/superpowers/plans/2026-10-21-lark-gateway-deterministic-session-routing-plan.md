# Lark Gateway 确定性 Session 路由实施计划

## 约束

- 以 `docs/superpowers/specs/2026-10-21-lark-gateway-deterministic-session-routing-design.md` 为实现依据。
- 保留工作区中现有的语音、纯文本 `post`、审批和原生 Session 自我判忙改动。
- 每个阶段先补失败测试，再做最小实现；不提交或回退无关工作区改动。
- 标准命令解析不调用 LLM，所有数据库迁移兼容现有 Gateway 数据库。

## 任务 1：确定性命令解析与精确名称语义

涉及文件：

- 新增 `lark-claude/src/session-command-parser.mjs`
- 修改 `lark-claude/src/session-name-match.mjs`
- 新增 `lark-claude/test/session-command-parser.test.mjs`
- 修改 `lark-claude/test/session-name-match.test.mjs`

实施内容：

1. 实现 `<executor> <session-name> <content>` 和 `<executor> <新建|new> <session-name> <content>` 的位置解析。
2. 区分 identity exact key 与 fuzzy normalization；精确键保留标点、连字符、下划线和全半角差异。
3. UUID 原生 Session ID 使用独立精确匹配路径；模糊结果不再自动执行。
4. 覆盖缺字段、保留词、正文空白和 `飞书通知-2`/`飞书通知2` 回归测试。

验证：

```powershell
node --test test/session-command-parser.test.mjs test/session-name-match.test.mjs
```

## 任务 2：Store 状态模型和迁移

涉及文件：

- 修改 `lark-claude/src/store.mjs`
- 修改 `lark-claude/test/session-lookup-store.test.mjs`
- 新增或修改 Store 迁移测试文件

实施内容：

1. 迁移全局 `(executor, exact_name)` 名称声明和冲突表，停用旧 compact-name 读写。
2. 扩展 lookup request，增加强类型父子/替代候选集、不可变候选页面和页面消息绑定。
3. 增加同聊天同发送者的 30 分钟最近 Session 上下文。
4. 原子实现根候选创建、父子转换、刷新替代、翻页、候选消费和 outbox 创建。
5. 原子实现任务 admission、持久化 queued 任务、最近上下文更新和重复消息返回。
6. 原子完成 outbox sent、远端消息 ID、Session 绑定和候选页面绑定。
7. 保留未处理 inbox 的可重放状态，迁移时安全过期旧开放候选。

验证：

```powershell
node --test test/session-lookup-store.test.mjs test/store*.test.mjs
```

## 任务 3：Session Lookup 状态机

涉及文件：

- 修改 `lark-claude/src/session-lookup-service.mjs`
- 修改 `lark-claude/src/session-catalog.mjs`
- 修改 `lark-claude/test/session-lookup-service.test.mjs`
- 修改 `lark-claude/test/session-catalog.test.mjs`

实施内容：

1. 实现唯一精确空闲直接续接、唯一精确忙碌拒绝、多个精确只列精确项。
2. 无精确结果时列相似 Session 和 `create-new`；无名称时列最近 Session 和新建。
3. 实现 `session-choice -> executor-choice -> project-choice` 的分阶段状态转换。
4. 实现不可变页面回复、独立编号、翻页、状态重新校验和原子替代刷新。
5. 新建名称生成后做全局精确冲突检查；工程只从显式、回复或最近上下文推断。
6. 候选 TTL、延迟 outbox 过期和可恢复错误提示符合规格。

验证：

```powershell
node --test test/session-lookup-service.test.mjs test/session-catalog.test.mjs
```

## 任务 4：入口协调与 Router 收敛

涉及文件：

- 新增 `lark-claude/src/message-coordinator.mjs`
- 修改 `lark-claude/src/gateway.mjs`
- 修改 `lark-claude/src/resolver.mjs`
- 修改 `lark-claude/test/gateway.test.mjs`
- 新增 `lark-claude/test/message-coordinator.test.mjs`

实施内容：

1. 在 Claude Router 前处理候选操作和标准命令。
2. 其余自然语言先分类，仅对 targetless `continue` 应用回复/最近 Session。
3. 显式新建不续接回复 Session；标准命令和回复目标冲突时明确拒绝。
4. `text`、纯文本 `post` 和语音转写统一进入协调层。
5. Gateway 启动时重放未处理 inbox，所有处理按消息 ID 幂等。
6. 保持审批、停止 Session、CC Switch 和内部技能路由不受最近上下文影响。

验证：

```powershell
node --test test/message-coordinator.test.mjs test/gateway.test.mjs test/voice.test.mjs
```

## 任务 5：Scheduler 持久化队列投影

涉及文件：

- 修改 `lark-claude/src/scheduler.mjs`
- 修改 `lark-claude/src/gateway.mjs`
- 修改或新增 `lark-claude/test/scheduler.test.mjs`

实施内容：

1. 增加从 Store `queued` 任务到内存 queue 的幂等对账。
2. 在提交后、停止栅栏释放后、启动时和低频安全定时器运行对账。
3. `SESSION_STOPPING` 只暂缓投影，栅栏释放后继续；任务不会永久搁置。
4. 覆盖双消息 admission、停止竞态、重启恢复和只执行一次测试。

验证：

```powershell
node --test test/scheduler.test.mjs test/stop-agent-session.test.mjs
```

## 任务 6：完整回归与文档同步

涉及文件：

- 修改 `lark-claude/README.md`
- 根据失败测试修正上述模块，不做无关重构

实施内容：

1. 加入现场回归：`codex 飞书通知 方案A` 和 `codex lark-claude 远程控制支持语音消息`。
2. 回归回复编号、独立编号、语音、`post`、审批、停止 Session、CC Switch 和原生续接。
3. README 更新标准格式、`新建/new`、短时上下文、两阶段选择、忙碌与故障提示。
4. 运行全量测试并检查仅预期文件发生变化。

验证：

```powershell
npm test
git diff --check
```
