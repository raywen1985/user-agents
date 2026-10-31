# Claude / Codex 配置收集与安装

将本机配置中的可移植设置收集到 `sources/`，再合并到其他 Windows PC。原始客户端配置继续被各自仓库忽略；凭据、运行状态和设备授权保留在本机。

## 快速使用

在 `~/.agents` 根目录执行。需要 Windows PowerShell 5.1、Node.js 22 或更新版本，以及 Git（仅监视仓库时使用）。

```powershell
npm ci --ignore-scripts --prefix ./config-sync/tools

# 查看将收集的字段路径，不输出设置值
./config-sync/Sync-AgentConfig.ps1 collect -WhatIf

# 从本机收集，并建立本机同步基线
./config-sync/Sync-AgentConfig.ps1 collect

# 查看源和本机的可移植差异
./config-sync/Sync-AgentConfig.ps1 diff

# 在另一台 PC 先预览，再合并安装
./config-sync/Sync-AgentConfig.ps1 install -WhatIf
./config-sync/Sync-AgentConfig.ps1 install
```

工具只生成工作树变更。审查 `config-sync/sources/` 的 Git diff 后自行提交；不会自动 commit、push 或修改 Git 配置。

首次在源 PC 使用 `collect`；首次在接收 PC 使用 `install`。运行安装前先安装所选的 Token Meter、飞书通知、Chrome DevTools MCP 和 Codex 插件等依赖。脚本缺失、provider 没有本机认证或插件未安装时，整轮安装停止，不发布部分配置。

## 文件与范围

| 本机输入 | 可提交源 |
| --- | --- |
| `~/.claude/settings.json` | `sources/claude.settings.json` |
| `~/.codex/config.toml` | `sources/codex.config.toml` |
| `~/.codex/hooks.json` | `sources/codex.hooks.json` |

源中 `${AGENTS_ROOT}`、`${USER_HOME}`、`${TEMP}` 是本工具的占位符，安装时解析，不能把源文件直接覆盖到客户端目录。仓库从脚本位置解析，用户目录和临时目录从本机环境解析；`CODEX_HOME` 已设置时采用它。需要测试其他目录时可指定 `-UserHome`、`-CodexRoot`、`-TempRoot`。

`policy.json` 明确列出客户端、标量字段、Claude 环境变量、provider、MCP、插件和命令适配器。首版固定支持当前配置中的字段族；新类型或任意命令需要扩展适配器和测试，不能只把凭据键写进 policy 绕过检查。可从 policy 删除不需要的组件；修改后需显式重建基线。

收集模型、主题、更新通道、明确列出的桌面偏好、特性开关、非敏感 provider 元数据、已知 Hook/statusLine/notify、Chrome DevTools MCP 与插件启用状态。权限只识别 Read/Write/Edit/Glob/Grep 和可规范化路径，不导出任意 Bash/Shell 授权。

不收集 token、认证文件、`settings.local.json`、项目信任、Hook 信任哈希、自动生成的 Node REPL 环境、运行时目录或未知字段。无法映射的跨盘/其他用户路径、全用户名通配规则计入 `skippedPaths`；它们仍保留在本机。未知 Hook 计入 `skippedHooks`。摘要中的 `excludedLeaves` 是字段数量概览，不是秘密数量。

Codex 桌面原生 notify 包装层只在本机保留，源中保存通知桥；桌面运行时升级不会把版本目录带入仓库。Token Meter 编码命令只接受已知模板，收集时转换成可阅读的脚本路径，安装时恢复目标设备的命令。工具从不执行收集的命令。

飞书通知固定的 matcher、timeout、async，以及 Token Meter 固定的事件/timeout 与现有安装器保持一致。修改这些受安装器约束的属性会报 `owner-policy-conflict`；需先修改所属安装器并更新适配器。Startup Health 的安装与激活必须走它自己的流程，当前遇到其受管命令会停止并提示所有权冲突，不把安装清单复制到其他 PC。

## 合并语义

- 源中存在的受管标量覆盖目标值；普通对象按叶子合并，保留未知字段和凭据。
- 权限和附加目录集合合并；源中缺失不会删除目标条目。
- 已知 Hook 按功能身份和事件匹配，更新受管属性，保留其他 handler 和未知属性；歧义/重复的受管 Hook 会停止，不猜测保留哪一个。
- notify、MCP 参数和状态栏数组保持顺序。
- JSONC 注释与未改文本保留；TOML 使用 AST 更新值或插入字段，保留未知表。修改 inline table 时会重排该值内部的格式。
- UTF-8（含 BOM）和 UTF-16LE 保持原编码；不支持 UTF-16BE。新源文件默认 UTF-8。

