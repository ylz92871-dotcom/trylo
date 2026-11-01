# Desktop 控制台闪窗：深入后台复核

- 状态：已归档
- 阶段：Desktop 运行时与发行入口排查
- 负责人：Codex
- 最后更新：2026-10-29
- 依赖决策：保护现有工作区；用户使用电脑期间只做静态文件、源码和摘要检查，不运行可见窗口探针，不操作鼠标键盘。

## 结论

2026-10-30：两条已确认路径均已修复，本地候选已生成并校验，见[修复收口记录](DESKTOP_CONSOLE_FLASH_FIX_2026_10_30.md)。下文保留深入调查当时的状态。

已经区分两条来源，而非把所有黑框归为一个问题：

1. **运行期反复闪出**：Code 的 Git 快照、变更统计和差异读取存在直接、可达的 Rust 后台进程启动链，原实现没有设置 `CREATE_NO_WINDOW`。上一轮已经修复主工作区源码，并完成原生构造方式的红/绿验证。
2. **启动时出现，失败后可能停留**：便携入口 `Start-Trylo.cmd` 启动 PowerShell，错误时执行 `pause`。它本身就是控制台入口。这条没有被上一轮 Rust 子进程修复覆盖，当前仍保持原样。

本地留存的正式版 1.1.0 主程序为 Windows GUI 子系统，SHA256 与已有发行验证记录一致，因此该留存制品不是把 Debug 控制台主程序误当正式版。公共源码副本的 7 个相关文件均与修复前基线逐字节一致；主工作区修复尚未进入这些留存发行制品。

用户未说明受影响版本和具体窗口；以上是确定的代码/发行入口问题及证据分级，不声称已经为反馈机器上的每一次黑框完成进程归因。

## 运行期：比初查更完整的 Git 调用链

当前 Code 主界面有三个快照来源：

| 来源 | 当前接线 |
| --- | --- |
| 发送时发现项目事实 | `App.tsx` → `discoverProjectFacts` → `hostAdapter.git.snapshot` |
| Agent run 开始 | `codeLifecycleObserverBase` → `CodeResultProjector.onRunStarted` → Git snapshot |
| Agent run 结束 | `CodeResultProjector.onRunTerminal` → Git snapshot |
| 结果中有变更，需要行数统计 | `CodeResultProjector` → `git.diffStats` |
| 用户打开结果差异 | `App.onOpenDiff` → `git.fileDiff` → Git show |

`tauri-git-service.ts` 将前三种快照请求送入真实 `git_snapshot` IPC，随后进入 `snapshot_repo`，不是只有定义、没有消费者的库存代码。

源码推导：正常完整 Code 交互、事实发现分支正常执行时，干净仓库的一次快照有 status、ls-files、rev-parse 三个 Git 进程，三个快照约 9 次进程创建；有 1–512 个待哈希文件且批处理成功时，每次快照再加一个 hash-object，约 12 次。结果行数统计、用户打开 diff 另有进程。非 Git 目录则通常在 status 失败后提前返回。

这些是条件明确的进程数量推导，不是本轮实际统计到的弹窗数量；重试、超时、变更消失和提前取消会改变数量。它解释了为什么用户没有打开终端也可能连续看到黑框。没有发现需要用“无限重启”或“Git 定时轮询”解释该现象的证据。

## 纠正初查中的触发范围

初查正确找到了缺失窗口属性的入口，但把其中部分历史入口写得过于接近现行主界面行为。本轮追踪消费者后作如下收窄：

| 入口 | 复核结论 |
| --- | --- |
| Git snapshot / diffStats / fileDiff | 当前 Code 主界面明确可达，主要运行期候选 |
| `pick_folder.rs` 的 PowerShell 命令 | 当前 `App` 导入 `host-adapter/pick-folder.ts`，使用官方 plugin-dialog；没有发现现行前端调用旧 `pick_folder` IPC。属于兼容入口补齐 |
| `search.rs` / SearchPanel | 当前源码找到 SearchPanel 定义及其 search 调用，未找到该组件被主界面挂载的引用。不能当作已证实的当前主界面触发链 |
| `lsp_config.rs` 的 where | `lsp_spawn` 本身可达该检测，但前端 `attachLspToFile` 仅找到定义，没有发现主界面消费者。不能仅凭函数存在就归因“打开文件必弹窗” |
| CLI Git adapter | `windowsHide` 已防御性补齐；上一轮隐藏 Node 父进程探针没有复现独立控制台分配，因此不把它单独认定为此次主因 |

这些兼容入口的隐藏设置仍有意义，但不能拿它们替代对当前 Code 运行链的证明。

## 便携版：CMD 启动器的独立黑框来源

主工作区与公共副本的 `Start-Trylo.cmd`、`Start-Trylo.ps1` 分别逐字节一致，内容包括：

```bat
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Trylo.ps1"
if errorlevel 1 pause
```

批处理启动会产生控制台；`@echo off` 只关闭命令回显。准备失败时 `pause` 使窗口停留等待用户操作。因此“只在启动时闪一下”和“黑窗留着不消失”需要先区别是否走这个入口。本轮按用户要求没有实际双击运行，结论基于现有启动器语义及发布文档对便携入口的要求。

PowerShell 脚本不是空包装：它校验发行目录与 reparse point，并准备随包 Node、PTY/SRT、捕获辅助程序等可执行文件的既有完整性级别，然后启动主 GUI。不能为了消除启动器黑框就直接删掉准备步骤，也不能靠给 PowerShell 加一个隐藏参数保证最外层 CMD 从未出现。

