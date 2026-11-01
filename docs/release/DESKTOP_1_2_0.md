# Trylo Desktop 1.2.0

2026-11-02 · Windows x64 预览版

Trylo：面向长期协作的个人学习智能体。

## 本次更新

- 新增工具生产管理：在学习中心查看工具的生产计划、审批、证据与用途，启用前必须经过明确审批。
- 新增工具学习记录：展示真实的待审、部分检索与验证状态，未通过验证的工具不会显示为可用。
- 改进团队协作：团队进度按成员投影，补充成员交付与交接信息，长任务中断后更容易接续。
- 修复后台命令闪窗：Git 快照、diff、搜索、目录选择与 LSP 配置等后台命令不再弹出控制台窗口。
- 便携包改用图形界面启动器 `Start-Trylo.exe`，不再附带 `.cmd` 脚本；新版 CLI 补齐工具获取与 npm 安装闭包、子智能体检查点与学习控制。

工具生产的启用仍需要明确审批；学习记录不会自动授予工具权限。团队协作与个人学习的开关沿用用户设置。

## 下载与兼容

- [Windows 安装包（141.0 MB）](https://github.com/ylz92871-dotcom/trylo/releases/download/desktop-v1.2.0/Trylo_1.2.0_x64-setup.exe)
- [便携包（162.9 MB）](https://github.com/ylz92871-dotcom/trylo/releases/download/desktop-v1.2.0/Trylo-Desktop-1.2.0-windows-x64-portable-core.zip)
- [官网下载](https://trylocode.me/download/desktop/)

只包含新版 Trylo CLI，默认运行 trylo-v1；旧 CLI 与 CoWork 后台不随包分发。历史 Desktop 发布保留，Android 与移动端本次未重编。

## 验证范围

新版 CLI 源码构建通过，hermetic 测试 4884 个测试名全部通过（本机 `TEMP` 为 8.3 短路径时 3 组真实临时路径用例会失败，改回长路径后全部通过，属执行环境差异）。Desktop 类型检查通过；本轮受影响测试 5 个文件 24 项通过（协作协议、团队进度、工具学习记录、工具生产面板、CLI 命令）；4 项 Node 脚本测试通过；生产前端构建通过。

便携包 CRC 通过，5256 个条目；与暂存资源逐字节比对 5249 个文件一致；CLI 清单 3210 个文件摘要逐一匹配（入口摘要 `3eef0df4…`）。安装包解包后 5248 个文件与便携包逐字节一致，`trylo-desktop.exe` 仅有 3 字节 Tauri NSIS 标记差异。两种包均不含 `Start-Trylo.cmd`、`cli-legacy/`、`workd/`。

本轮没有运行 Desktop 全量测试、Services/Relay 测试和真实模型链路验收，也没有执行安装向导；以上结论只覆盖列出的范围。此包未签名。

详见 [验证摘要](DESKTOP_1_2_0_VERIFICATION.json)。

## 分发验收

见 [分发摘要](DESKTOP_1_2_0_DISTRIBUTION.json)。
