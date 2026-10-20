# Trylo

[English](README.md) | [简体中文](README.zh-CN.md)

Trylo 是一个个人学习智能体项目，包含原生桌面、新版 TypeScript CLI、Work 工作流和 Android 远程工作台。

**当前状态：Alpha。** Desktop 1.0.5 预览修复原生工具服务入口路径导致的启动失败，并包含新版 CLI 权限修复；Android 1.6.0 沿用 desktop-v1.0.2 已构建的同一签名 APK。工程检查、实际子进程验证与原生 UI、真实模型和真机验收分别记录。

下载：[Windows 桌面版与校验值](result/desktop/) · [Android 手机 APK](result/mobile/)。Desktop 预览默认随包旧 CLI，设置可切换随包新版并切回；CoWork 继续作为独立可选依赖。

10 月 20 日修复运行时完整性、工作区内绝对文件路径、输入诊断及新旧 CLI 切换的上下文交接，同时同步手机连接和最新工具源码。见[发布记录](docs/release/DESKTOP_1_0_5.md)与[源码检查点](docs/release/CURRENT_SOURCE_CHECKPOINT.md)。

## 从哪里看

| 目录 | 主要职责 |
| --- | --- |
| [new trylo cli](new%20trylo%20cli/) | CLI/TUI、执行循环、协议、权限、会话恢复和学习 |
| [desktop](desktop/) | React + Tauri 原生桌面 |
| [desktop-services](desktop-services/) | 本地服务宿主、工具、浏览器、远程和桌宠服务 |
| [new_tool](new_tool/README.md) | Windows-MCP fork source, tooling provenance and pinned dependency setup |
| [work](work/) | 工作流、托管运行适配和交付物 |
| [mobile-app](mobile-app/) | Android 应用和远程工作台 |
| [trylocode-site](trylocode-site/) | 网站源码 |
| [docs/architecture](docs/architecture/README.md) | 模块边界、状态所有权、当前接线与目标结构 |

用户学习、Agent 学习和执行分别建模。学习产生的提案和证据不能授予执行权限。文档会区分设计目标、现有实现和实际验证结果，不把它们混成同一种完成状态。

## 开发与构建

各应用先沿用现有 package.json 和锁文件。进入新版 CLI 目录后，`npm ci` 安装锁定依赖；`npx tsc -p tsconfig.json --noEmit` 检查 TypeScript 源码。

完整 CLI 打包还需要来源台账中固定的沙箱和原生辅助程序。Desktop 打包会组装 CLI、Node、服务和 sidecar。部分获取/构建步骤目前仍依赖本地输入，正在整理为可复现流程，尚不能宣称新克隆后一条命令完成发行构建。

## 已知未完成项

- 公库源码默认使用新版 `trylo-v1` CLI，打包不包含旧 CLI 引擎。旧协议适配仅供显式配置的外部运行时使用。
- Work 的 vendor/构建闭包、读取历史证据的测试仍需整理。
- 新目录预览是迁移目标，尚未成为当前运行布局。
- 原生桌面、安装制品和 Android 真机验收与源码检查分别记录。

详见[本次快照说明](docs/release/CURRENT_SOURCE_CHECKPOINT.md)、[架构说明](docs/architecture/README.md)和[迁移顺序](docs/development/repository-layout.md)。

本次只公开新版 CLI，不包含旧 CLI、官方专有 CLI 发行件、研究仓库、凭据、原始会话/录音录像和本机构建缓存。第三方组件保留各自许可证和来源声明。

项目自产代码沿用 [Apache-2.0](LICENSE)，另见 [NOTICE](NOTICE) 与组件来源说明。源码更新、网站部署和二进制发行分别进行。

Tool source restoration and checks: [2026-10-15 source audit](docs/release/SOURCE_COMPLETENESS_2026_10_15.md). From the repository root: `node scripts/release/check-source-completeness.mjs`; dependency setup: `node scripts/setup-repository-tools.mjs --install`.

当前主库同步与验证：[当前快照与验证](docs/release/CURRENT_SOURCE_CHECKPOINT.md)。下载：[Desktop](result/desktop/) · [Android](result/mobile/)。

## 公开源码构建前置条件

Windows x64 / Node >=22：先从仓库根目录运行 `node scripts/setup-cli-native.mjs --install`，再在本目录 `npm ci` 和 `npm run build`。PTY 固定制品随库提供，沙箱 helper 按固定版本和摘要显式获取；构建本身不会自动下载。详见[源码构建说明](docs/development/build-from-source.md)。其他平台 PTY 和完整 Desktop 安装包不在本轮验收范围。
