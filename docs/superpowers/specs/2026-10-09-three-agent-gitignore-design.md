# 三个用户级 Agent 仓库的 `.gitignore` 设计

日期：2026-10-09

## 目标

为以下三个独立私有仓库建立不同的跟踪边界：

- `~/.agents`：共享能力源码仓库。
- `~/.claude`：Claude 用户目录，只跟踪人工维护且可移植的资源。
- `~/.codex`：Codex 用户目录，只跟踪人工维护且可移植的资源。

规则必须防止认证信息、会话、数据库、缓存和机器运行状态进入 Git，同时允许多台 Windows 电脑共享 Skills、用户级指令和明确选择的规则。

## 总体策略

`.agents` 主要由源码组成，因此使用黑名单：源码默认可跟踪，仅排除凭据、依赖、缓存、构建产物和运行数据。

`.claude` 与 `.codex` 主要由工具运行状态组成，因此使用白名单：默认忽略全部，只重新包含少量人工维护的可移植文件。新增可共享资源时必须显式修改 `.gitignore`，不能依赖宽泛目录放行。

三个仓库都跟踪自己的 `.gitignore` 和 `README.md`。不使用全局 Git exclude 或用户级全局 `.gitignore` 承担安全边界，确保仓库 clone 到其他电脑后规则仍然有效。

## `.agents` 规则

保留现有类别并补齐：

1. 凭据与本机环境：仅按明确的凭据文件名和扩展名排除 `.env*`、`auth.json`、`credentials.json`、`credentials.local.json`、`credentials.private.json`、`service-account.json`、`service-account-key.json`、`token.json`、`tokens.json`、`secrets.json`、私钥和证书；允许 `.env.example` 与 `.env.*.example`。禁止使用 `credentials*.json`、`credentials-*.json`、`*token*` 或 `*secret*` 之类宽泛规则，以免误伤 Schema、示例、`token-meter/` 和源码文档。
2. 本机覆盖：根 `local/`、`lark-notify.local.json`、`lark-claude/config/*.local.json`。
3. 运行状态：根 `.tmp/`、`.token-meter-data/`，以及 `lark-claude/data|logs|run`。
4. Node.js：依赖目录、包管理器缓存、调试日志和构建缓存。
5. Python：虚拟环境、字节码、测试、类型检查和 lint 缓存。
6. 构建、覆盖率、编辑器、操作系统、临时文件和备份。

以下现有真实配置继续允许跟踪，因为仓库为同一人跨电脑使用的私有仓库：

- `lark-notify.json`
- `lark-claude/config/gateway.json`
- `lark-claude/config/projects.json`

上述文件不得包含 App Secret、访问令牌、Cookie 或认证缓存。机器差异后续迁移到不含凭据的 machine profile，不在本次 `.gitignore` 修改中改变配置格式。

## `.claude` 规则

根规则先使用 `/*` 忽略所有顶层内容，只允许：

- `.gitignore`
- `README.md`
- `CLAUDE.md`
- `rules/**/*.md`
- `agents/**/*.md`
- `commands/**/*.md`

实现必须按以下顺序处理父目录遍历和文件类型白名单；不能只写 `!/rules/**` 之类宽泛反向规则：

```gitignore
/*
!/.gitignore
!/README.md
!/CLAUDE.md

!/rules/
/rules/**
!/rules/**/
!/rules/**/*.md

!/agents/
/agents/**
!/agents/**/
!/agents/**/*.md

!/commands/
/commands/**
!/commands/**/
!/commands/**/*.md
```

不允许跟踪完整 `settings.json`。Hook 由 `.agents` 中的安装脚本幂等维护。`skills/` 继续以 `.agents/skills` 为单一来源，不在本仓库重复跟踪。

因此 `history.jsonl`、`projects/`、`sessions/`、`plugins/`、`file-history/`、`tasks/`、备份、锁文件和其他未来新增的运行状态都会默认被忽略。白名单目录中的非 Markdown 文件也默认忽略；Markdown 仍须在暂存前人工审查内容。

## `.codex` 规则

根规则先使用 `/*` 忽略所有顶层内容，只允许：

- `.gitignore`
- `README.md`
- `AGENTS.md`
- `rules/shared.rules`

