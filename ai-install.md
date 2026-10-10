# `.agents` 跨电脑部署手册

本文用于在另一台电脑 clone 用户级 `.agents` Git 仓库后，将其中的能力接入 Claude Code、Codex、OpenCode 和 DeepSeek Harness。

适用路径：

```text
Windows: C:\Users\<UserName>\.agents
macOS/Linux: ~/.agents
```

本文重点是用户级能力。项目仓库自己的 `<repo>/.agents`、`AGENTS.md` 和 `CLAUDE.md` 仍应随各项目单独部署。

## 1. 能力范围

`.agents` 是能力资产的单一真实源，但四个执行器的发现机制不同，clone 完成不等于所有能力已经生效。

| 能力 | Claude Code | Codex | OpenCode | DeepSeek Harness |
|---|---|---|---|---|
| `skills/*/SKILL.md` | 需要链接到 `~/.claude/skills` | 原生读取 `~/.agents/skills` | 原生读取 `~/.agents/skills` | 原生读取 `~/.agents/skills` |
| 共享指令/规则 | `CLAUDE.md`、`.claude/rules` | `~/.codex/AGENTS.md` | `~/.config/opencode/AGENTS.md` 或 `instructions` | `$DSH_HOME/AGENTS.md` |
| `hooks/lark-notify.ps1` | 支持 | 支持 | 当前未接入 | 当前未接入 |
| `lark-claude` 远程网关 | 可作为执行器 | 可作为执行器 | 当前不支持 | 当前不支持 |

原则：

- `.agents` 中的 Skill 保持一份，不复制出多份源码。
- 优先使用符号链接或 Junction；更新 Git 后能力同步更新。
- 不删除、不覆盖执行器目录中已有的非空真实目录。
- 配置文件采用“合并”，不要用仓库模板覆盖目标电脑的现有用户配置。
- Git 仓库不应包含登录令牌、App Secret、API Key 或运行时数据库。

## 2. 部署前准备

### 2.1 安装所需工具

至少安装 Git，以及实际要使用的执行器：

```powershell
git --version
claude --version
codex --version
opencode --version
dsh --version
```

未使用的执行器可以不安装。DeepSeek Harness 的安装命令：

```powershell
npm install -g @deepseek-ai/dsh
```

飞书能力还需要 Node.js 24+ 和 lark-cli：

```powershell
node --version
npm install -g @larksuite/cli
lark-cli --version
```

### 2.2 Windows 链接方式

Windows 推荐顺序：

1. 已启用“开发者模式”时使用 `SymbolicLink`。
2. 未启用开发者模式时使用目录 `Junction`。

Junction 不需要管理员权限，但只能用于目录。本文的 Skill 接入脚本默认使用 Junction。

## 3. Clone 或更新 `.agents`

### 3.1 首次 Clone

目标目录必须不存在或为空。不要直接覆盖已有 `.agents`。

```powershell
$AgentsRoot = Join-Path $env:USERPROFILE ".agents"
$AgentsRepository = "<YOUR_.AGENTS_GIT_REPOSITORY_URL>"

if (Test-Path -LiteralPath $AgentsRoot) {
    $ExistingItems = Get-ChildItem -LiteralPath $AgentsRoot -Force
    if ($ExistingItems.Count -gt 0) {
        throw "$AgentsRoot 已存在且非空，请先人工合并或改名备份。"
    }
}

git clone $AgentsRepository $AgentsRoot
```

不要把示例 URL 原样执行，先替换为实际仓库地址。

### 3.2 后续更新

```powershell
$AgentsRoot = Join-Path $env:USERPROFILE ".agents"
git -C $AgentsRoot status --short
git -C $AgentsRoot pull --ff-only
```

若 `status` 显示本地修改，先人工确认并提交或暂存，不要使用 `reset --hard` 覆盖。

### 3.3 Clone 后先检查

```powershell
$AgentsRoot = Join-Path $env:USERPROFILE ".agents"

Test-Path (Join-Path $AgentsRoot "skills")
Get-ChildItem (Join-Path $AgentsRoot "skills") -Directory
Get-ChildItem $AgentsRoot -Force
```

