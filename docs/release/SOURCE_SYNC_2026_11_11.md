# 源码同步 2026-11-11（Desktop 2.1.0）

从主开发目录同步本轮产品源码到公库并验证。方式与 11-02 一致：只取明确的产品文件清单，
排除官网源码、内部施工文档、内部验证记录、开发副产物与凭据；公库独立提交后快进推送。
来源为主开发目录 `4058d820..35da5631`（6 个提交）。版本号 Desktop 2.0.0 → **2.1.0**，
新版 CLI 保持 0.1.0。

## 范围

- **desktop-services**：software-workspace 服务、契约、进程所有者与 MCP 中继。宿主应用运行在
  独立 Win32 桌面；gate 是会话作用域的 loopback HTTP 服务；用户接管先排空在途 API 调用再放入
  用户输入；CAD 适配器改经同一中继访问 SOLIDWORKS / AutoCAD，不再抢占前台。
- **Desktop**：应用外壳挂载唯一的软件工作区面板，Code 与 Work 共用同一实现；生成媒体预览与
  生图/视频连接设置；composer 输入请求（自由回答与选项式提问）接入对话表面；内置工具包
  stage/verify 纳入 software-workspace 运行时校验。
- **新版 CLI**：生图与视频工具（需审批，产物写入工作区）、随包浏览器媒体创作技能、
  ask-user 自由回答与选项提问、自动压缩改用出厂估算并整段保留近期已结算交换、
  学习工具运行时治理修复（执行 `TOOL_EVOLUTION_MAX_GENERATION_MS`；终局工具记录改用自己的
  准入信号，调用方 abort 不再丢弃已完成调用的证据）。
- **remote-relay**：公库已跟踪的 20 个文件内容更新。
- **scripts**：工作区布局例外登记与其红例测试。

本轮共 **173 个文件**入库：166 个产品文件与主库提交**逐字节一致**、
6 个 software-workspace 运行时文件、1 个公库自持的 `.gitignore`。
逐文件来源与摘要见 [SOURCE_SYNC_2026_11_11.json](SOURCE_SYNC_2026_11_11.json)。

## 新增公开：software-workspace 运行时

本轮发布的 `desktop/scripts/stage-builtin-tools.mjs` 与 `verify-builtin-tools.mjs` 直接依赖
`desktop-services/toolchain/software-workspace/` 下的 6 个 Python 文件
（`controller.py`、`launcher.py`、`worker.py`、`native.py`、`applications.py`、
`guard/sitecustomize.py`，共 763 行）。这是 Trylo 自研的隐藏桌面 / 作业对象 / 窗口输入运行时，
不含第三方代码、凭据或本机路径。

主开发目录按其仓库规则把整个 `desktop-services/toolchain/` 视为不入库的打包输入；
公库沿用 2026-10-15 完整性审计为 Windows-MCP 建立的**精确白名单**做法，
只公开发行所需源文件。本轮照同一方式在 `.gitignore` 增加 7 行（1 条说明 + 6 条例外），
并以 `git check-ignore -v` 实测确认命中新增的 `!` 规则。这正是当年"打包脚本仍读取被省略源文件"
的同类缺陷，本轮不重复它。

## 排除

`new trylo cli/docs/**`（内部施工文档）、`desktop/docs/validation/**`（内部验证记录）、
`trylocode-site/**`（官网源码，自 11-02 起不进入公库）、`_workspace/**`（开发副产物与证据）、
凭据与部署脚本。

`new trylo cli/src/internal/learning/agent/subsystems/skill/vendor/legacy/` 下 11 个 JS 文件
被公库 `.gitignore`（`new trylo cli/src/**/*.js`）排除、公库从未跟踪，
本轮**不使用 `-f` 强行公开**。

## 一致性

| 检查 | 结果 |
| --- | --- |
| 入库 blob vs 主库提交 | **166 项逐字节一致**，0 项不同 |
| 是否覆盖公库既有适配 | 未覆盖。逐文件比对"公库提交前 vs 主库同步前"：88 项本就一致、60 项为公库新增、22 项不同——20 项是待同步的 remote-relay、1 项 `scripts/workspace-layout-pending.json` 同理、1 项 `.gitignore` 为公库自持。无任何 desktop / CLI 文件存在被覆盖的公库侧改写 |
| 凭据与本机路径扫描 | 172 个文件全量扫描，10 条命中全部为测试内合成占位值（`' test-only-key '`、`PRIVATE_MEDIA_KEY`、`PRIVATE_TOKEN_VALUE`、`synthetic-test-password-123`、`synthetic-amd-key-not-a-real-credential`、`synthetic-never-store` 等），逐条人工确认。无真实凭据、无本机绝对路径、无内网地址或部署主机 |

## 验证

