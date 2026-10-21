# Desktop 调试续检（2026-10-22）

本轮接续 2026-10-21 的原生验收，处理工具安装失败和共享桌宠清理。源码修复在主开发目录完成；构建与真实安装使用独立候选和测试数据，不覆盖已有 Desktop 1.0.5 发布物、参赛材料或日常配置。

## 已复现并修复

- **桌宠跨实例误杀**：原生关闭流程无条件执行 `taskkill /IM TryloDesktopPet.exe /T /F`；Service Host 的 `/PID /T` 清理也会覆盖它启动的共享桌宠。移除全局按名称清理，保留原始进程句柄，按进程快照和创建时间识别所属工作进程，并保留桌宠及其子树。仅断开本客户端；最后一个客户端离开后的退出仍由桌宠既有的超时机制负责。
- **打包缺少 npm**：原发布目录只有固定 Node 解释器，嘉立创 EDA/KiCad 的固定源码构建因 `npm_missing` 失败。构建阶段现在校验并放入 npm 11.11.0 完整运行依赖，发布清单要求入口存在；构建子进程的 PATH 包含打包 Node，无需系统安装 Node。
- **原生 npm 脚本路径再次触发 EISDIR**：真实桌面使用带 `\\?\` 前缀的 Node 可执行文件，npm 入口跟着带此前缀，导致 Node 的 JS 入口解析失败。已复现并修正 JS 参数及 PATH 中的磁盘/UNC 路径；可执行文件和未知设备命名空间保持原样。
- **Python 安装临时路径过长**：Windows-MCP 的 editable wheel 构建在深层安装目录内继续拼接临时目录，真实返回 `WinError 206`。改用短、独占的命令临时目录并在完成后清理；uv/npm 默认使用工具目录内独立缓存，保留显式缓存配置。
- **备用安装的真实错误被遮蔽**：在线 `uv sync --locked` 失败时，原逻辑错误地返回首次离线缓存错误。现在保留最后一次失败，并避免只截取解释器/进度前缀。
- **重复安装相互破坏**：两次同包安装同时进入相同时间戳的 staging 目录，真实复现 `rename ... uv.lock: ENOENT`。同包请求现在共用一次进行中的安装；完成后仍可重试。
- **KiCad 缺失条件检查过晚**：现在在下载、编译及替换既有版本前检查 KiCad Python 和 npm；缺少 KiCad 时给出固定、可操作的中文提示。
- **首次启动写死示例工作区**：原安装版默认进入 `C:/work/demo-ws`，开发目录则写死本机工程路径。原生入口现在先取得用户应用数据中的可写 Workspace，再启动 CLI、历史和监听器；已有工作区索引仍优先，错误/超时进入既有恢复界面。
- **后台进程弹终端并抢焦点**：真实 Service Host 恢复时出现可见终端窗口。Service Host、管道 CLI、语言服务器和可选 workd 现在按后台方式启动；原生检查覆盖前两者，可选 workd 未随候选打包。
- **桌宠静默启动崩溃**：以原生路径启动桌宠，复现 `.NET UriFormatException`，退出码 `3762504530`。WPF 把 `\\?\` 本地图片路径当成 URI 解析；三处图片入口改为 FileStream + OnLoad，保留文件路径语义并及时关闭流。独立压缩构建、原生自动启动和 TCP 连接已复核。

进程清理使用已有 Windows SDK 对应 API 依赖的固定版本；没有通过修改系统 ACL、关闭安全检查、放宽 hash 或改动用户全局模型配置来通过测试。[Windows 进程快照 API](https://learn.microsoft.com/en-us/windows/win32/api/tlhelp32/nf-tlhelp32-createtoolhelp32snapshot)。npm 版本与项目已固定的 [Node 24.14.1](https://nodejs.org/en/download/archive/v24.14.1) 配套，归档以固定 SHA-512 验证。

## 验证证据

本机审计目录：`Temp/desktop-debug-20261022/`。失败原件和后续结果分开保留。

| 层次 | 结果与边界 |
| --- | --- |
| 安装故障回归 | 先失败再修复：在线错误、短临时目录、同包并发；见 `install-tests-before.log`、`install-concurrency-before.log` 和 after 日志。 |
| 工具服务回归 | 161 项通过，涵盖安装、固定依赖校验、健康状态、CAD 条件和工具配置。见 `tool-regression-final.log`。 |
| 前端生命周期及设置回归 | 17 文件、262 项通过，包含首次启动等待/失败/超时、工作区历史保留。类型检查与五个新增/修改 TS 文件严格 lint 通过。App.tsx 的 9 条既有 Hook 依赖警告与 HEAD 原文对照一致，完整零警告 lint 仍未通过。见 `frontend-tests-final.log`、`typecheck-bootstrap.log`、`lint-scoped-final.log`、`app-lint-baseline.log`。 |
| 桌宠协议与 npm 校验 | 19 项通过。见 `pet-npm-tests.log`。 |
| Windows 真实进程 | 本测试创建的 host/worker 退出，桌宠分支、其 worker 和另一同名实例存活；重复 stop 保持范围，最后按持有句柄清理全部测试进程。见 `process-tests.log`；唯一 ignored 项是供测试启动的进程入口，不是未执行的验收。独立源码 harness 的严格 clippy 通过。 |
| 原生工作区目录 | 2 项真实文件系统测试通过，覆盖中文路径、可写目录、重复启动保留已有文件和无效父路径报错。见 `workspace-native-tests.log`。 |
| 真实工具安装 | 固定 Windows-MCP 0.8.5、嘉立创 EDA 1.4.0 安装成功；仅保留 System32 的 PATH 场景也通过。见 `install-minimal-path-*.json`。测试仍使用机器现有 uv，不宣称无需 Python 管理运行时。 |
| MCP 协议 | 安装后的真实 stdio 初始化和 tools/list 分别准确返回 14/59 个工具。见 `mcp-install-smoke.json`。这是协议发现证据，不代表每项电脑操作或 CAD 应用动作已验证。首次 Windows-MCP 冷启动曾超过 30 秒，后续重试通过，未把首次超时改成成功。 |
| KiCad | 本机未检测到 KiCad Python；验证了缺失条件与固定提示，未向外部 KiCad 环境写入依赖，未宣称真实 CAD 操作成功。 |
| 原生构建和界面 | 独立候选构建及界面验收的最终结果以 `native-build.json`、`native-launch.json`、原生观察与退出记录为准，以下补充。 |

首次直接从带特殊权限标签的工作区执行测试，出现临时目录/缓存拒绝访问；改用普通临时目录内相同解释器重新复现，并区分了工作区环境问题、GitHub 偶发连接失败与产品缺陷。没有删除失败证据或改变系统安全设置。

## 原生复核

最终主程序 SHA-256：`72690f5ac49f3773fc659ecbbe43507d03d9265847d7f4fbdeb3b7213edaddab`。桌宠 SHA-256：`988b52ec214751ff9869a535e8a28c8a631a5ecf8900d15824ca13acd3819521`。候选沿用 1.0.5 版本号，但使用独立调试标识；不是原 GitHub 1.0.5 安装包。完整构建与源码绑定分别见 `native-build.json`、`runtime-bundle.json`、`pet-build.json`。

- 新 WebView 配置首次启动显示“本地工作区”，真实 CLI cwd 位于用户应用数据的 Workspace，退出后再次启动保持该工作区。
- 实际点击安装 Windows-MCP 后显示可用；嘉立创工具在原生 npm 路径修复前失败，后台自动恢复后重试成功并显示可用；KiCad 显示缺少 KiCad 9+ 的固定提示。见 `native-tool-install-ui.txt`、`native-tool-retry-ui.txt`。
- 旧 CLI 默认值、新 CLI 自动入口选择及保存后再次打开仍选中新 CLI，均已观察；随后恢复旧 CLI 并保存。打包新 CLI 的 `--help` 实际执行成功。本轮没有发送真实模型回合，不将这些证据扩大为双内核真实模型任务验收。
- 修复后的桌宠由真实 Service Host 自动启动，使用的仍是此前会崩溃的原生路径；设置显示 Running，TCP 连接建立。见 `native-final-behavior-ui.txt`、`native-pet-auto-start.json`。未将 TCP/状态证据扩大为全部桌宠交互的视觉验收。
- 最终 Desktop PID 9656、Service Host 47688、桌宠 57292；桌宠确实为该 Host 的后代。第二客户端连接后正常关闭 Desktop：主程序退出码 0，其余所属进程退出，桌宠仍存活超过 90 秒并服务第二客户端。见 `native-final-owned-before-close.json`、`native-final-shared-before-close.json`、`native-final-shared-stable.json`。
- 最后一个测试客户端断开后，桌宠自行退出；最终扫描无诊断主程序、Service Host、CLI、WebView 或桌宠残留，见 `native-final-cleanup.json`。诊断配置、原始失败和已发布参赛制品分别保存。
