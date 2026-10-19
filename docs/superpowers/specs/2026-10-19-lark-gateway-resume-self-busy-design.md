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
Codex Desktop 或其他进程持锁。`revalidateGatewaySession` 同时服务于 Codex 和
Claude 执行器，因此同一自我判忙缺陷也适用于已绑定原生 Claude Session 的续接。

## 目标

- Gateway 管理的任务可以续接其已绑定的 Codex 或 Claude 原生 Session。
- 当前任务自身的 Gateway `running` 状态不参与原生占用判断。
- 原生 turn 仍为 `inProgress` 或 writer lock 被持有时，继续拒绝续接。
- 保留会话身份、原生 ID、工程目录、排除目录和目录完整性校验。
- Gateway 不绕过原生执行器的最终互斥，不允许在原生占用校验失败后启动 turn。

## 方案

将“目录展示状态”和“执行前原生所有权校验”分离：

1. `buildSessionCatalog` 继续聚合 Gateway 与原生状态，供候选列表、活动查询和新任务
   路由判断使用；现有 `candidate.busy` 语义不变。
2. `revalidateGatewaySession` 继续通过完整目录确认 Gateway Session 与原生 Session
   的身份映射、执行器和工程目录一致。候选必须满足
   `candidate.gatewayId === session.id` 且 `candidate.capability === "ready"`；多个
   Gateway Session 指向同一原生 ID 时继续以 `identity_conflict` 失败。
3. 执行器已经由 Scheduler 串行调度当前工程，因此复验不再依据聚合后的
   `candidate.busy` 拒绝当前任务；该字段可能包含当前任务自身的 `running`。
4. 身份和工程校验通过后，始终调用 `revalidateNativeCandidate`。Codex 重新读取
   `latestTurn.status` 并探测 writer lock；Claude 重新验证 transcript 身份并探测
   live owner。它们是 Gateway 执行前判断原生占用的依据。
5. 原生探针返回占用或 Codex turn 为 `inProgress` 时仍返回 `busy`；探针不完整、
   身份变化或工程变化时继续保守失败。
6. 预检与真正恢复之间存在竞争窗口。最终互斥由原生 `thread/resume` 或 Claude
   `--resume` 的原子所有权获取保证；若外部 writer 在窗口内抢先占用，原生恢复必须
   失败，Gateway 不得继续启动 turn。Gateway 不删除或伪造原生锁，也不另建一套与
   原生执行器互不识别的 reservation。

该方案不改变候选选择阶段的忙碌拦截，也不通过删除锁文件或终止进程绕过原生所有权。

## 数据流

```text
飞书任务入队
  -> Scheduler 将当前 Gateway Session 标记为 running
  -> CodexExecutor 请求续接前复验
  -> 校验精确 Gateway ID、无身份冲突、native 映射与工程目录
  -> 忽略聚合状态中由当前任务产生的 Gateway running
  -> 按执行器重新检查原生 turn/owner 和 writer lock
     -> 原生预检空闲：调用原生 resume 并原子获取所有权
        -> 获取成功：启动 turn
        -> 竞争失败：报告占用，不启动 turn
     -> 原生占用：返回 busy
     -> 数据不完整或身份变化：保守失败
```

## 测试

在 `lark-claude/test/session-catalog.test.mjs` 增加或调整以下回归用例：

- Gateway Session 为 `running`、原生 turn 已完成且 writer lock 为 `missing` 时，
  `revalidateGatewaySession` 返回成功。
- 同样场景下 writer lock 为 `held` 时返回 `busy`。
- 原生 turn 为 `inProgress` 时返回 `busy`。
- 多个 Gateway Session 指向同一 native ID，或候选 Gateway ID 与当前 Session 不同
  时，以 `identity_conflict` 或 `stale_target` 失败。
- Gateway 已绑定的 native ID 在完整目录中找不到对应原生记录、工程目录变化或目录
  扫描不完整时，仍按原有原因失败；没有绑定 native ID 的新会话不走续接复验。
- 候选查询阶段的 Gateway busy 聚合保持不变，避免用户向真正执行中的 Session
  再次提交任务。
- 原生占用在预检成功后、`thread/resume` 前发生竞争时，resume 失败且不会发送
  `turn/start`。
- Claude Gateway Session 为 `running` 且没有 live owner 时复验成功；存在经过进程
  创建时间校验的 live owner 时返回 `busy`。

运行全部 `lark-claude` Node 测试，确认新建、候选选择、Claude 续接和停止 Session
行为没有回归。

## 非目标

- 不支持 Codex Desktop 与 Gateway 同时写同一个原生 Session。
- 不删除 writer lock，不自动终止 Codex Desktop 或 Codex CLI 进程。
- 不修改语音消息功能及当前工作区中的相关未提交改动。
- 不增加忙碌任务的自动等待或重试队列。

## 验收

- 通过 Gateway 创建并绑定过原生 Codex thread 或 Claude Session 的会话，在上一轮
  结束后可以再次续接。
- 续接不会因为当前任务自身的 Gateway `running` 状态失败。
- 原生 Session 被其他 writer 实际占用时仍显示“原生 Codex Session 正在使用中”。
- 重复 Gateway 映射不会因移除聚合 busy 检查而被放行。
- 预检后的原生占用竞争由原生恢复拒绝，Gateway 不启动 turn。
- 所有相关自动化测试通过，语音消息文件不被本修复改动。
