# Chrome DevTools MCP

本目录保存 Claude Code 和 Codex 共用的 Chrome DevTools MCP 依赖清单。`node_modules/` 不进入 Git；新电脑 clone `.agents` 后需要在本目录恢复依赖，再分别合并两个执行器的用户级 MCP 配置。

当前锁定版本：`chrome-devtools-mcp@1.12.0`。

## 能力和安全边界

启用 `--autoConnect` 后，MCP 可以附着到当前用户正在运行的 Chrome，读取已打开标签页的页面结构、控制台和网络请求，也可以执行点击、输入和脚本。只应在可信本机和可信 MCP 客户端中启用。

- Chrome 需要 144 或更高版本，并在 `chrome://inspect/#remote-debugging` 中手动允许远程调试。
- 不要把 Cookie、Token、页面控制台原始日志、浏览历史或登录态提交到 Git。
- 默认会向 Google 上报匿名使用统计（含 `usageStatistics` 遥测子进程）。本文的配置统一加上 `--no-usage-statistics` 关闭上报；如确实需要参与统计，可删掉该参数。
- 对云文档、表单、消息或其他外部系统执行写操作前，应确认目标、内容和影响范围。
- 不需要控制现有标签页时，可关闭 Chrome 的远程调试开关。

## 安装依赖

要求 Node.js 满足包声明的版本范围：`^20.19.0 || ^22.12.0 || >=23`。

从已经包含 `package-lock.json` 的 `.agents` 仓库恢复依赖：

```powershell
$ToolRoot = Join-Path $env:USERPROFILE ".agents\tools\chrome-devtools-mcp"
npm ci --prefix $ToolRoot
```

首次创建或明确更新锁定版本时：

```powershell
$ToolRoot = Join-Path $env:USERPROFILE ".agents\tools\chrome-devtools-mcp"
npm install --prefix $ToolRoot --save-exact chrome-devtools-mcp@1.12.0
```

验证共享安装：

```powershell
$NodePath = (Get-Command node).Source
$ServerPath = Join-Path $env:USERPROFILE ".agents\tools\chrome-devtools-mcp\node_modules\chrome-devtools-mcp\build\src\bin\chrome-devtools-mcp.js"

& $NodePath $ServerPath --version
```

预期输出 `1.12.0`。

## 配置 Claude Code

使用用户级配置，使所有 Claude Code 项目都能调用：

```powershell
$NodePath = (Get-Command node).Source
$ServerPath = Join-Path $env:USERPROFILE ".agents\tools\chrome-devtools-mcp\node_modules\chrome-devtools-mcp\build\src\bin\chrome-devtools-mcp.js"

claude mcp add --scope user chrome-devtools -- "$NodePath" "$ServerPath" --autoConnect --no-usage-statistics
claude mcp get chrome-devtools
```

若同名服务器已经存在，先检查当前配置；只有确认要替换时才执行：

```powershell
claude mcp remove chrome-devtools --scope user
```

健康检查应显示 `Connected`，参数中应包含 `--autoConnect --no-usage-statistics`。

## 配置 Codex

优先使用 Codex CLI 写入用户配置：

```powershell
$NodePath = (Get-Command node).Source
$ServerPath = Join-Path $env:USERPROFILE ".agents\tools\chrome-devtools-mcp\node_modules\chrome-devtools-mcp\build\src\bin\chrome-devtools-mcp.js"

codex mcp add chrome-devtools -- "$NodePath" "$ServerPath" --autoConnect --no-usage-statistics
codex mcp get chrome-devtools
```

等价的 `~/.codex/config.toml` 配置如下。路径必须改成目标电脑的真实路径，并与已有配置合并：

```toml
[mcp_servers.chrome-devtools]
command = '<NodePath>'
args = ['<ServerPath>', '--autoConnect', '--no-usage-statistics']
```

`<NodePath>` 用 `(Get-Command node).Source` 的结果替换，`<ServerPath>` 用上文 `$ServerPath` 的实际值替换；不要直接复制示例中的占位符。

`codex mcp get chrome-devtools` 应显示 `enabled: true`、`transport: stdio` 和 `--autoConnect --no-usage-statistics`。

## 启用并验收 `autoConnect`

1. 使用日常 Chrome 打开 `chrome://inspect/#remote-debugging`。
2. 手动启用远程调试，并保持该 Chrome 实例运行。
3. 新建 Claude Code 或 Codex 会话，使新的 MCP 配置进入工具清单。
4. 要求执行器使用 `chrome-devtools` 列出当前页面。

验收成功时，应列出日常 Chrome 中已经存在的多个标签页；继续读取某个页面的无障碍快照，可证明 MCP 不只是发现标签页，而是已经能访问页面内容。

## 可选调优（默认未启用）

以下参数按需追加到 MCP `args`，修改后需要新建执行器会话才会生效：

- `--screenshotFormat=webp --screenshotQuality=80 --screenshotMaxWidth=1920`：截图默认压缩并限制宽度，明显降低上下文占用；需要无损细节时在单次调用里覆盖 `format`/`quality`。
- `--no-category-performance`（同理可关闭 `network`、`memory` 等）：不用的工具类别可以关闭，减少工具定义占用。
- `--no-page-id-routing`：只允许单个执行器连接时，可省去页面级工具每次传 `pageId`；Claude 和 Codex 同时连接时保持默认开启，避免互相操作错标签页。
- `--watchConfig`：配合 `--config` 使用，修改 URL 限制等配置后无需重启进程（1.12.0+）。

`--autoConnect` 意味着 MCP 使用日常 Chrome 的登录态。若只想调试本地站点，可追加 `--allowedUrlPattern`（Chrome 149+）限制可访问的 URL 范围。

## 常见问题

### 只看到 `about:blank`

MCP 启动了自己的独立 Chrome，没有附着到日常 Chrome。检查配置是否包含 `--autoConnect`、远程调试是否已启用，并新建执行器会话。

### 提示默认 Chrome profile 已被占用

旧配置曾以默认模式启动 MCP 专用 Chrome，残留进程仍占用 `chrome-devtools-mcp\chrome-profile`。确认该窗口不是日常 Chrome 后关闭它，再重启执行器会话。不要批量结束所有 Chrome 进程。

### Claude 显示连接超时

不要依赖每次启动时执行 `npx ...@latest`。先按本文将固定版本安装到 `.agents/tools/chrome-devtools-mcp`，再让 Claude/Codex 直接调用本地 Node 脚本。

### 能列出标签页但不能控制现有 Chrome

检查 Chrome 版本、`chrome://inspect/#remote-debugging` 的状态和执行器是否加载了最新配置。关闭远程调试或关闭 Chrome 后，`autoConnect` 无法建立连接。

## 更新

先审查目标版本的变更，再更新锁文件并重新验收两个客户端：

```powershell
$ToolRoot = Join-Path $env:USERPROFILE ".agents\tools\chrome-devtools-mcp"
npm install --prefix $ToolRoot --save-exact chrome-devtools-mcp@<version>
```

提交 `package.json`、`package-lock.json` 和本文，不提交 `node_modules/`。更新后重启两个执行器的会话，确认健康检查仍然包含 `--autoConnect --no-usage-statistics`。
