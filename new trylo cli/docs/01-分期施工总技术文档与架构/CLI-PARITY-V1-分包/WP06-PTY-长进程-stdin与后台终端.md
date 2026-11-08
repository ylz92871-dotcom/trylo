# WP06 PTY-长进程-stdin与后台终端

- 状态：已批准（依据用户要求独立文件夹拆分工作包；细化已授权版本范围）
- 阶段：P00 / CLI-PARITY-V1，普通 Agent 基底追平
- 负责人：Codex 编制；施工与独立复核人在领包时记名
- 最后更新：2026-10-04
- 依赖决策：[总版本合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/P00-CLI-PARITY-V1-复用复核接线技术规格.md>)、[分包ADR](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-CLI-PARITY-V1细分工作包.md>)、[仓库代码纪律](<D:/CC/trylo/new trylo cli/docs/00-总领/代码可读性可维护性与审计纪律.md>)；全部默认可复用，不查许可证。

- 所属原包：R1；角色：施工主责
- 主责能力：C08, C10, C11, C12, L18
- 接口前置：[WP05](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP05-平台shell与普通进程.md>)
- 集成联验：[WP07](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP07-取消-进程树清理与输出限额.md>)、[WP22](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP22-工具并行-子代理与团队.md>)、[WP23](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP23-日用TUI输入-渲染-键位与等待原因.md>)、[WP25](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP25-本地RPC-worktree与code-mode.md>)
- 代码纪律：[统一施工合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-施工纪律与交接合同.md>) 为本包第一门禁；本包不得简化其中要求。
- 施工状态：工作包已编制，不能据此认定实现或验收完成。

## 强制实际复核（2026-10-04用户决定）

本包每根关键接线在进入生产集成前，都要先提交实际复核记录。 按 [实际复核与路线确认](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-实际复核与路线确认.md>)、[实际复核表](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-单包施工交接模板.md>) 执行；本包的源码现状、平台支持和直接复用建议均是待实际证据确认的候选，不能凭Codex或其他模型的文档结论直接施工。

必须追到当前新版消费者、来源实际依赖/版本、已有helper/制品及最小闭包；先比较最短真实复用途径，运行有界探针并记录正常结果、失败/反例、hash和未验证范围。上层注释、工具名、status成功、搬运/注册和扫描不到vendor都不能替代真实实现/接线/就绪证明。已批准范围、Trylo唯一owner与代码第一门禁保持不变。

实际复核否定原建议时，把证据与更正同步写回本包、来源报告、必要ADR及主矩阵复用建议；不伪升能力成熟度。[WP04来源更正](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-WP04-Windows复用来源更正.md>)作为复核先例，不把它外推成其他包已经验证。


## 1. 用户结果与边界

直接复用 Codex utils/pty，交付能持续交互的真实终端。

本包接点/owner边界：**Process 会话 owner；PTY sidecar；stdin/resize/read 协议**。沿用Trylo的既有唯一owner，来源代码只提供机械实现；涉及的新合同先冻结版本、状态转换和迁移，再动实现。学习控制面范围沿用总规格，不因复用能力扩权。

## 2. 逐项施工范围与直接复用

下表是分包时快照；最新成熟度以 [主能力矩阵](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/evidence/2026-10-04-parity-v1/capability-coverage.json>) 和工程产出证据为准。

| ID | 能力 / 优先级 | 源码审计状态 / 接线成熟度 | 尚需闭合 | 直接复用建议 |
| --- | --- | --- | --- | --- |
| C08 | PTY/交互程序 / P0 | 缺失 / contracted | 无 PTY；交互命令无法形成 stdin/resize/输出会话。 | 直接复用 utils/pty 做 Rust helper，接新增 ProcessPort。 |
| C10 | 长运行命令 yield 与 session ID / P0 | 缺失 / contracted | 命令最多 120 秒；无 yield 后继续运行的 session ID。 | 取 unified_exec 句柄/终态逻辑和 utils/pty，新增进程会话工具。 |
| C11 | write_stdin 后续交互/轮询 / P0 | 缺失 / contracted | 无 write_stdin、持续轮询、空写读输出。 | 复用 unified_exec/write_stdin 及进程桥，别重新启动原命令。 |
| C12 | 背景终端可发现与停止 / P0 | 缺失 / contracted | 没有后台终端列表、查看输出、按 ID 停止的用户入口。 | 取 Codex /ps、/stop + process manager，接 TUI/工具目录。 |
| L18 | 后台命令、输出查询与停止（共用 C10） / P0 | 缺失 / contracted | 命令最多 120 秒；无 yield 后继续运行的 session ID。 | 取 unified_exec 句柄/终态逻辑和 utils/pty，新增进程会话工具。 |

源码定位与条件限制（先读这些行，再沿真实import/build闭包取文件）：

