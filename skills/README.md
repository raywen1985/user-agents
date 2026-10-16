# Skills 维护说明

`skills/` 是多个 AI Coding Agent 共用的用户级 Skill 单一真实源。Agent 是否触发以及如何执行某项能力，由对应目录中的 `SKILL.md` 决定；本文只说明仓库维护约定，不是 Agent 使用说明。

各执行器如何发现此目录，见 [跨电脑部署手册](../ai-install.md)。

## 来源与所有权

维护前先判断 Skill 的来源，避免升级时覆盖本地修改。

- **锁文件登记的上游 Skill**：根目录 [`.skill-lock.json`](../.skill-lock.json) 记录安装器来源、安装时目录哈希及时间戳。目前主要是从 `larksuite/cli` 安装的 `lark-*` Skill。
- **未登记的 Skill**：未由该锁文件管理。它们可能是本仓库自行维护或通过其他方式加入；来源应以 Git 历史和目录内容为准，不要凭目录名推断。
- **兼容路由 Skill**：只把请求转交给另一项 Skill，例如部分 `lark-*` 兼容入口。这是功能角色，不是来源分类；兼容路由也可能属于锁文件登记的上游 Skill。

锁文件不是当前文件状态证明。Skill 安装后可能已有本地修改，因此升级、替换或删除锁文件登记项前，必须先检查实际 Git 差异。

## 目录约定

每个顶层 Skill 使用独立目录，最小结构为：

```text
skills/
`- <skill-name>/
   `- SKILL.md
```

可按需要增加以下内容：

| 路径 | 用途 |
|---|---|
| `references/` | 供 `SKILL.md` 按需读取的详细规则或资料 |
| `scripts/` | 可复用的确定性脚本和验证工具 |
| `assets/` | 模板、静态资源或示例输入 |
| `evals/` | 触发、行为或回归评测用例 |
| `agents/`、`scenes/` 等 | Skill 自身明确约定的辅助资源 |

除非执行器发现机制另有要求，目录名应与 `SKILL.md` frontmatter 中的 `name` 保持一致。所有相对引用都应以 `SKILL.md` 所在目录为基准，并确保被引用文件随 Skill 一起提交。

## 维护规则

- `SKILL.md` 必须包含有效的 `name` 和 `description` frontmatter；描述应清楚说明触发条件、适用范围和不负责的任务。
- 指令应说明必要步骤与边界，避免复制可放入 `references/` 的大段资料。
- 优先复用现有脚本、模板和参考资料，不在多个 Skill 中维护相同内容。
- 不写入 Token、Cookie、密钥、认证缓存、个人凭据或只在单台电脑有效的绝对路径。
- 修改锁文件登记的上游 Skill 时，应能从 Git 差异中识别本地改动；后续升级时先合并，不直接覆盖。
- 兼容路由 Skill 应保持精简，并明确唯一目标 Skill，避免两边重复维护完整规则。
- 新增嵌套 Skill 前先核对各执行器的发现限制；接入方式以 [跨电脑部署手册](../ai-install.md) 为准。

## 变更流程

1. 确认目标 Skill 是否登记在 `.skill-lock.json`，并查看 `git status`、`git diff` 和相关提交历史。
2. 根据变更类型维护 `SKILL.md` 及必要的 `references/`、`scripts/`、`assets/` 或 `evals/`。
3. 检查目录名、frontmatter `name` 和相对引用是否一致。
4. 运行 Skill 自带测试或评测；没有自动化测试时，至少执行一次典型触发和一次不应触发的场景。
5. 在已接入的执行器中新建会话，确认 Skill 可发现且规则生效。
6. 新增顶层 Skill 后，按部署手册重新同步需要链接的执行器。

删除或重命名 Skill 时，还要清理对应链接、执行器配置和锁文件记录；不要只删除目录。

## 盘点与检查

以下命令均在仓库根目录执行。

列出所有包含入口文件的顶层 Skill：

```powershell
Get-ChildItem .\skills -Directory |
    Where-Object { Test-Path (Join-Path $_.FullName 'SKILL.md') } |
    Sort-Object Name |
    Select-Object -ExpandProperty Name
```

查找缺少入口文件的顶层目录：

```powershell
Get-ChildItem .\skills -Directory |
    Where-Object { -not (Test-Path (Join-Path $_.FullName 'SKILL.md')) } |
    Select-Object -ExpandProperty FullName
```

检查 frontmatter 关键字段和工作区差异：

```powershell
rg -n '^name:|^description:' .\skills -g SKILL.md
git status --short -- .\skills .\.skill-lock.json
git diff -- .\skills .\.skill-lock.json
```

## 最小验收

- 每个预期 Skill 目录都包含 `SKILL.md`。
- `name` 唯一，并与可见目录或执行器链接名称一致。
- `description` 能让 Agent 正确区分应触发与不应触发的请求。
- `SKILL.md` 引用的本地文件均存在，脚本可在目标环境运行。
- 锁文件登记项的本地差异已被识别并保留。
- 新会话中可以发现新增或变更后的 Skill。
- Git 差异只包含本次预期文件，且没有凭据、运行数据或机器专用路径。