实现必须使用以下顺序，保证可以遍历 `rules/`，同时继续忽略同目录中的 `default.rules`：

```gitignore
/*
!/.gitignore
!/README.md
!/AGENTS.md

!/rules/
/rules/*
!/rules/shared.rules
```

`rules/default.rules` 是 Codex 自动积累的本机授权记录，包含绝对路径和已批准命令，必须保持忽略。只有人工审查并明确命名的 `rules/shared.rules` 可以共享。

不允许跟踪完整 `config.toml`、`hooks.json` 或 `auth.json`。Hook 由 `.agents` 管理；`skills/` 不重复跟踪。会话、SQLite 数据库、日志、附件、浏览器状态、插件、工作树、缓存和锁文件均由默认规则排除。

## 验收

每个仓库执行 `git status --short`，预期：

- `.agents` 显示源码和文档，但不显示运行目录、依赖或凭据。
- `.claude` 只可能显示白名单中的人工资源。
- `.codex` 只可能显示白名单中的人工资源，且不显示 `rules/default.rules`。

使用 `git check-ignore -v --no-index` 验证代表性路径：

- `.agents/.token-meter-data/...`、`.agents/.tmp/...`、`.env`、SQLite WAL、`node_modules` 被忽略。
- `.agents/skills/.../SKILL.md`、三个明确允许的真实配置不被忽略。
- `.claude/settings.json`、`sessions/`、`plugins/` 被忽略；`CLAUDE.md` 可跟踪。分别在 `rules/`、`agents/`、`commands/` 下测试至少两层深的 Markdown 文件可跟踪，同时同目录的 `.json`、`.rules`、`.bak` 和锁文件继续被忽略。
- `.codex/auth.json`、`config.toml`、`hooks.json`、`rules/default.rules`、数据库和会话被忽略；`AGENTS.md`、`rules/shared.rules` 可跟踪。

`.agents` 的数据库规则必须覆盖 `.db`、`.sqlite`、`.sqlite3`，以及对应的 `-wal`、`-shm`、`-journal` sidecar。验收矩阵要逐一测试三个基础扩展名及其三种 sidecar，不能只抽查 WAL。

`.gitignore` 不影响已经进入索引的文件，因此还必须执行：

```powershell
git ls-files -ci --exclude-standard
```

三个仓库均要求输出为空。对 `.claude` 与 `.codex` 再将 `git ls-files` 输出与设计白名单比较；除 `.gitignore`、`README.md` 和允许的人工资源外，出现任何路径都视为失败。

本次实现不暂存文件。使用 `git ls-files --cached --others --exclude-standard` 枚举所有已跟踪及未忽略的未跟踪文件，对这份集合运行不区分大小写的凭据关键词扫描，至少覆盖 `api_key`、`access_token`、`refresh_token`、`client_secret`、`app_secret`、`authorization`、`bearer`、`private_key`、`password`、`cookie`。每个命中项必须是字段名、占位符或安全文档示例；出现可用值即失败。实现阶段使用 `git diff` 和直接读取未跟踪的 `.gitignore` 检查结果；`git diff --cached` 保留为以后真正暂存时的提交前检查。

跨电脑资源 `CLAUDE.md`、`AGENTS.md`、Claude Markdown 资源和 `rules/shared.rules` 不得包含当前用户名、`C:\Users\<实际用户名>`、固定盘符项目路径或安装版本目录。三个现有 `.agents` 部署配置是本次范围内的显式例外；在 machine profile 落地前，它们允许包含机器路径，但不得包含凭据，并且其他电脑不得直接套用。

最后检查三个 `.gitignore` 的编码和换行，不暂存、不提交、不推送实现文件。

## 风险控制

- 白名单仓库新增可共享目录时，必须逐项放行，不能把 `.claude/*` 或 `.codex/*` 整体取消忽略。
- Git 不能忽略 JSON/TOML 的部分字段，因此机器相关或含凭据的完整配置文件不入库。
- 不在 `.claude` 或 `.codex` 中运行 `git clean -fdx`，否则会删除被忽略的真实运行数据。
- `.agents` 的真实配置虽允许跟踪，但提交前仍需进行凭据检查。