应至少看到 `skills` 和本文件 `ai-install.md`。`hooks`、`lark-claude` 是否存在取决于仓库包含的能力。

## 4. 接入 Claude Code

Claude Code 不原生扫描 `~/.agents/skills`，需要把每个用户级 Skill 链接到 `~/.claude/skills`。

### 4.1 创建 Skill Junction

以下脚本幂等执行：正确链接会跳过；已有真实目录或同名错误链接不会删除，只会警告。

```powershell
$AgentsSkills = Join-Path $env:USERPROFILE ".agents\skills"
$ClaudeSkills = Join-Path $env:USERPROFILE ".claude\skills"

New-Item -ItemType Directory -Path $ClaudeSkills -Force | Out-Null

$SkillDirectories = Get-ChildItem -LiteralPath $AgentsSkills -Directory |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "SKILL.md") }

foreach ($SkillDirectory in $SkillDirectories) {
    $LinkPath = Join-Path $ClaudeSkills $SkillDirectory.Name
    $Existing = Get-Item -LiteralPath $LinkPath -Force -ErrorAction SilentlyContinue

    if ($null -ne $Existing) {
        if ($Existing.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            $ExistingTarget = (@($Existing.Target) -join ";")
            if ($ExistingTarget -ieq $SkillDirectory.FullName) {
                Write-Host "SKIP correct link: $LinkPath"
            } else {
                Write-Warning "SKIP wrong link: $LinkPath -> $ExistingTarget"
            }
        } else {
            Write-Warning "SKIP non-link path: $LinkPath"
        }
        continue
    }

    New-Item -ItemType Junction -Path $LinkPath -Target $SkillDirectory.FullName | Out-Null
    Write-Host "LINK $LinkPath -> $($SkillDirectory.FullName)"
}
```

每次 Git 更新新增 Skill 后重新执行即可。

### 4.2 嵌套 Skill

Claude Code 默认只发现 `~/.claude/skills/<name>/SKILL.md`。若仓库中出现：

```text
~/.agents/skills/<domain>/<name>/SKILL.md
```

需要为该 Skill 单独创建链接，并使用 `SKILL.md` frontmatter 的 `name` 作为链接目录名：

```powershell
New-Item -ItemType Junction `
    -Path "$env:USERPROFILE\.claude\skills\<skill-name>" `
    -Target "$env:USERPROFILE\.agents\skills\<domain>\<name>"
```

链接名错误会导致 Skill 无法发现或与其他 Skill 冲突。

### 4.3 Rules 和用户指令

如果仓库存在 `~/.agents/rules`，且 `~/.claude/rules` 不存在，可链接整个目录：

```powershell
$AgentsRules = Join-Path $env:USERPROFILE ".agents\rules"
$ClaudeRules = Join-Path $env:USERPROFILE ".claude\rules"

if ((Test-Path $AgentsRules) -and -not (Test-Path $ClaudeRules)) {
    New-Item -ItemType Junction -Path $ClaudeRules -Target $AgentsRules | Out-Null
}
```

若 `~/.claude/rules` 已经是非空真实目录，不要删除；改为逐项链接或人工合并。

如果仓库提供用户级 `CLAUDE.md`，将其内容合并到 `~/.claude/CLAUDE.md`。Claude Code 支持 `@path` 导入，但其他三个执行器不展开 `@path`，因此跨执行器共用的关键规则应写成自包含正文。

### 4.4 Claude 验收

启动一个新 Claude Code 会话：

- `/skills`：确认 `.agents` 中的 Skill 已出现。
- `/context`：确认预期的 `CLAUDE.md` 和 rules 已加载。

已打开的会话可能缓存旧能力；链接完成后应新建或重启会话。

## 5. 接入 Codex

Codex 原生递归扫描以下位置，无需为 Skill 建链接：

```text
~/.agents/skills
<repo>/.agents/skills
```

### 5.1 用户级指令

Codex 用户级指令入口是：

```text
~/.codex/AGENTS.md
```

如果 `.agents` 仓库包含共享 `AGENTS.md`，将其正文合并到 `~/.codex/AGENTS.md`。不要只写 `@~/.agents/...`，Codex 不展开 Claude 风格的 `@path` 导入。