- **C08**：[C08源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:25>)；`core/src/tools/spec_plan.rs:1095` allow_tty；`utils/pty/src/pty.rs:128` spawn_process；`:44` ConPTY 支持探测；Stable 默认 true（unified_exec_tty）；tty 参数可选；Windows 原生实现；`codex-utils-pty` 窄 sidecar，复用 portable-pty 与 Windows backend
- **C10**：[C10源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:27>)；`core/src/tools/handlers/unified_exec/exec_command.rs:426` 请求 yield；`core/src/tools/handlers/shell_spec.rs:31` Windows 10–30 秒范围；`:216` session_id；常规；超时返回运行句柄，不能误当命令完成；`core/src/unified_exec/process_manager` 的句柄/终态合同
- **C11**：[C11源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:28>)；`core/src/tools/spec_plan.rs:1106` 注册；`core/src/tools/handlers/unified_exec/write_stdin.rs:58` handle_call、`:84` manager 调用；常规；空写轮询和真实输入区分；`unified_exec` 进程会话协议
- **C12**：[C12源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:29>)；`tui/src/chatwidget/slash_dispatch.rs:530` /ps、`:533` /stop；`core/src/session/handlers.rs:63` 清理；普通 TUI 可用；专门 app-server backgroundTerminals RPC 仍 Experimental（app-server-protocol/src/protocol/common.rs:723）；`unified_exec` manager + UI process list
- **L18**：[L18源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:43>)；普通路径；`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` 可禁用 schema 字段；[BashTool.tsx:241](<D:/CC/trylo/trylo cli/src/tools/BashTool/BashTool.tsx:241>)、[TaskOutputTool.tsx:208](<D:/CC/trylo/trylo cli/src/tools/TaskOutputTool/TaskOutputTool.tsx:208>)、[TaskStopTool.ts:107](<D:/CC/trylo/trylo cli/src/tools/TaskStopTool/TaskStopTool.ts:107>)

复用工程边界另见 [最小闭包、薄桥与sidecar建议](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/reuse-engineering.md>)。源码有入口不等于此包真实可用。

## 3. 包内接线任务与验收

### WP06.1 PTY helper 与会话句柄

施工：取 utils/pty 最小闭包，封装 spawn/read/write/resize/signal/exit；明确稳定句柄和终态。

验收：ConPTY 实际启动；pty/pipes 正确选择；helper 版本/协议不匹配显式失败。

#### 2026-10-04 Windows PTY 与制品集成决定

按 [实际来源复核与方向决定](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-实际复核-WP06-WindowsPTY与制品落点.md>) 施工。缓存 portable-pty 0.8.1 的 X_OK 在 Unix 条件分支内，Windows 有独立实现；当前仓库 Codex 锁的是 0.9.0 且使用自有 Windows backend，不能依据错误分支直接断言全部 Windows 程序失败。

PTY 不延后、不限为 ComSpec。先重现正确 target/版本的实际失败，再复用完整 Windows 机械闭包；sidecar 消费同一授权计划中的绝对 executable/argv，必要定位补丁与 WP05 共用规则，不重写 backend 或扩大权限。

WP06 可使用 `vendor-bin/pty/<platform>-<arch>/` 与 `scripts/pty/` 自有模块；共享 build/prepack、copy-vendor 入口由单 writer 串行添加最小调用 patch，保持 WP04 沙箱制品与校验不变。环境变量只能是明确覆盖项，默认必须从安装包定位 helper；exe 不进 src，不放宽门禁。上述是施工决定，尚未表示探针、修复或制品验收完成。

### WP06.2 yield 与后续输入

施工：复用 unified_exec 长运行句柄语义，连接 write_stdin、空写轮询、resize 和 EOF。

验收：yield 返回仍运行状态；后续输入改变进程行为；空轮询与真实输入不混淆；窗口尺寸真实生效。

### WP06.3 后台终端生命周期

施工：将持续输出和停止入口接既有任务/Session 服务，重启后不假装旧 OS 句柄仍可用。

验收：长进程可观察/停止；输出顺序、退出状态与进程一致；失联后进入核对且资源可回收。

## 4. 前置与跨包交接

接口前置包只交其被本包消费的稳定合同、真实adapter与证据，必须写清输入输出、失败/取消、兼容和版本；不要等待其全包所有条目验收。允许先做本包来源闭包、合同和红例工作，不能在依赖未接通时伪造功能成功。

本包给下游交：上述接点的真实实现、版本化合同与负例、适用平台结果、来源hash、变更/回滚patch和未闭合项。集成联验里的每个实际消费者须有调用链和行为证据；尚未连接的ID保持partial，最终由WP27汇总、WP28实机签收。

## 5. 纪律复核、风险与回滚

实现人和独立reviewer依 [统一代码纪律](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-施工纪律与交接合同.md>) 逐项检查：可读性维护性、唯一owner/类型、权限不扩大、错误终局、取消清理、提交后unknown、迟到/重复事件、持久化守卫、类型隔离和兼容。新增回归先留红，工程检查不提高原阈值；许可证按用户豁免不查。

直接抽取不允许复制旧runtime的大状态总管或把Codex core当普通Provider。source_missing、外部服务/模型/平台限制分别记录，不能以fixture替代真实账户与安装包。回滚按本包固定基线生成patch，保留用户原dirty改动、旧会话及兼容路径；若格式已经写盘，按迁移合同处理，不能删记录假装从未执行。

## 6. 必须提交的材料

1. 按 [单包交接模板](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-单包施工交接模板.md>) 填完整的施工记录，归档到P00工程产出；说明本包实际接通哪些ID。
2. 每根线的合同与来源闭包账、未修代码红例、适用检查日志、独立review发现与修复/复验。
3. 真实入口到副作用/输出/持久事实的证据；平台、provider、安装和TTY做了哪些及未做哪些。
4. 主矩阵中具体ID的证据更新、风险/缺件/未闭合项、rollback patch、可供下一包消费的接口版本。

包内任务逐根收口，文档“已批准”只代表本范围可施工，不代表代码完成。全量追平必须通过WP27与WP28，不以子任务completed或绿色单测替代。
