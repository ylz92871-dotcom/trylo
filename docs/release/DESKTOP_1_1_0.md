# Trylo Desktop 1.1.0

2026-10-27 · Windows x64 预览版

Trylo：面向长期协作的个人学习智能体。

## 本次更新

- 优化 UI：调整 Code、Work 与团队工作区，改善消息、工具结果和协作过程的查看体验。
- 新增账号模式：使用 Trylo 官方免费算力池和账号远程控制，需要先登录 Trylo 账号。
- 新增团队模式：支持 Personal Agent 作为用户代表加入 Team Agent，参与任务协作。
- 完善长任务性能：通过本轮长任务压力测试，改进上下文压缩、任务续接和后台进程状态保留。
- 修复 Subagent 部分已知问题，改善权限审批、上下文传递、后续输入和任务状态同步。

账号模式下的官方免费算力池受账号授权与额度限制；账号远程控制需要登录。自定义模型连接仍可在设置中配置。个人学习与团队代表参与按用户设置开启，学习不会自动授予工具权限。

## 下载与兼容

- [Windows 安装包（140.9 MB）](https://github.com/ylz92871-dotcom/trylo/releases/download/desktop-v1.1.0/Trylo_1.1.0_x64-setup.exe)
- [便携包（160.5 MB）](https://github.com/ylz92871-dotcom/trylo/releases/download/desktop-v1.1.0/Trylo-Desktop-1.1.0-windows-x64-portable-core.zip)
- [官网下载](https://trylocode.me/download/desktop/)

只包含新版 Trylo CLI，默认运行 trylo-v1；旧 CLI 与 CoWork 后台不随包分发。历史 Desktop 发布保留，Android 1.6.0 沿用原版，本次未重编。

## 验证范围

新版 CLI 完整 verify 11/11 通过（4585 个测试名、38 项合同）；Relay 62 项通过，Services 479 项通过、4 项跳过（实际 uv 独立验证）。两种包 CRC 和各 4954 个资源摘要匹配；便携包实际批准写入、拒绝写入、审批输入结束取消均通过。扫描未发现凭据。

Desktop 首轮全量测试为 3256 通过、45 失败、5 跳过；修正过时的界面断言、测试入口和私有旧 CLI 源码依赖后，全部失败文件的最终回放 13 文件 / 95 项通过。另有 11 项真实 CLI 子进程团队场景、1 项结构化交互、4 项 Node 脚本、2 项 Windows 完整性级别检查通过；没有再次运行完整 Desktop 全套。

本次实测 Service Host→账号免费池→真实模型 read_file 链路与模型上下文容量夹取。原生便携窗口启动、设置页面显示、正常关窗通过；没有进行安装向导或完整原生模型/团队任务验收。此包未签名。

长任务结论来自本轮现有压力记录：696 个已提交回执、2088 次真实输入、2199 次工具调用、63 次完成压缩；保留过往上下文超限负例及同会话恢复证据。此结果不等于所有模型或无限时长保证。

详见 [验证摘要](DESKTOP_1_1_0_VERIFICATION.json)。

## 分发验收

GitHub Release 已公开，六个附件的远端摘要与本地一致。官网下载已切换到 1.1.0，完整下载 140912956 字节安装包摘要匹配；首页与原有 App、账号、远程等路由保留。GitHub 历史 8 个发布、91 个附件未改动，官网 1.0.6 原件及下载响应保留。

网页视觉验收未完成：电脑工具无法可靠确认当前 Windows 浏览器 URL，已停止界面操作；HTTP 页面与资源摘要、响应头、Range 和完整下载验收通过。见 [分发摘要](DESKTOP_1_1_0_DISTRIBUTION.json)。