项目指令继续使用各项目中的 `AGENTS.md`，并可在子目录放置更具体的 `AGENTS.md`。

### 5.2 Codex 验收

```powershell
codex debug prompt-input
```

检查输出是否包含预期 Skill 路径和 `AGENTS.md` 正文。不要只确认出现了 `@path` 字符串。

## 6. 接入 OpenCode

OpenCode 原生扫描用户级：

```text
~/.agents/skills
~/.claude/skills
~/.config/opencode/skills
```

当前仓库中的顶层 Skill 无需额外复制。

### 6.1 用户级配置位置

```text
Windows: C:\Users\<UserName>\.config\opencode\opencode.json
macOS/Linux: ~/.config/opencode/opencode.json
```

若文件已经存在，合并字段，不要整体覆盖。

### 6.2 指令与嵌套 Skill

示例：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "instructions": [
    "AGENTS.md",
    ".agents/instructions/*.md",
    ".agents/rules/*.md"
  ],
  "skills": {
    "paths": [
      ".agents/skills/game"
    ]
  }
}
```

说明：

- 项目根的 `opencode.json` 使用项目相对路径最稳定。
- `skills.paths` 填目录，不要填 `SKILL.md` 文件或文件 glob。
- OpenCode 默认只扫一层 Skill；嵌套领域目录需要加入 `skills.paths`。
- OpenCode 要求 `SKILL.md` 的 `name` 与可见技能目录名一致。
- 用户级共享指令入口可使用 `~/.config/opencode/AGENTS.md`；关键规则应自包含。

### 6.3 OpenCode 验收

- 在会话内执行 `/skills`。
- 询问一个只存在于共享 instructions/rules 中的问题，确认规则已加载。

## 7. 接入 DeepSeek Harness

DeepSeek Harness 命令名为 `dsh`。默认情况下，它会从 `~/.agents/skills` 发现用户级 Skill。

### 7.1 指令入口

默认用户级入口：

```text
~/.dsh/AGENTS.md
```

若设置了 `DSH_HOME`，则入口为：

```text
$DSH_HOME/AGENTS.md
```

把共享指令正文合并到该文件。DeepSeek Harness 不展开 Claude 风格的 `@path` 导入。

### 7.2 嵌套 Skill

先查询当前版本 Schema：

```powershell
dsh --profile <profile-name> --dump-config-schema
```

然后在对应 `cordis.patch.yml` 中按 Schema 配置 `customSkillDirs`。常见结构如下，但应以本机 Schema 为准：

```yaml
'@deepseek-ai/dsh-skill-filesystem':
  customSkillDirs:
    - .agents/skills/game
'@deepseek-ai/dsh-agent-instructions':
  maxBytes: 200000
```

配置位置通常为：

```text
~/.dsh/cordis.patch.yml
~/.dsh/profiles/<profile-name>/cordis.patch.yml
```

### 7.3 DeepSeek Harness 验收

```powershell
dsh --profile <profile-name> --dump-config
dsh --profile <profile-name> "列出你当前能看到的所有 Skill"
```

## 8. 可选：安装飞书通知 Hook

该仓库的 `hooks/lark-notify.ps1` 当前只支持 Claude Code 和 Codex。OpenCode、DeepSeek Harness 尚未接入此 Hook。

### 8.1 前置条件

1. 安装并配置 lark-cli。
2. 在目标电脑重新完成飞书应用配置和授权。
3. 检查 `~/.agents/lark-notify.json` 中的接收人和发送身份。
4. 不要从 Git 仓库读取或提交 App Secret、Token。

`lark-notify.json` 模板：

```json
{
  "recipientOpenId": "<TARGET_USER_OPEN_ID>",
  "identity": "bot",
  "summaryLength": 300
}
```

`open_id` 不是访问令牌，但属于用户标识；新电脑或新飞书账号部署时必须复核。

首次配置：

```powershell
lark-cli config init --new
lark-cli auth status --json --verify
```

### 8.2 Claude Hook

把 Hook 合并进 `~/.claude/settings.json`，不要覆盖现有 `env`、permissions 或其他 hooks。当前通知策略：

- `Stop`：会话结束。
- `StopFailure`：会话失败。
- `Notification`：仅 `permission_prompt|idle_prompt|agent_needs_input`。

Hook 命令中的用户目录必须改成目标电脑的实际绝对路径。

需要合并的 Claude Hook 片段：

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"C:\\Users\\<UserName>\\.agents\\hooks\\lark-notify.ps1\" -Source claude",
            "timeout": 30
          }
        ]
      }
    ],
    "StopFailure": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"C:\\Users\\<UserName>\\.agents\\hooks\\lark-notify.ps1\" -Source claude",
            "timeout": 30
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "permission_prompt|idle_prompt|agent_needs_input",
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"C:\\Users\\<UserName>\\.agents\\hooks\\lark-notify.ps1\" -Source claude",
            "timeout": 30,
            "async": true
          }
        ]
      }
    ]
  }
}
```

