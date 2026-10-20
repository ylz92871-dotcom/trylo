# Trylo Desktop 1.0.3

[Windows 安装包](https://github.com/ylz92871-dotcom/trylo/releases/download/desktop-v1.0.3/Trylo_1.0.3_x64-setup.exe) · [便携 ZIP](https://github.com/ylz92871-dotcom/trylo/releases/download/desktop-v1.0.3/Trylo-Desktop-1.0.3-windows-x64-portable-core.zip) · [发布页](https://github.com/ylz92871-dotcom/trylo/releases/tag/desktop-v1.0.3)

默认使用随包旧 CLI；设置可切换新版 Trylo CLI 并切回。两个引擎共用固定 Node 24.14.1。旧 CLI 源码不进入公库。普通 Work、Code、桌宠保留；CoWork 后台独立，核心包不包含它。手机 APK 见 [mobile](../mobile/)。

旧 CLI 的 Bash 命令依赖本机 Git for Windows（Git Bash），本包不附带 Git。若显式设置 Git Bash 路径环境变量，使用 Windows 原生路径格式。

安装版使用当前用户目录。便携包完整解压后运行 `Start-Trylo.cmd`。启动脚本检查固定组件目录及其嵌套 EXE，沿用启动者已有权限，不请求提权。

本版修复桌面批准后仍被 SRT 拦截、只读模式错误清空工具、旧 CLI 精简启动丢失工具、搜索辅助程序缺失，以及原生 Windows 路径导致 CLI 无法启动的问题。下载字节与 SHA-256 见 `release.json`、`SHA256SUMS`。

这是未签名预览包。已验证实际子进程写入、搜索、批准/拒绝和四轮引擎切换；不代表全量原生应用输入、安装 GUI、真实模型或手机真机验收。旧 CLI 在结果后立即关闭输入仍可能触发 libuv 退出断言，此项未声称修复；Desktop 在轮次之间保持输入通道。详情见 [发行说明](../../docs/release/DESKTOP_1_0_3.md)。
