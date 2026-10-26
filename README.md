# user-agents

`~/.agents` 是可跨设备复用的用户级 AI Coding Agent 能力仓库，集中维护共享 Skills、Agent 项目、启动健康检查、Token 统计、浏览器 MCP、飞书通知和飞书远程控制能力。

Clone 只会复制仓库文件，不会自动修改执行器配置、安装依赖或恢复认证。新设备应先审查内容，再按各模块文档安装和验收。

## 支持范围

| 能力 | Claude Code | Codex | OpenCode | DeepSeek Harness |
|---|---|---|---|---|
| 共享 Skills | 需建立链接 | 原生扫描 | 原生扫描；嵌套目录需配置 | 原生扫描；嵌套目录需配置 |
| 用户级指令 | `~/.claude/CLAUDE.md` | `~/.codex/AGENTS.md` | `AGENTS.md` / `instructions` | `$DSH_HOME/AGENTS.md` |
| AI Startup Health | 需安装；CLI | 需安装；CLI 与 Desktop | 未接入 | 未接入 |
| Chrome DevTools MCP | 需安装和配置 | 需安装和配置 | 未接入 | 未接入 |
| Windows CLI Token Meter | 需安装 | 需安装 | 未接入 | 未接入 |
| 飞书结束/中断通知 | 需配置 Hook | 需配置原生 `notify` bridge | 未接入 | 未接入 |
| 飞书远程 Session | 需部署网关 | 需部署网关 | 未接入 | 未接入 |

不同执行器的发现和配置机制不同。共享执行器接入见 [跨电脑部署手册](ai-install.md)；各可选模块必须独立安装或配置，不能把“仓库中存在”视为“已经启用”。

## 目录

