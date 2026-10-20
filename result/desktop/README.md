# Trylo Desktop 1.0.5

[Windows 安装包](https://github.com/ylz92871-dotcom/trylo/releases/download/desktop-v1.0.5/Trylo_1.0.5_x64-setup.exe) · [便携 ZIP](https://github.com/ylz92871-dotcom/trylo/releases/download/desktop-v1.0.5/Trylo-Desktop-1.0.5-windows-x64-portable-core.zip) · [发布页](https://github.com/ylz92871-dotcom/trylo/releases/tag/desktop-v1.0.5)

修复 Windows 原生工具服务因扩展脚本路径报 `EISDIR` 而无法启动的问题。默认旧 CLI，设置可切换随包新版；普通 Work 保留，CoWork 后台独立。Android 1.6.0 见相邻 mobile 目录。

便携版完整解压后运行 `Start-Trylo.cmd`，保留随包资源目录。配置自己的模型/API 后使用。14 项路径回归、原生服务自动启动、包内完整资源和 CRC 核验通过；详情及证据边界见 [发行说明](../../docs/release/DESKTOP_1_0_5.md)。

未签名预览版。旧 CLI Bash 需要 Git for Windows，严格 Windows Shell 隔离需要可用 SRT。校验值见 release.json 和 SHA256SUMS。