安装结果可以包含本机独有条目，因此两侧哈希分别记录。安装后不会立即把这些条目反向收集；以后显式 collect 或本机可移植配置再次变化时可以收集它们。没有严格镜像或 `-Prune` 模式。

## 冲突与基线

`local/config-sync/` 已被仓库忽略，保存本机基线、日志、备份和事务记录。不要复制该目录到其他 PC。

两侧相对各自基线都变化时一律报 `conflict`，包括都改成相同内容。先查看 diff，再显式选择方向：

```powershell
./config-sync/Sync-AgentConfig.ps1 collect -ResolveConflict PreferLocal
./config-sync/Sync-AgentConfig.ps1 install -ResolveConflict PreferSource
```

策略、实现版本或路径身份变化时报告 `needs-rebaseline`。审查更新并选定方向后执行：

```powershell
./config-sync/Sync-AgentConfig.ps1 collect -Rebaseline
# 或
./config-sync/Sync-AgentConfig.ps1 install -Rebaseline
```

如果收窄 policy，先相应调整源文件，防止旧源中的非白名单字段被静默接受。`source-not-a-portable-projection` 表示源含不支持的键、非规范内容或不允许的本机数据。

## 可选监视器

先完成一次 collect/install。启用与停用均支持 `-WhatIf`：

```powershell
./config-sync/Enable-AgentConfigWatch.ps1
./config-sync/Disable-AgentConfigWatch.ps1

# 前台运行，Ctrl+C 结束；不会创建计划任务
./config-sync/Sync-AgentConfig.ps1 watch
```

启用脚本注册当前用户的 `AgentConfigSync` 登录任务，以有限权限隐藏运行。默认 collect/install 不注册或启动任务。禁用脚本保留配置、基线和备份；`watch.stop` 保持停止状态，重新运行 Enable 才清除。

监视器处理保存和重命名事件，等待 2 秒稳定读取，每 30 秒补充扫描。仅本机改变时收集，仅源改变时安装，双侧改变时报冲突。Git index 锁、未合并文件、半写配置或缺失文件都会推迟/停止写入。错误只写本机日志，不发送消息。

Git 更新同步器代码或 policy 时，本次监视进程停止自动写入。手动重建基线后重新 Enable。新 PC 的依赖和认证仍需当地安装；source 更新不会替你安装软件或授权 Hook。

## 事务与恢复

全部候选先解析验证，再发布。备份可能含凭据，因此本机状态和备份目录仅授予当前用户及 SYSTEM 访问，无法设置时拒绝写入。每个文件采用同卷原子替换，发布前校验原始指纹；最终基线来自固定快照，避免吞掉同步期间的编辑。

进程中断或回滚遇到外部写入时报告 `recovery-required` 和事务 ID。之后的写操作停止，按明确 ID 恢复：

```powershell
./config-sync/Sync-AgentConfig.ps1 recover -TransactionId '<报告中的事务 ID>' -WhatIf
./config-sync/Sync-AgentConfig.ps1 recover -TransactionId '<报告中的事务 ID>'
```

全部候选已落地且输入未变时完成提交；只落地一部分时有条件回滚。检测到第三方新内容时保留它并要求人工处理，不覆盖未知更改。日志不含配置值；原始备份与候选仅保存在受限的本机事务目录中，工具不自动清理它们。

这是逐文件原子替换与可恢复事务，不是三个文件的单次文件系统原子操作。外部编辑器不共享锁，指纹检查与替换仍有极短竞态窗口；避免在手动安装期间同时编辑同一配置。保证范围是正常进程退出/中断恢复，不承诺任意断电或磁盘故障下的恢复。

## 验证

```powershell
npm test --prefix ./config-sync/tools
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./config-sync/tests/Test-WatchTasks.ps1
```

测试使用合成凭据、临时用户目录和模拟计划任务。覆盖脱敏、路径转换、注释保留、合并幂等性、双边冲突、晚到编辑、事务故障与崩溃恢复。测试不执行真实 Hook、不启动 MCP、不注册生产监视任务。

Codex 配置字段参考：<https://learn.chatgpt.com/docs/config-file/config-reference>。本工具检查语法、已支持字段及本机依赖，不启动客户端运行任务；客户端版本不支持某个旧字段时，应先在 policy 和源中移除或迁移该字段。
