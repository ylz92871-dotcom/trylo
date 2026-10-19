# Trylo Desktop 1.0.2

[下载 Windows x64 安装包](https://github.com/ylz92871-dotcom/trylo/releases/download/desktop-v1.0.2/Trylo_1.0.2_x64-setup.exe) · [便携 ZIP](https://github.com/ylz92871-dotcom/trylo/releases/download/desktop-v1.0.2/Trylo-Desktop-1.0.2-windows-x64-portable-core.zip) · [发布页](https://github.com/ylz92871-dotcom/trylo/releases/tag/desktop-v1.0.2)

这次重新编译原生程序、Service Host、新版 CLI 和压缩桌宠。默认使用新版 Trylo CLI；设置保留旧协议切换，旧 CLI 通过用户自己的外部路径提供。手机 APK 见 [mobile](../mobile/)。

核心包保留 Code、普通 Work、桌宠与随包 Node；不包含 CoWork 后台，也不依赖它启动。既有 CoWork 实验依赖仍单独下载。

安装版使用当前用户目录。便携版完整解压后运行 `Start-Trylo.cmd`，启动脚本只处理四个已知随包 EXE：普通启动使用 Medium，用户已显式以管理员启动时沿用已有 High 权限，避免 Low 解压目录降低工具权限；脚本不请求提权。

本版修复工作区内绝对文件路径被误拒绝、输入权限探针漏查启动器、权限缓存滞后，以及新旧 CLI 来回切换复用不完整会话的问题。版本与 SHA-256 见 `release.json`、`SHA256SUMS`。

这是未签名的 Windows 预览包。工程门禁、模拟服务与实际子进程验证已完成；未宣称干净机器安装、全部工具输入、CAD 全流程或真实模型可靠性已经验收。
