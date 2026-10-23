# Trylo Desktop 1.0.6：仅新版 CLI

2026-10-24，Windows x64 未签名预览版。仅包含并默认使用新版 Trylo CLI（trylo-v1）；旧 CLI、CoWork 后台均未打包。普通 Code、Work 与桌宠保留，固定 Node 24.14.1 随包提供。

旧版保存的 legacy 选择及入口在读取设置时迁移为新版，模型连接与权限设置保留；原始存储仍可供回退读取。应用标识继续使用 me.trylocode.trylo。安装前退出正在运行的 Trylo，便携版完整解压后运行 Start-Trylo.cmd。

构建源码：`7fd213d61ca54eb54a9bc34fe998e8ad2d38e3e8`；本地对应 `39342796895ffd2d62df93de6b923b993fca7a00`。本次重新编译当前产品源码及前端、Service Host、桌宠，包含 10 月 24 日已同步的源码修复。官网更新未纳入。

验证：21 项设置/运行时回归、类型检查、改动文件 lint、源码完整性检查通过。固定 Node 在隔离目录中实际写入前请求批准。便携 ZIP 与 NSIS 安装包 CRC 通过，每种包逐项对比 4900 个资源文件；新版 CLI 的 2860 个清单文件摘要一致。便携包解压后使用随包 Node，批准写入成功、拒绝未写入、批准通道关闭后取消，均通过。扫描未发现用户凭据文件或常见 token；npm 自带的短 PEM 占位示例已区分。

本轮没有运行安装向导、原生 Desktop 界面全流程或真实模型验收。独立 CLI 严格 SRT 批处理的 ACL 回收旧问题仍未修复；Desktop 命令执行使用显式 host 模式，审批、文件范围与只读策略仍有效。

[安装包](https://github.com/ylz92871-dotcom/trylo/releases/download/desktop-v1.0.6/Trylo_1.0.6_x64-setup.exe) · [便携包](https://github.com/ylz92871-dotcom/trylo/releases/download/desktop-v1.0.6/Trylo-Desktop-1.0.6-windows-x64-portable-core.zip) · [校验值](https://github.com/ylz92871-dotcom/trylo/releases/download/desktop-v1.0.6/SHA256SUMS) · [验证清单](DESKTOP_1_0_6_VERIFICATION.json)

Android 1.6.0 沿用原签名构建，本次没有重新编译手机 APP：[下载 APK](https://github.com/ylz92871-dotcom/trylo/releases/download/desktop-v1.0.5/Trylo-Code-v1.6.0.apk)。