```text
.agents/
|- skills/                         # 多执行器共享 Skills 与维护说明
|- claude-projects/
|  |- lark/                        # 飞书远程 Claude/Codex 网关
|  `- study/                       # AI 应用学习资料、路线和进度
|- startup-health/                 # Claude/Codex 非阻塞启动健康检查
|- token-meter/                    # Claude/Codex 单轮 Token 与费用统计
|- hooks/                          # Claude Hook、Codex notify bridge 与通知 Bootstrap
|- tools/
|  `- chrome-devtools-mcp/         # 共用的固定版本浏览器 MCP 依赖
|- docs/                           # 设计与实施记录
|- AGENTS.md                       # 本仓库的 Agent 维护规则
|- ai-install.md                   # 共享执行器接入手册
|- LARK-AGENT-GATEWAY-GUIDE.md     # 飞书网关使用与运维手册
`- .skill-lock.json                # 部分上游 Skill 的安装记录
```

## 新设备部署

### 1. Clone

目标目录必须不存在或为空；已有 `~/.agents` 时先人工合并或备份。

```powershell
$AgentsRoot = Join-Path $env:USERPROFILE '.agents'
git clone https://github.com/raywen1985/user-agents.git $AgentsRoot
```

### 2. 审查仓库与本机配置

- 检查 Git 状态、最近提交和将要运行的脚本。
- 复核 `lark-notify.json` 等账号相关配置，不要把其他人的标识直接用于当前账号。
- 不要把其他设备生成的绝对路径复制到本机配置。
- 确认 App Secret、Token、Cookie、认证缓存、二维码和 `.env` 未进入 Git。

### 3. 接入执行器

按 [跨电脑部署手册](ai-install.md) 接入实际使用的执行器。只合并必要字段，不覆盖已有登录、权限、插件、MCP 或 Hook 配置。

### 4. 按需安装模块

- AI Startup Health：[安装、激活与回滚](startup-health/README.md)
- Chrome DevTools MCP：[依赖、客户端配置与验收](tools/chrome-devtools-mcp/README.md)
- Token Meter：[安装、指标和历史查询](token-meter/README.md)
- 飞书通知：先运行 `hooks/Initialize-LarkNotify.ps1 -CheckOnly`，审查结果后再按需安装 `hooks/Install-LarkNotifyBootstrapTask.ps1`
- 飞书远程网关：[配置、安装与使用](claude-projects/lark/README.md)

### 5. 验收

- 在每个已接入的执行器中新建 Session，确认预期 Skills 和用户指令可见。
- 对每个已安装的可选模块执行其 README 中的测试或验收步骤。
- 验证本机生成的路径只存在于 Git 忽略的本地状态或本地覆盖配置中。
- 使用 `git status --short` 确认安装过程没有意外改写可复用配置或写入凭据。

## 核心模块

### 共享 Skills

`skills/` 是多个执行器复用的 Skill 单一真实源。每项能力以自己的 `SKILL.md` 为 Agent 入口；来源边界、目录约定和维护流程见 [Skills 维护说明](skills/README.md)。

### AI 应用学习

`skills/ai-application-learning/` 提供面向资深程序员的 AI 应用学习能力，`claude-projects/study/` 保存路线、资料、模板和进度。它支持约 30 分钟的主题学习、带日期和来源的前沿速览，以及工作、生活和亲子教育场景实践；只有用户明确确认后才保存学习记录。详见 [学习工程说明](claude-projects/study/README.md)。

### AI Startup Health

`startup-health/` 为 Claude Code CLI、Codex CLI 和 Codex Desktop 提供非阻塞、告警型启动检查，覆盖 Token Meter、飞书通知、飞书网关、Chrome DevTools MCP、本地模型代理、运行时依赖和客户端配置完整性。

它默认只检查和告警，不安装依赖，也不阻塞客户端启动。经过预检、真实激活证据和显式启用后，自动启动能力也只限于策略中固定的飞书网关计划任务。详见 [AI Startup Health](startup-health/README.md)。

### Token Meter

`token-meter/` 在 Windows 上记录 Claude Code 和 Codex 的单轮 Token 使用量，并基于本地价格表估算费用。估算结果不是供应商账单；安装、指标语义、价格覆盖和历史查询见 [Token Meter 说明](token-meter/README.md)。

### Chrome DevTools MCP

`tools/chrome-devtools-mcp/` 保存 Claude Code 和 Codex 共用的固定版本依赖清单。它可以在用户明确启用 Chrome 远程调试后附着现有标签页；不会因为 Clone 仓库而自动获得浏览器控制权。详见 [Chrome DevTools MCP 说明](tools/chrome-devtools-mcp/README.md)。

### 飞书通知

`hooks/lark-notify.ps1` 处理通知内容。Claude Code 通过 Hook 调用，Codex 通过 `Invoke-CodexNotifyBridge.ps1` 接入原生 `notify`，仓库自有的旧 Codex 通知 Hook 会在迁移时被禁用，避免重复发送。

安装 `LarkNotifyBootstrap` 计划任务后，系统会在 Windows 用户登录时及每 10 分钟检查并修复这两条配置链。该机制不恢复 lark-cli 登录、应用权限或任何凭据。

### 飞书远程网关

`claude-projects/lark/` 通过飞书私聊创建或续接 Claude Code 与 Codex Session。它支持确定性 Session 名称路由、候选选择、短时上下文、语音消息、活动 Session 查询、基于不透明停止 ID 的精确停止，以及 CCSwitch 状态和已观察用量的只读查询。

网关不会把消息中的任意路径直接当作工作目录，不会用模糊名称自动选择 Session，也不会把 CCSwitch 查询扩展为配置或 Provider 管理。安装和完整安全边界见 [网关说明](claude-projects/lark/README.md)，日常运维见 [飞书远程控制手册](LARK-AGENT-GATEWAY-GUIDE.md)。

## 可移植配置

- 可复用文件使用仓库相对路径、`~/.agents`、`~/.claude`、`~/.codex` 或环境变量，不提交用户名、盘符或机器专用绝对路径。
- 运行时确实需要绝对路径时，由安装器从当前设备环境发现并验证，再写入 Git 忽略的本地状态或 `*.local.json` 覆盖文件。
- 飞书网关的可复用基础配置可跟踪；本机执行器路径和工程策略写入 `gateway.local.json` 与 `projects.local.json`。
- 私密学习资料、认证信息、运行数据库、日志、PID、缓存、临时文件和本地价格覆盖不得提交。
- 修改绝对路径需求时，必须同时更新相应安装、迁移和验收步骤。

## 更新与验收

```powershell
$AgentsRoot = Join-Path $env:USERPROFILE '.agents'
git -C $AgentsRoot status --short
git -C $AgentsRoot pull --ff-only
```

更新后：

1. 审查变更，尤其是脚本、执行器配置投影、安装器和可跟踪基础配置。
2. 新增顶层 Skill 时重新执行 Claude Code 的 Skill 链接步骤，并新建执行器 Session。
3. 依赖锁、Hook、通知 Bridge、Startup Health Provider 或网关发生变化时，按对应模块文档重新安装或复验。
4. 不使用 `git reset --hard` 覆盖本机状态，不在未审查来源时运行仓库脚本。

## 文档

- [共享执行器跨电脑部署](ai-install.md)
- [Skills 维护说明](skills/README.md)
- [AI 应用学习工程](claude-projects/study/README.md)
- [AI Startup Health](startup-health/README.md)
- [Chrome DevTools MCP](tools/chrome-devtools-mcp/README.md)
- [Windows CLI Token Meter](token-meter/README.md)
- [飞书远程控制使用与运维](LARK-AGENT-GATEWAY-GUIDE.md)
- [飞书网关配置、安装与开发说明](claude-projects/lark/README.md)
