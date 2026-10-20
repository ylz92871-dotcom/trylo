# Desktop 1.0.4 — 新 CLI 权限与沙箱修复

运行时代码：`d1243695796d018dcffe67e07084624df1aa1523`。完整源码绑定与验证范围随发布资产提供。

## 修复与兼容

文件访问增加显式 workspace/reviewed/host 范围，贯穿读写、补丁、Notebook/PDF 分派和 Shell cwd/stdoutFile。默认独立 CLI 保留工作区边界；Desktop 的外部目标按当前权限模式批准。真实解释器支持变量、重定向与管道，静态工具 schema 和会话 catalog identity 保持兼容。

MCP 组合沙箱、委托及常驻子任务继承调用级审批；工具包的通用 read 分类不能跳过外部目标审批。当前明确拒绝优先于批准缓存。外部图片采用当前会话的已校验快照能力，历史引用和 warm transport 不携带授权。真实路径别名及导航辅助规则读取执行同一包含检查。

审批附带真实路径、命令和 cwd，不先读待批准文件，也不显示拟写入正文。没有新增依赖或学习授权入口。

## 验证

- CLI 完整 verify：11 步、4,227 个测试名称、38 项合同检查通过。
- Desktop 211 项回归与 9 项审批交互通过；集合有重叠，不合计为唯一用例数。
- 包内固定 Node：22 项新 CLI/MCP 实际权限效果与四轮新旧引擎切换通过。额外验证旧 CLI Read/Write/Glob/Grep 和 Git Bash 批准/拒绝。
- 106 个修改后的 JS/声明文件与最终源码编译结果逐字节一致；ZIP/NSIS 的 21,757 个资源逐文件哈希一致，CRC 通过。NSIS 可执行文件仅有精确 Tauri UNK/NSS 标记差异。
- 最终源码、前端、运行时、APK 资产及构建环境凭据值扫描通过，未发现配置密钥进入制品。

默认旧 CLI、双引擎、CoWork 剥离保持既定发布配置。Android 1.6.0 为此前同一签名 APK，真实构建来源保留为 desktop-v1.0.2。

## 已知边界

Windows 严格 Shell 隔离需要有效 SRT 环境，故障时明确拒绝，显式 host 模式采用调用者已有权限。旧 CLI Bash 需要本机 Git for Windows；立即 EOF/libuv 退出问题尚未修复。未进行安装 GUI、任意原生工具输入、真实模型普遍可靠性或 Android 真机验收。