### 8.3 Codex Hook

把 `Stop` Hook 合并进 `~/.codex/hooks.json`。

不要注册 Codex `PermissionRequest` 飞书通知：该事件会在自动审核前触发，不代表会话真的停住等待用户响应，会产生多余通知。通知脚本本身也会防御性忽略该事件。

`~/.codex/hooks.json` 最小模板：

```json
{
  "description": "User-level completion notification hook.",
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"C:\\Users\\<UserName>\\.agents\\hooks\\lark-notify.ps1\" -Source codex",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

如果目标电脑已经存在 `hooks.json`，只合并 `Stop`，不要覆盖其他 Hook。

### 8.4 Hook 验收

```powershell
$TestRoot = Join-Path ([System.IO.Path]::GetTempPath()) `
    ("lark-notify-deployment-test-" + [guid]::NewGuid().ToString("N"))
$TestCodexHome = Join-Path $TestRoot ".codex"
$TestSessionId = [guid]::NewGuid().ToString()
$TranscriptDirectory = Join-Path $TestCodexHome "sessions\deployment-test"
$TranscriptPath = Join-Path $TranscriptDirectory "rollout-$TestSessionId.jsonl"
$PreviousCodexHome = $env:CODEX_HOME

try
{
    New-Item -ItemType Directory -Path $TranscriptDirectory -Force | Out-Null
    Set-Content -LiteralPath $TranscriptPath -Value "{}" -Encoding UTF8
    $env:CODEX_HOME = $TestCodexHome

    # 已持久化的正式会话，应输出完整的 Turn finished 消息。
    $PersistentPayload = @{
        hook_event_name = "Stop"
        session_id = $TestSessionId
        session_name = "部署测试"
        transcript_path = $TranscriptPath
        cwd = (Get-Location).Path
        last_assistant_message = "Hook 部署测试"
    } | ConvertTo-Json -Compress

    $PersistentPayload | powershell.exe -NoProfile -ExecutionPolicy Bypass `
        -File "$env:USERPROFILE\.agents\hooks\lark-notify.ps1" `
        -Source codex `
        -DryRun

    # 未持久化的后台 Turn，应只输出 {}。
    $BackgroundPayload = @{
        hook_event_name = "Stop"
        session_id = "deployment-test-background"
        cwd = (Get-Location).Path
        last_assistant_message = '{"suggestions":[]}'
    } | ConvertTo-Json -Compress

    $BackgroundPayload | powershell.exe -NoProfile -ExecutionPolicy Bypass `
        -File "$env:USERPROFILE\.agents\hooks\lark-notify.ps1" `
        -Source codex `
        -DryRun
}
finally
{
    $env:CODEX_HOME = $PreviousCodexHome
    Remove-Item -LiteralPath $TestRoot -Recurse -Force
}
```

`-DryRun` 只打印，不发送飞书消息。

## 9. 可选：安装飞书远程 Claude/Codex 网关

网关目录：

```text
~/.agents/lark-claude
```

它支持飞书自然语言控制 Claude/Codex 独立 Session，不支持 OpenCode 或 DeepSeek Harness。

完整步骤见：

```text
~/.agents/LARK-AGENT-GATEWAY-GUIDE.md
```

目标电脑必须重新完成以下配置：

