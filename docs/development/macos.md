# Mac 接入指南

Mac PR #8 接入 Apple Silicon / macOS 14.0 构建路径、原生窗口菜单、Keychain、Seatbelt、Swift 电脑工具与预览引擎。跨平台软件检查与真机安装验收须分别记录。

## 接入来源

本轮来源为 [PR #8](https://github.com/ylz92871-dotcom/trylo/pull/8) 的 [Ai-JUX-02/trylo 的 MacOS 分支](https://github.com/Ai-JUX-02/trylo/tree/MacOS)，保留作者归属。[原 PR #6](https://github.com/ylz92871-dotcom/trylo/pull/6) 已关闭且未合入，接入前核对最新提交。来自其他适配版本的重复实现先审阅，再确定来源。

## 代码落位

| 能力 | 位置 |
| --- | --- |
| 原生菜单、Dock、窗口关闭重开 | desktop/src-tauri/src/platform/shell.rs 的 Mac 条件模块 |
| 文件打开、后台 PATH | desktop/src-tauri/src/platform/macos/ |
| 主界面文件夹选择 | 既有 Tauri dialog 插件 / host-adapter |
| WKWebView 浏览器实现 | 所属原生预览/浏览器模块，通过既有接口选择 |
| 共用快捷键与界面接线 | desktop/src/host-adapter/ 和所属功能模块 |
| Mac 样式覆盖 | desktop/src/styles/platforms/，限定 Mac 属性 |
| Keychain | CLI 的 adapters/credentials/keyring-darwin.ts |
| Seatbelt 和 Shell 处理 | CLI 的 adapters/sandbox/darwin-* |
| PTY 和子进程停止 | CLI 的 adapters/process-session/ |
| 电脑权限、截图、键鼠接线 | desktop-services/src/tooling/computer-control/macos/ |
| Swift 工具源码 | desktop-services/toolchain/computer-control/macos-mcp/ |
| 工具定义、版本、平台依赖 | tooling/manifests/ 与既有 toolchain 注册表 |
| 资源准备、DMG、签名与公证 | desktop/scripts/build/macos/ 和 tauri.macos.conf.json |

电脑控制接入口选用 Mac 合作者的 macos-computer 包标识。服务名和工具 schema 由接入后的 manifest 与 MCP 发现确认。沿用现有风险分类、用户开关和审批链，实际健康检查证明工具可用。

## 接入顺序

先接启动、终端、进程、权限、服务和资源准备，再接预览和电脑控制。说明公共改动对 Windows 的影响。Mac 外观和开场动画分别审阅。

最低系统版本配置取合作者的 macOS 14.0 目标，尚未获得 macOS 14 真机验收。首批以 Apple Silicon 为目标。资源闭包、原生运行、批准/拒绝、停止后续跑及安装包分别验证。

.github/workflows/macos.yml 运行公共源码与平台合同检查；macos-build.yml 在 Apple Silicon 构建机运行 CLI、Services、Desktop、Rust 与 APP/DMG 构建，资源准备由 build/macos/prepare.mjs 进入。公共检查通过不能证明 DMG 可用，构建产物也需单独进行安装、系统权限与真实任务验收。

## 当前明确边界

工作区 Skill 的 URL 安装界面未接通服务方法，因此不对外显示。既有学习库的 Skill 列表与查看继续可用。Mac 原生电脑工具提供状态、辅助功能检查、截图、点击和键盘；权限设置调用同一 Swift 工具的显式查询/请求入口。每轮明确开关优先于环境默认。

Mac 窗口直播尚无 Services 流适配，不能调用 Windows Python 捕获流程；工具截图仍通过任务消息显示。完成 Mac 流实现与真实窗口选择验证后再启用直播按钮。源码/平台合同通过不等于这项能力已具备。

Mac WKWebView 只负责内置浏览和预览，不提供 CDP 端口；Agent 网页自动化继续使用 Playwright / Chrome DevTools MCP。原生电脑操作针对当前前台应用，不能据辅助功能接入宣称支持后台无打扰操作。

Win32 软件工作区只在 Windows 的服务装配中提供给 Agent，Mac 不注册此 MCP 能力；原生电脑控制不依赖该 Windows 实现。
