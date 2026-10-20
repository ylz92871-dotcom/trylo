# Trylo Desktop 1.0.4

[Windows 安装包](https://github.com/ylz92871-dotcom/trylo/releases/download/desktop-v1.0.4/Trylo_1.0.4_x64-setup.exe) · [便携 ZIP](https://github.com/ylz92871-dotcom/trylo/releases/download/desktop-v1.0.4/Trylo-Desktop-1.0.4-windows-x64-portable-core.zip) · [发布页](https://github.com/ylz92871-dotcom/trylo/releases/tag/desktop-v1.0.4)

默认随包旧 CLI，设置可切换新版 Trylo CLI 并切回。固定 Node 24.14.1 随包提供。普通 Code、Work 与桌宠保留；CoWork 后台独立，核心包不包含它。手机 APK 单独放在 [mobile](../mobile/)。旧 CLI 源码不进入公库。

新版 CLI 修复文件范围、真实 Shell、子任务权限继承、图片发送时的二次拒绝，以及批准缓存覆盖当前拒绝的问题。外部目标按所选权限模式审批；审批可看到路径或命令，拟写入正文不放入预览。只读与工具包禁用仍有效。

完整 CLI verify 通过 4,227 个测试名称与 38 项合同检查。桌面 211 项回归、9 项审批卡片交互通过。包内固定 Node 实测外部读写、图片、Shell、MCP 的批准/拒绝，以及旧→新→旧→新切换；完整资源哈希和 CRC 已核验。测试范围有重叠，不合计为唯一用例数。

便携版完整解压后运行 `Start-Trylo.cmd`。严格 Windows Shell 隔离需要可用 SRT 环境；显式 host 运行沿用已有权限，不自动提权。旧 CLI 的 Bash 依赖本机 Git for Windows，Git Bash 路径需使用 Windows 原生格式。

这是未签名预览版。旧 CLI 立即 EOF 的 libuv 退出断言仍为已知问题；Desktop 轮次间保持输入通道。当前结果不代表安装 GUI、任意原生输入、真实模型普遍可靠性或手机真机验收。校验值见 `release.json` 和 `SHA256SUMS`；详情见 [发行说明](../../docs/release/DESKTOP_1_0_4.md)。