后续若要实现“便携版从第一次点击起也完全没有控制台”，需要独立的 GUI 启动入口，保留当前准备逻辑，并将失败改为明确的 GUI 错误/日志；这个发行入口变更尚未实施或验收。

## 发行制品检查

本轮只读解析 PE 头并计算实际文件摘要，没有运行安装器、解包覆盖或修改公共工作区。

| 本地留存文件 | 子系统 | 摘要核对 |
| --- | --- | --- |
| 公共副本 `target/release/trylo-desktop.exe`，1.1.0 | 2，Windows GUI | 匹配 `DESKTOP_1_1_0_VERIFICATION.json` 的 nativeExecutableSha256 |
| `Trylo_1.1.0_x64-setup.exe` | 2，Windows GUI 安装器 | 实际 SHA256 匹配记录 `01a9b88d…823497` |
| `Trylo_1.0.6_x64-setup.exe` | 2，Windows GUI 安装器 | 实际 SHA256 匹配对应 1.0.6 记录 |
| 主库 Debug 主程序 | 3，Windows Console | 开发配置本来保留控制台；没有据此指认正式版误发 |
| 桌宠 TryloDesktopPet | 2，Windows GUI | 不因自身 PE 子系统分配控制台 |
| 随包 Node / PTY / SRT / WGC helper | 3，Windows Console | 这些工具需要由调用方隐藏；不能只看 `.exe` 子系统就当成缺陷 |

公共源码副本的 git_snapshot、git_file_diff、git_diff_stats、search、pick_folder、lsp_config，以及 CLI Git runner 共 7 个文件，SHA256 全部匹配上一轮保存的修复前基线。此次主工作区修复不能自动改变已生成的主程序或安装包。

本轮没有重新解出安装包内部文件，也没有重编译来证明源码到二进制的完整对应；源码与制品关联沿用既有发行记录，实际文件摘要和 PE 属性是本轮重新验证的。1.0.6 只核对了留存安装器身份，没有把 1.1.0 的逐文件源码结论直接外推给它。

## 其余后台链路与误报排除

追踪了 Desktop Rust、Service Host、CLI 的 subprocess 边界及 Windows-MCP 后代进程：

- 当前主库和公共副本的 CLI worker、Service Host、workd、LSP server、taskkill 入口已有 `CREATE_NO_WINDOW`。
- CLI Shell、MCP stdio、LSP、进程会话、PTY helper、SRT 外层启动已有 `windowsHide: true`。Daemon/cloudflared 的 detached 配置同时保留隐藏属性。
- Windows-MCP 的 broker 与 WGC helper 的 Python Popen 已设 `CREATE_NO_WINDOW`；PowerShell 通用执行/清理封装也显式隐藏。WGC helper 本体是 Console 子系统并不等于它实际会弹窗。
- Windows-MCP App.launch_executable 有意启动用户指定的应用，没有隐藏设置；用户明确启动控制台程序时出现窗口属于另一种语义，不直接修改该行为。证书生成、schtasks 等命令属于独立管理路径，不能混同默认 `serve --transport stdio`。
- 旧 Hermes 适配器中仍有 6 个模块没有显式隐藏属性：python resolver、memory-context、history-mining、pending-admin、prompt-client、jobs/health。这些分别存在同步调用、间接封装和历史代码分支；缺字面选项不等于已经证明弹窗。它们没有作为本轮新增根因，也没有为凑齐“全部修完”而改写仍要求保持原样的 vendor 代码。
- 原生浏览器 popup 初始 `visible(false)`；电脑预览另有标题为 `Trylo · 电脑控制` 的独立可见窗口。如果实际反馈指的是带此标题的应用窗口而非控制台，还需按该窗口归因，本轮没有取得这种证据。

文本候选清单包含 62 个 subprocess 导入文件，其中有类型导入、转译副本、非 Windows 平台代码及包装器；这个数字不是 62 条生产启动调用或 62 个缺陷。

## 证据与本轮边界

原始只读审计位于 `work/desktop-console-20261029/deep/`：

- `artifact-source-audit.json`：实际 PE 子系统、文件大小、SHA256、与发行记录的比对及公共源码构造方式。
- `public-source-comparison.json`：7 个文件与修复前基线、当前工作区的逐文件摘要。
- `portable-launcher-audit.json`：启动器原文与两工作区摘要。
- `subprocess-source-inventory.json`：用于人工分类的原始候选清单。
- `reachability-source-hashes.json`：调用链复核所依赖的当前源码摘要。

上轮原生探针 3/3、CLI 窗口选项回归 3/3、Rust Git 回归 18/18 的红/绿证据继续保留；本轮没有重新运行会创建可见控制台的正向反例。

原生 UI 启动尝试返回 `Computer Use was not approved to use trylo-desktop`，没有获得原生界面证据。用户随后表示需要使用电脑，已停止所有界面操作及可能弹窗的测试，本轮继续的是后台只读检查。没有运行用户的任务、切换模型/账号、修改系统设置、提交源码或发布新安装包。

当前结案范围是：运行期 Git 窗口缺陷的源码修复、当前真实调用链与留存发行制品身份的后台核查、便携启动器第二来源的确认。便携入口改造、修复包重建与用户实际黑框的窗口/PID 归因尚未完成。
