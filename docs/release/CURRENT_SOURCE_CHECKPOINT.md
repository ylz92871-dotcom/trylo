# Current source checkpoint / 当前源码检查点

日期：2026-10-20。版本标签：`desktop-v1.0.2`，同时包含 Desktop 1.0.2 和 Android 1.6.0 的源代码与下载索引。

本版在公库 `b373683` 上融合主目录代码。保留此前 PR #2/#4 的摘要完整性、取消、工具证据与读取来源修复，增加运行时完整性、写入路径、输入错误捕获、CLI 来回切换会话、手机连接和中继更新。工具 fork 来源清单包含 110 个生产 Python 模块。

公开核心包默认 `trylo-v1`，设置保留旧协议外接入口。旧 CLI 源码和引擎不进入公开核心包；本机另行重编译并验证旧协议兼容。普通 Work 使用 CLI，CoWork 继续独立。

## 当前证据

- 新 CLI 11 步 verify 全绿：4,206 个测试名称、38 项合同检查。源码扫描、类型、架构、许可证闭包分别通过。
- CLI 运行副本 2,784 个文件哈希及 962 个生产 JS 与最终 verify 构建一致；Service Host 的 147 个输入与随包 bundle 绑定。
- Desktop 权限/进程专项 47 项、切换/会话专项 75 项；较早的综合专项 264 项。重复测试不相加冒充唯一用例总数。
- 服务/浏览器/权限 142 项；Windows 工具 fork 专项 141 项及补充 15 项（包括真实 MCP 子进程握手与工具列表）。
- 实际 Low Node 向 Medium 目录写入 EPERM；修复副本标签后令牌为 Medium，实际写入通过。工作区内绝对路径创建/编辑通过，外部、设备和链接越界反例保留。
- Android 重新构建、lint 与签名校验通过，手机 UI/连接 25 项、中继 7 项通过。
- 原生 Desktop 已重新编译，NSIS/LZMA 安装包与高压缩 ZIP 完整性、资源和运行证据见 `result/desktop/release.json`；手机见 `result/mobile/release.json`。

## 证据边界

Windows 下载是未签名预览包。构建、模拟服务和实际 CLI 进程检查不等于干净机器安装、全量原生 UI、全部工具真实输入、CAD 端到端、真实模型可靠性或 Android 真机验收。现有用户进程未重启或终止。

[发布记录](DESKTOP_1_0_2.md) · [桌面下载](../../result/desktop/) · [手机下载](../../result/mobile/)