1. `lark-claude/config/gateway.json` 中的用户 `open_id`、模型和四个可执行文件绝对路径。
2. `lark-claude/config/projects.json` 中的项目绝对路径和别名。
3. lark-cli Bot 配置。
4. Claude/Codex 登录或模型代理。

验证并安装：

```powershell
Set-Location "$env:USERPROFILE\.agents\lark-claude"
npm test
./scripts/install-task.ps1
npm run status
```

## 10. 一次性验收清单

| 序号 | 检查项 | 预期 |
|---|---|---|
| 1 | `git -C ~/.agents status` | 仓库可正常读取，无意外密钥文件 |
| 2 | Claude `/skills` | 列出 `.agents` 顶层 Skill |
| 3 | Claude `/context` | 加载预期用户规则 |
| 4 | `codex debug prompt-input` | 出现 Skill 路径与自包含指令正文 |
| 5 | OpenCode `/skills` | 列出用户级 Skill |
| 6 | DSH 列出 Skill | 列出用户级 Skill |
| 7 | Hook `-DryRun` | 结束事件有消息，Codex PermissionRequest 返回 `{}` |
| 8 | `npm test` | 飞书网关测试全部通过 |
| 9 | `npm run status` | `listenerReady: true`、事件消费者为 1 |

## 11. 更新与回滚

### 更新

```powershell
$AgentsRoot = Join-Path $env:USERPROFILE ".agents"
git -C $AgentsRoot pull --ff-only
```

更新后：

1. 重新运行 Claude Skill Junction 脚本，以接入新增顶层 Skill。
2. 新建执行器会话，避免旧会话缓存。
3. 若 `hooks` 或 `lark-claude` 有变化，重新执行对应验收。

### 回滚

使用 Git 切换到已确认的提交或 tag 后重新验收。不要删除执行器中已有的非空真实目录，也不要用未知来源的配置覆盖登录信息。

## 12. 常见问题

### Claude 看不到 Skill

- 检查 `~/.claude/skills/<name>` 是否为 Junction/SymbolicLink。
- 检查目标是否为 `~/.agents/skills/<name>`。
- 检查目标目录是否直接包含 `SKILL.md`。
- 新建 Claude 会话后再执行 `/skills`。

### Codex 看得到 Skill，但规则没有生效

Codex 原生扫描 Skill，但用户规则必须进入 `~/.codex/AGENTS.md`。`@path` 不会展开，入口文件必须包含正文。

### OpenCode 或 DeepSeek Harness 缺少嵌套 Skill

这两个工具默认只扫描一层。分别配置 `skills.paths` 或 `customSkillDirs`，并确认 Skill 的 `name` 与可见目录名一致。

### Git 更新后链接是否需要重建

已有 Junction/SymbolicLink 不需要。只有新增顶层 Skill、链接目标改名或链接损坏时需要重新运行链接脚本。

### 能否把整个执行器配置一起提交 Git

不建议。执行器配置通常同时包含机器路径、登录状态、插件配置和凭据。仓库只保存可共享模板；目标电脑按本文合并配置并重新认证。

## 13. 安全边界

- 禁止提交 Claude/Codex/lark-cli 的 Token、App Secret、Cookie、认证缓存和 `.env`。
- 禁止提交 `lark-claude/data`、`run`、`logs` 等运行时数据。
- 不要让 Git clone 或部署脚本覆盖非空的 `~/.claude`、`~/.codex`、OpenCode 或 DSH 配置目录。
- Hook 命令必须使用目标电脑的真实绝对路径。
- `.agents` 中的脚本和 Skill 具有本机执行能力；部署前应审查仓库来源和提交记录。
- 飞书网关只登记明确允许远程操作的项目目录。

## 14. 机制差异速查

- Claude Code：不原生读 `.agents`，通过 Junction/SymbolicLink 接入 Skill 和 rules。
- Codex：原生递归读 `.agents/skills`；指令只认 `AGENTS.md` 体系。
- OpenCode：原生读 `.agents/skills`，嵌套 Skill 通过 `skills.paths`。
- DeepSeek Harness：原生读 `.agents/skills`，嵌套 Skill 通过 `customSkillDirs`。
- Claude 的 `@path` 导入不能作为四工具通用方案；共享关键规则应自包含。
