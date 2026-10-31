# 下班操作

Windows + Node.js 24+。只针对当前 Windows 用户可识别的 Claude Code/Claude Desktop、Codex CLI/Desktop 和 OpenCode CLI/Desktop；覆盖忙碌、等待和空闲客户端，不依赖历史会话是否登记。

## 命令与结果

`node scripts/session-manager.mjs off-work` 返回只读 JSON。`--execute` 通过独立后台 worker 执行，返回报告路径；后台关闭可能结束发起调用的客户端。报告位于运行时用户目录 `~/.agents/.sessionmgr/off-work/`。部署到另一台设备无需复制状态目录，不提交设备绝对路径。

`preview` 未执行，`scheduled` 已启动后台，`completed` 表示已识别客户端退出且 Codex 锁核验通过；`partial`、`incomplete`、`failed` 均需要检查剩余项。进程数不是会话数，一个桌面客户端可能含多个辅助进程。Claude/OpenCode 仅核验进程退出，不推断不存在其他未知版本的会话锁。

## 关闭范围

依据程序产品信息、安装布局、Node/Bun 的实际 CLI 包入口判定。Codex Desktop 在部分 Windows 版本使用 `ChatGPT.exe`，通过 Codex 产品与 OpenAI 公司元数据区分普通 ChatGPT 应用。CLI 中出现一段包含“claude”的提示词不构成身份依据。

捕获目标 PID、创建时间、可执行路径、用户，以及同一快照中连续且时间顺序正确的子树；动作前在同一个原生句柄上再次核验。桌面窗口关闭前核验窗口归属。先发送正常关闭，等待 1.5 秒，剩余精确目标终止后最多共同等待 3 秒；不使用进程名批杀或 `taskkill /T`，不无限追杀重新启动的客户端。

独立后台 worker 必须握手成功且不在 Windows Job 中，才能在其调用者退出后继续核验和写报告。不能验证时拒绝执行。Gateway 自身调用不需要关闭调用者，保护其 PID 和子树；浏览器、编辑器、飞书服务同样保护。目标祖先若含这些受保护后代则保留并报告。普通终端主程序不是独立关闭目标，CLI 退出后窗口可能保留。

此操作会停止正在执行的任务。会话、文件、工作区修改保留；不保证尚未保存的输入或正在写入的工具结果完整。既不删除 Session，也不取消归档、不清理锁文件；归档/损坏等问题不会仅靠进程退出变为可续接。

## Gateway 共享入口

`scripts/off-work.mjs` 导出 `inspectOffWork`、`executeOffWork` 和 `formatOffWork`。Gateway 负责可信文字指令、消息去重、调度暂停和取消、持久结果；SessionMgr 负责系统识别、关闭、复查。不引用 Gateway 配置或数据库。

网关支持：`下班检查` / `SessionMgr 下班检查`、`下班` / `SessionMgr 下班`。必须独立发送文字，回复消息也可。包含额外任务、否定、引用、语音转写或富文本不会被解析为全局关闭；模型意图不能授权此操作。

执行期间暂停启动新任务并取消原队列。已进入查询但尚未入队的旧消息，以及执行期间收到的新任务，均不能在结束后突然执行，需重新发送。重复消息返回原结果；启动后发现中断的下班操作仅报告不确定，不重放关停，以免关闭新开的客户端。网关及监听持续运行，完成后可恢复原 Session 执行新任务。

## 安装与验证

安装完整 SessionMgr 目录；Gateway 安装器检查 `off-work.mjs`、`off-work-windows.ps1`。本地 CLI 还需要 `off-work-jobs.mjs` 与 `off-work-worker.mjs`，路径相对脚本解析。预览依赖 Windows 进程查询权限；失败明确报告，不能当成没有进程。

运行 `node --test tests/off-work.test.mjs` 验证虚构进程范围与锁判定。设置 `SESSIONMGR_TEST_OWN_PROCESS=1` 时增加原生验证，只创建并终止测试专属空闲 Node 子进程；不要把真实客户端用于自动测试。实际验收先运行只读 `off-work`，确认客户端和保留项，只有用户明确要求下班时才执行 `--execute`。
