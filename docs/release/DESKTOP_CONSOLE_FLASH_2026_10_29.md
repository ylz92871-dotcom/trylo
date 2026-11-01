# Desktop Windows 控制台闪窗排查

- 状态：已归档
- 阶段：Desktop 运行时维护
- 负责人：Codex
- 最后更新：2026-10-29
- 依赖决策：只修后台进程窗口属性，不改变进程生命周期、参数、权限与输出合同。

## 结论

2026-10-30：运行期与便携入口两条路径已完成修复，并生成校验通过的本地 1.1.1 候选，见[修复收口记录](DESKTOP_CONSOLE_FLASH_FIX_2026_10_30.md)。下文保留初查时的范围与证据。

当前源码存在可导致黑色控制台闪出的明确缺陷：Desktop 主程序的 release 入口已经使用 `windows_subsystem = "windows"`，但若干后台子进程没有设置 `CREATE_NO_WINDOW`。父程序隐藏控制台，不会自动替所有 Rust 子进程设置这一属性。

已补齐这些调用。Windows GUI 子系统探针中，原始无保护构造方式产生 `console=true, visible=true`；修复后同步和 Tokio 异步方式都为 `console=false, visible=false`。

反馈用户不清楚具体触发时机，也没有提供运行版本。因此本记录证明当前源码的窗口缺陷及修复效果，不能唯一归因该用户机器上的每一次黑框，也不代表旧安装包已经修复。

后续已完成[深入后台复核](DESKTOP_CONSOLE_FLASH_DEEP_2026_10_29.md)：主要运行期触发链收窄为 Code 的自动 Git 快照、变更统计与差异读取；另发现便携 CMD 启动器的独立控制台来源。下表列的是修复入口，搜索/LSP/旧文件夹选择器不应全部视为当前主界面的已证实触发点。

## 触发路径与修改

| 触发点 | 进程 | 修改位置 |
| --- | --- | --- |
| 任务开始/结束时收集 Git 快照 | Git status、ls-files、hash-object、rev-parse | `git_snapshot.rs` 两个启动入口 |
| 统计改动行数 | Git diff | `git_diff_stats.rs` |
| 打开文件差异 | Git show | `git_file_diff.rs` |
| 内容搜索 | rg | `search.rs` |
| 检查语言服务器是否安装 | Windows where / Unix which | `lsp_config.rs` |
| 调用已有 PowerShell 文件夹选择命令 | powershell | `pick_folder.rs` |

快照在 `CodeResultProjector.onRunStarted/onRunTerminal` 自动收集，一次快照会启动多个 Git 子进程。这解释了不主动打开终端、仅运行任务时也可能重复闪窗；没有将它误称为定时轮询。

新增 `background_command.rs` 统一创建这些后台命令，Windows 设置 `CREATE_NO_WINDOW`，Unix 保持标准构造。异步调用从该标准命令转换为 Tokio 命令，保留已有超时、kill-on-drop、stdin/stdout/stderr 配置。

CLI、Service Host、workd 和语言服务器自身的既有启动路径已有隐藏设置，本次没有重写。交互式 PTY 不在本次修改范围内。`attachment_staging.rs` 等文件剩余的未隐藏 Git 调用处于测试模块，未据此扩大生产修复。

新版 CLI 的 Git adapter 另补 `windowsHide: true`，作为同类窗口策略的防御性补齐。其调用选项回归在原代码上失败、修复后通过；从已隐藏 Node 父进程运行原 adapter 的额外探针未复现独立控制台分配，因此没有把该 adapter 认定为本次反馈的独立主因。

## 验证

证据目录：`work/desktop-console-20261029/`。

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| 原生 Windows GUI 父进程、无保护标准/Tokio 构造反例 | 两者均创建可见控制台 | `red-platform.log`、`probe-ekXqD5/*.json` |
| 修复后标准/Tokio 命令与当前 CLI adapter | 3/3，通过，未分配控制台 | `green-platform.log`、`probe-eplGJc/*.json` |
| CLI 原代码的窗口选项回归 | 2 通过、1 失败 | `red-cli.log` |
| CLI 修复后回归 | 3/3 | `green-cli.log` |
| Desktop Git 解析、路径、真实仓库、2000 文件规模、预算回归 | 18/18 | `rust-git-tests-workspace-temp.log` |
| CLI 全源码 TypeScript 检查 | 退出 0 | `cli-typecheck.log`、`verification.json` |
| CLI 静态卫生扫描 | 1835 文件、0 issues | `cli-static-scans.log` |
| CLI 全仓格式扫描 | 未通过：范围外 `tool-evolution/process-verifier.ts` 为 CRLF | `cli-format.log` |
| 无控制台 PowerShell 的既有 UTF-8 输出设置 | 正常输出中文，退出 0 | `powershell-utf8.json` |
| 范围内 diff whitespace 检查 | 通过 | `verification.json` |

原生探针用 `rustc` 编译独立的 Windows GUI 父进程与控制台子进程，直接调用 `GetConsoleWindow` / `IsWindowVisible`。修复路径包含实际 `background_command.rs`，不是浏览器模拟或截图推断。正向反例保持无保护构造，防止测试环境本身没有窗口能力而假绿。CLI adapter 每次从当前 TS 源码隔离转译，未使用旧 dist。

首次 Git 回归 15/18，3 项因沙箱系统 TEMP 内的 `.git/config` 写入被拒失败，原始输出保留于 `rust-git-tests.log`。仅把测试进程 TEMP/TMP 指向本工作区的独立目录后，18/18 通过。另一次试图用 Git shell alias 扩展探针时，MSYS 命名对象创建被沙箱拒绝（退出 66）；该试验不作为窗口修复或 Git 功能验收依据。

全仓格式扫描另外发现范围外 `src/internal/adapters/tool-evolution/process-verifier.ts` 的 CRLF 换行问题。该文件不属于本次窗口修复，未改动或将其吸收入本次变更，因此没有宣称整仓格式或完整 verify 通过。

平台回归已接入 Desktop `test:platform`，需要已构建的 Rust 依赖（`src-tauri/target/debug/deps/libtokio-*.rlib`）和本机 rustc。可单独运行：

```powershell
$env:TRYLO_CONSOLE_EVIDENCE_DIR = 'C:\work\demo-ws\work\desktop-console-20261029'
node --test desktop/scripts/background-console.platform.test.mjs
```

## 自审、限制与回滚

可读性/可维护性通过：一个窄后台命令构造入口，调用点保持原有参数、错误和生命周期处理。新增两个平台测试文件；CLI 测试使用已有注入缝。没有增加依赖、协议、持久化格式、学习控制面或权限变化。

已验证源码、原生 Windows 受控进程窗口属性和受影响 Git 功能。未重新打包 Desktop、安装新发行包、执行完整 WebView2 用户流程、人工验收实际文件夹选择对话框，也未覆盖用户自行配置的外部程序显式创建窗口的情况。

回滚只需撤销本记录所列命令构造替换、CLI 两个文件的窗口选项与回归、平台测试入口及新增文件；不涉及设置迁移和数据恢复。工作区原有其他改动未纳入本次修复。
