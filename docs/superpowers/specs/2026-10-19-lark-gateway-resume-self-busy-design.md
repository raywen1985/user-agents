# Lark Gateway 续接任务自我判忙修复设计

## 问题

Gateway 续接已绑定原生 Codex Session 时，Scheduler 会先把 Gateway Session 更新为
`running`，然后执行器才调用 `revalidateGatewaySession`。当前会话目录把 Gateway
的 `queued`、`running`、`waiting_approval` 与原生 Codex 的 `inProgress`、writer
lock 合并成同一个 `candidate.busy` 字段。续接复验因此把当前任务自己设置的
`running` 误认为外部占用，并在调用 `thread/resume` 前失败：

```text
执行失败：原生 Codex Session 正在使用中。
```

现场探针显示目标原生 thread 的 writer lock 为 `missing`，证明本次失败不是原生
Codex Desktop 或其他进程持锁。

## 目标

- Gateway 管理的任务可以续接其已绑定的 Codex 原生 Session。
- 当前任务自身的 Gateway `running` 状态不参与原生占用判断。
- 原生 turn 仍为 `inProgress` 或 writer lock 被持有时，继续拒绝续接。
- 保留会话身份、原生 ID、工程目录、排除目录和目录完整性校验。
- 不允许两个原生 writer 同时写入同一 Codex Session。

## 方案

将“目录展示状态”和“执行前原生所有权校验”分离：

1. `buildSessionCatalog` 继续聚合 Gateway 与原生状态，供候选列表、活动查询和新任务
   路由判断使用；现有 `candidate.busy` 语义不变。
2. `revalidateGatewaySession` 继续通过完整目录确认 Gateway Session 与原生 Session
   的身份映射、执行器和工程目录一致。
3. 执行器已经由 Scheduler 串行调度当前工程，因此复验不再依据聚合后的
   `candidate.busy` 拒绝当前任务；该字段可能包含当前任务自身的 `running`。
4. 身份和工程校验通过后，始终调用 `revalidateNativeCandidate`。由它重新读取原生
   元数据，并以 `latestTurn.status` 和 writer lock 作为原生占用的唯一依据。
5. 原生探针返回 `held` 或 turn 为 `inProgress` 时仍返回 `busy`；探针不完整、身份
   变化或工程变化时继续保守失败。

该方案不改变候选选择阶段的忙碌拦截，也不通过删除锁文件或终止进程绕过原生所有权。

## 数据流

```text
飞书任务入队
  -> Scheduler 将当前 Gateway Session 标记为 running
  -> CodexExecutor 请求续接前复验
  -> 校验 Gateway/native 身份映射与工程目录
  -> 忽略聚合状态中由当前任务产生的 Gateway running
  -> 重新读取原生 turn 状态并探测 writer lock
     -> 原生空闲：thread/resume
     -> 原生占用：返回 busy
     -> 数据不完整或身份变化：保守失败
```

## 测试

在 `lark-claude/test/session-catalog.test.mjs` 增加或调整以下回归用例：

- Gateway Session 为 `running`、原生 turn 已完成且 writer lock 为 `missing` 时，
  `revalidateGatewaySession` 返回成功。
- 同样场景下 writer lock 为 `held` 时返回 `busy`。
- 原生 turn 为 `inProgress` 时返回 `busy`。
- 原生 ID 缺失、工程目录变化、目录扫描不完整时仍按原有原因失败。
- 候选查询阶段的 Gateway busy 聚合保持不变，避免用户向真正执行中的 Session
  再次提交任务。

运行全部 `lark-claude` Node 测试，确认新建、候选选择、Claude 续接和停止 Session
行为没有回归。

## 非目标

- 不支持 Codex Desktop 与 Gateway 同时写同一个原生 Session。
- 不删除 writer lock，不自动终止 Codex Desktop 或 Codex CLI 进程。
- 不修改语音消息功能及当前工作区中的相关未提交改动。
- 不增加忙碌任务的自动等待或重试队列。

## 验收

- 通过 Gateway 创建并绑定过原生 Codex thread 的会话，在上一轮结束后可以再次续接。
- 续接不会因为当前任务自身的 Gateway `running` 状态失败。
- 原生 Session 被其他 writer 实际占用时仍显示“原生 Codex Session 正在使用中”。
- 所有相关自动化测试通过，语音消息文件不被本修复改动。
