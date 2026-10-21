# 当前源码检查点

2026-10-20。发布标签 `desktop-v1.0.5`。

Desktop 1.0.5 默认旧 CLI，随包新版可切换，CoWork 后台独立。本次修复原生 Node 脚本扩展路径导致 Service Host 无法启动的问题。14 项路径回归与真实原生服务启动验证通过，包内资源和 CRC 已核验。CLI/前端继承 1.0.4 的已验证资源，Android 1.6.0 沿用原签名 APK。

[本版说明](DESKTOP_1_0_5.md) · [路径修复](WINDOWS_NODE_SCRIPT_PATHS.md) · [上一版](DESKTOP_1_0_4.md)

## main 后续修复（2026-10-22）

main 已加入 Service Host 生命周期、工具安装、原生路径、首次工作区和共享桌宠修复。已发布的 `desktop-v1.0.5` 安装包及 Android 1.6.0 APK 保持原件；本次原生复核使用独立本地调试构建。

[本轮验证与边界](DESKTOP_DEBUG_2026_10_22.md) · [前一轮原生恢复验证](DESKTOP_DEBUG_2026_10_21.md)
