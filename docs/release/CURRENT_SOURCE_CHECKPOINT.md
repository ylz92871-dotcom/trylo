# Current source checkpoint / 当前源码检查点

日期：2026-10-20。发布标签：`desktop-v1.0.4`。Desktop 1.0.4 默认旧 CLI，设置可切换随包新版并切回；CoWork 后台独立。旧 CLI 源码不公开，新 CLI 和工程源码公开。

本版集中修复新 CLI 的文件权限、路径别名、Shell 解释器、子任务审批继承、外部图片传输和拒绝优先级，补齐审批目标/命令预览。继承 1.0.3 的固定运行时、完整性标签和旧 CLI 兼容修复。

CLI verify 11 步、4,227 个测试名称、38 项合同检查全部通过；桌面回归 211 项、审批卡片交互 9 项通过。最终包内固定 Node 与新旧 CLI 实测权限、MCP、文件效果和四轮切换。ZIP/NSIS 逐文件绑定同一资源快照，秘密扫描通过。

Android 1.6.0 沿用 desktop-v1.0.2 同一签名 APK，单独提供。旧 CLI 的立即 EOF/libuv 限制保留；工程与模拟 provider 的实际进程结果不等同于安装 GUI、任意原生工具输入、真实模型或 Android 真机验收。

[本次发行说明](DESKTOP_1_0_4.md) · [桌面下载](../../result/desktop/) · [手机下载](../../result/mobile/) · [上次记录](DESKTOP_1_0_3.md)