| 验证 | 结果 |
| --- | --- |
| desktop-services 布局与自包含检查 | 无新违规；44414 个可运行文件无旧仓运行时引用 |
| desktop-services 全量测试（69 文件，串行） | **625 tests / 625 pass / 0 fail**，70.1s，进程干净退出 |
| desktop-services `pet-chain-smoke` | **2 项检查红**，判定为既有：桌宠三个文件与本轮无改动、host 的 diff 不碰 pet；单独启动同一个 exe 实测 **2 秒内桥端口 49372 即监听**（见下节既有债务） |
| Desktop 类型检查 `tsc --noEmit` | 通过 |
| Desktop 定向测试（本轮改动与新增的 15 个文件） | **15 files / 76 tests / 0 fail**，43.9s |
| Desktop Node 脚本测试 | **25 / 25 pass** |
| Desktop lint | 30 error，其中 **29 个分布在本轮未修改的 20 个文件**（既有）；本轮引入的 1 个（未使用变量）已修，该文件单独 lint 通过。App.tsx 6 条 react-hooks warning 为既有基线 |
| Desktop `format:check` | **环境红，未修改**。执行环境 `core.autocrlf=true` 与 `.prettierrc.json` 的 `endOfLine: lf` 相冲，检出即 CRLF，prettier 标记 **1086 个文件**（含本轮完全未碰者）。执行 `--write` 会制造上千个伪 diff，故不运行 |
| Desktop 全量 `vitest run` | **主动中止**。失败集中于 spawn 真实 CLI 的 live/process 测试（`无法读取新 CLI 的 provider 列表`、`等待原生停止回执超时`），单文件耗时 98s / 178s / 278s；其 CLI 侧同类用例经纯 HEAD 导出树证明在主库既有提交上同样失败。改用上表定向套件 |
| 新版 CLI 构建链 | 布局检查、`tsc`、内置技能与 vendor staging、`copy-pty-vendor`、发布清单 **11 个锁定组件**校验通过 |
| 公库提交树净室校验（`git archive` 导出待提交索引树，只含已跟踪文件） | **CLI `tsc` 通过**、`copy-builtin-skills` 通过、**Desktop `tsc` 通过**（需先按公库 `package.json` 安装依赖：公库既有 `node_modules` 缺 `hls.js`，补装后通过，属环境而非源码问题）。`copy-vendor` 与 `release-inventory` **未通过也未被宣称**：两者要求 `vendor-bin/srt-win-x64.exe` 等预编译二进制，公库只发布其源码（`vendor-bin/pty/` 源与 PROVENANCE），须先本地构建才能跑这两步，本轮未构建，故如实记为未验证 |
| 新版 CLI 压缩与技能契约（27 个文件，串行，安静条件） | 修复前工作树 **55 fail** / 纯 HEAD **45 fail**；修复后 **169 tests / 125 pass / 44 fail**，且这 44 个与 HEAD 的既有失败集**同名同集**（`after-fix ⊆ HEAD`，差集为空）。本轮另修好 1 条 HEAD 上原本就红的用例 |

## 本轮发现并修复的回归

对账时发现全量 verify 曾在内存只剩 0.56GB 的条件下运行，73 个失败里只有 19 个被安静复跑过。
补齐剩余 55 个后逐名比对，确认 **11 个只在工作树失败 = 本轮引入的回归**，已全部定位并修复：

1. **`compaction/rolling-request.test.ts`（9 条）**：本轮把"一个准备批次只允许一次自动压缩"
   写入闩（`compaction-gap.ts:150`），复位依赖下一次真实请求的口径（`budget-gate.ts:86`）。
   测试连调三次 gap 而中间没有请求。实测三个窗口在生产里都可达（存档后自动口径
   1074 / 2462 / 2462，触发线 9000），故修的是测试建模：先断言"本窗必须落到触发线以下，
   否则没有任何请求能复位探针"，再按 budget-gate 复位。
2. **`integration/skill-learning/catalog.test.ts`（1 条）**：随包浏览器媒体创作技能排在
   Board 学习技能之前，测试用 `list()[0]` 取技能。改为按来源选取。
3. **`e2e/model-summary-failure.test.ts`（1 条）**：自动维护按出厂估算计价后，
   旧 fixture 的假 `usage: 9500` 触发装置失效；且窗口总保留最近一个已结算交换。
   改为把真实压力做进被替换的前缀，并把断言回到本测试真正的意图——工具调用与结果
   配对完整、被检查的读操作按 id 带真实内容存活。实测打点确认单个大结果场景下
   `nothing_to_reduce` 是正确守卫（真正的天花板另有 forced rescue 路径），未放宽该守卫。

## 既有债务登记（不属本轮，未在此发布窗口内改动）

以下均已在"纯 HEAD 导出树"上复现，属主库既有提交状态，本轮修复未使其变差
（工作树失败集是 HEAD 失败集的子集）：

- 新版 CLI：10 项快速失败；压缩/stdio/web 相关超时簇 8 项（HEAD 为 9 项）；
  `tool-retention` 的预算口径断言（该断言与"整段保留 32k 字符结果"在 1 token/字符的
  保守准入界下互斥，需重定口径而非改实现）；一处 `loop → surface/cli` 分层违规；
  `verbs.ts` 430 行超出 400 行门禁。
- desktop-services：`pet-chain-smoke` 的 2 项（`launched` 在 spawn 拿到 pid 时即置真，
  而该 smoke 要求以桌宠桥端口为准）。
- Desktop：29 个 lint error、`format:check` 的行尾环境冲突、spawn 真实 CLI 的 live 测试。

这些留作独立专项，不与版本发布混做。
