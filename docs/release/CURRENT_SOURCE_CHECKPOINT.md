# 当前源码检查点

2026-10-20。发布标签 `desktop-v1.0.5`。

Desktop 1.0.5 默认旧 CLI，随包新版可切换，CoWork 后台独立。本次修复原生 Node 脚本扩展路径导致 Service Host 无法启动的问题。14 项路径回归与真实原生服务启动验证通过，包内资源和 CRC 已核验。CLI/前端继承 1.0.4 的已验证资源，Android 1.6.0 沿用原签名 APK。

[本版说明](DESKTOP_1_0_5.md) · [路径修复](WINDOWS_NODE_SCRIPT_PATHS.md) · [上一版](DESKTOP_1_0_4.md)

## main 后续修复（2026-10-22）

main 已加入 Service Host 生命周期、工具安装、原生路径、首次工作区和共享桌宠修复。已发布的 `desktop-v1.0.5` 安装包及 Android 1.6.0 APK 保持原件；本次原生复核使用独立本地调试构建。

[本轮验证与边界](DESKTOP_DEBUG_2026_10_22.md) · [前一轮原生恢复验证](DESKTOP_DEBUG_2026_10_21.md)

## 2026-10-22 新版 CLI 排障源码更新

修复流式片段重复落盘、历史 envelope 重复校验、已结束流的尾部等待、显式输出/上下文窗口冲突，以及沙箱准备故障分类。已有权限边界保持，默认没有固定 low 或默认 32 轮/65536 输出上限。

本地完整 11 步 verify 通过（4236 个测试名、38 项合同），18 项实际 CLI/MCP 权限效果及 Windows 严格 Shell 检查通过。真实 AMD 短任务中保留 none 一次未调用工具的负例，不以 completed 冒充任务验证。会话片段增量编码的旧 reader 限制见 [排障记录](NEW_CLI_DEBUG_2026_10_22.md)。

本次为源码及开发构建更新，原 Desktop 1.0.5、Android 1.6.0 和参赛材料仍保持原件。
