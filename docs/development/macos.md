# Mac 接入指南

公库已提供 Mac 原生文件打开、平台配置和资源准备接入口。完整 Mac 适配待接入，prepare.mjs 会明确报告这一状态。

## 接入来源

从最新公库 main 拉开发分支，逐项迁入 [Ai-JUX-02/trylo 的 MacOS 分支](https://github.com/Ai-JUX-02/trylo/tree/MacOS)，保留作者归属。[原 PR #6](https://github.com/ylz92871-dotcom/trylo/pull/6) 已关闭且未合入，接入前核对最新提交。来自其他适配版本的重复实现先审阅，再确定来源。

## 代码落位

| 能力 | 位置 |
| --- | --- |
| 原生菜单、Dock、窗口关闭重开、文件夹选择 | desktop/src-tauri/src/platform/macos/ |
| WKWebView 浏览器实现 | 所属原生预览/浏览器模块，通过既有接口选择 |
| 共用快捷键与界面接线 | desktop/src/host-adapter/ 和所属功能模块 |
| Mac 样式覆盖 | desktop/src/styles/platforms/，限定 Mac 属性 |
| Keychain | CLI 的 adapters/credentials/macos/ |
| Seatbelt 和 Shell 处理 | CLI 的 adapters/sandbox/macos/ |
| PTY 和子进程停止 | CLI 的 adapters/process-session/ |
| 电脑权限、截图、键鼠接线 | desktop-services/src/tooling/computer-control/macos/ |
| Swift 工具源码 | desktop-services/toolchain/computer-control/macos-mcp/ |
| 工具定义、版本、平台依赖 | tooling/manifests/ 与既有 toolchain 注册表 |
| 资源准备、DMG、签名与公证 | desktop/scripts/build/macos/ 和 tauri.macos.conf.json |

电脑控制接入口选用 Mac 合作者的 macos-computer 包标识。服务名和工具 schema 由接入后的 manifest 与 MCP 发现确认。沿用现有风险分类、用户开关和审批链，实际健康检查证明工具可用。

## 接入顺序

先接启动、终端、进程、权限、服务和资源准备，再接预览和电脑控制。说明公共改动对 Windows 的影响。Mac 外观和开场动画分别审阅。

最低系统版本配置取合作者的 macOS 14.0 目标，尚未获得 macOS 14 真机验收。首批以 Apple Silicon 为目标。资源闭包、原生运行、批准/拒绝、停止后续跑及安装包分别验证。

.github/workflows/macos.yml 当前只运行公共源码与平台合同检查。完整构建接通后再加入原生和资源验证。公共检查通过不能证明 DMG 可用。
