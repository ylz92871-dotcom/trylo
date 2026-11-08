# P00-CLI-PARITY-V1：全量复用复核接线工作包

> 2026-10-07 用户明确取消：删除 Cloud 任务平台、自托管/BYOC runner、模板部署和厂商私有服务接入的施工与验收要求；保留现有远程控制及后台任务、长进程、日志、取消、恢复、定时执行和条件监控，沿用现有执行体系。见 [最新范围决定](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-07-ADR-WP26范围收缩与本地后台能力保留.md>)。这不是暂缓或欠账；172 项仅为历史基线登记，C80/A05 从当前交付范围排除，其他条目取消的私有服务子项不计 PASS。



- 状态：已批准（用户 2026-10-04 明确要求“出工作包，开始直接一个超大版本的复核接线”；范围来自用户授权，工程细节按仓库纪律执行）
- 阶段：P00 基底追平统筹，跨 P03/P07/P08；学习合同不增宽
- 负责人：Codex；既有独立 reviewer 按四眼规则复核
- 最后更新：2026-10-07
- 依赖决策：用户当前决策、仓库 AGENTS.md/$trylo-code-quality、[代码纪律](<D:/CC/trylo/new trylo cli/docs/00-总领/代码可读性可维护性与审计纪律.md>)、[顶层架构](<D:/CC/trylo/new trylo cli/docs/00-总领/TRYLO-LEARNING-AGENT-顶层架构与目标.md>)、[172行审计](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-逐项对照-TryloCLI与Codex-基础Agent缺口与直接复用建议.md>)
- 复用授权：全部默认可复用，不查许可证；仅此项覆盖旧准入限制。其余代码纪律完整保留。

## 1. 版本合同

历史对照保留 169 个基线条目与 3 个接线缺口；用户删除 C80/A05 两个整项及厂商私有接入子项，当前交付按剩余 170 个 ID 的批准子能力验收。条件、实验及高级入口保留目标和开关性质；基线缺件不可复制空壳后报完成。重叠能力施工一次。附录每个 ID 有唯一交付包 owner，并在机器矩阵记录阶段和证据。

超大版本是交付范围，不是超大模块或一次性接通库存。直接取现成源码及最小必要依赖闭包，桥接只做类型、配置、IO、生命周期。Trylo 的 Loop、Protocol、Permission、Session、Learning 保持唯一 owner。完整 Codex Agent 只能作为委托后端，不是 ProviderPort；问答答案不当权限票据。

dirty tree 是用户现有成果，本轮前置状态留档，不 reset、不覆盖其他目录、不整包继承旧 lockfile、不推私库。门禁红先修，不能调高阈值、手改 reachability 或删失败测试。

## 2. 第一门禁与每根线的标准工序

1. 先写行为合同、状态 owner、输入输出、失败/取消/timeout/unknown 与兼容说明。
2. 可读性/维护性优先：函数保持一层抽象，生产文件受既有上限约束，runner/reducer 冻结面只拆不堆。失败不能被其他绿门抵消。
3. 跑前置工程门禁；未解决红门之前不新增功能。
4. 合同回归先在未修复代码上留红；新门禁另做违规注入。
5. 留来源 commit/hash、用途及实际依赖闭包；不 import open/，不拉 fake/fixture 进生产图。
6. 一根线接通，跑组合合同和适用平台检查，absent 开关保留旧行为。
7. 独立 reviewer 复核控制流、错误终局、唯一 owner、权限、取消和恢复，问题先修。
8. 写施工记录、真实证据、限制、回滚 patch，再更新成熟度。

许可证第8项按用户授权不执行。临时验证 runner 从原 verify 原文派生，仅替换第8项调用；原脚本不改。结果只能称“10项工程检查 + 第8项用户豁免”，不得称原11/11。来源、闭包和类型边界仍须审计，见同日 ADR。

## 3. 十个交付包及验收

| 包 | 直接复用源 | 唯一接点/owner | 最小真实完成条件 | 前置 |
| --- | --- | --- | --- | --- |
| R1 进程/终端 | Codex shell-command/utils-pty/unified_exec；旧 shell providers | 新 ProcessPort；现 ShellSpawner 兼容 adapter | PowerShell、PTY、stdin/resize/yield、后台停止、后代清理、限额输出 | R3/R10a |
| R2 持续执行/输入 | 旧输入队列；Codex turn_input/input_queue/compact/token | 既有 pendingInput/CompactionPort；TUI 发命令 | 运行中追加要求改变后续操作；连续两次压缩保留约束；取消结果配对 | R1/R3 |
| R3 耐久会话/恢复 | 现 NDJSON/recovery；旧 sessionStorage、Codex rollout 增量写/恢复外围 | 现 SessionPort 单 writer；窄 ExecutionProgressPort | intent fsync→执行→结果 durable→settled；断进程恢复；unknown 禁止重放；fork/迁移 | 无 |
| R4 修改/审阅/回退 | Codex apply-patch/delta/turn_diff_tracker；旧 StructuredDiff/fileHistory | ToolPort/Permission/Checkpoint/Review | 多文件新增/删除/移动、CRLF、部分失败、带原有修改的范围回退 | R3/R10 |
| R5 导航/文档 | Codex file-search；旧 ripgrep/PDF/Notebook/LSP | 既有 reader/tool；LSP/PDF 窄服务 | 大仓库不漏；Notebook cell/PDF 范围；真实定义/引用/hover/符号 | R3/R10 |
| R6 Skill/MCP/Plugin/Hooks | Codex skills/rmcp；旧 SkillTool/loadSkillsDir/plugins/hooks | 现 context/catalog/McpClient；外围安装配置 | 安装→模型实际消费；resources/OAuth/elicitation；卸载停止；Hook 权限取消 | R3/R10 |
| R7 问答/Plan/Task/子代理 | 旧 AskUserQuestion/Plan/Task CRUD/agent；Codex multi_agents | UserInputPort/TaskPort；现 SubagentRuntime；批准仍 PermissionPort | 回答影响任务；计划转执行；并行子代理及 followup/cancel/resume | R1/R2/R3/R6/R9 |
| R8 日用 TUI/入口 | 旧 Markdown/Table/Diff/Vim/keys/styles/commands | 现 TUI 服务与自有协议投影 | 中文、宽窄窗口、长输出、编辑器、等待原因、diff、会话 picker/headless | R1/R3/R4/R7 |
| R9 Provider/媒体/搜索 | 旧 Anthropic/cloud；Codex Responses/auth/catalog/image/realtime | ProviderPort/CredentialPort、自有内容块 | 登录→doctor→工具任务；图片/schema/effort；国模现路保留；真实搜索来源 | R3/R10 |
| R10 权限/隔离/后台与现有远控 | Codex OS sandbox/policy/进程机械层；旧 workd/team/cron | Permission 唯一 owner；隔离/本地委托/调度及已有远控接点 | OS 真隔离；本地后台/定时监控/取消恢复；已有远控薄接线 | R10a先于R1；R10b后于R1/R4/R6/R7/R9 |

每个包分开交合同、来源记录、代码/组合测试、红例、独立复核、平台/实机证据和回滚。Rust leaf 可用独立二进制或抽取实际闭包；TS UI 取组件子树并注入状态。持续 Goal 仅复用普通任务生命周期，不借它定义学习调度。

R10a 是本地执行的权限/隔离合同，依赖 R3；R10b 是本地后台、调度监控及已有远控必要接线，依赖已验证的本地运行时；Cloud、runner 与模板部署已取消。R9 Provider 与 R7 本地问答/Task 在 R10a 后施工；完整团队与远端入口再进入 R10b。这是同一 owner 下的施工顺序，不新增权限 owner，也不以整包互相依赖形成循环。源码定位以172行审计每行的本地证据和直接复用文件为准；抽取前按实际 import/build 闭包逐文件留账。

## 4. 一个版本内部的波次

- W0：工程基线、源码状态、来源快照和全量 owner 矩阵。
- W1：R3 的 F01 耐久接线、安全恢复和失败边界。本轮从这个纵切开始。
- W2：R1/R4/R5 与 R10 的执行权限/隔离，为 R2/R7 提供可信执行事实。
- W3：R6/R9/R8 的常用能力、内容合同、安装到实际消费。
- W4：R7/R10 团队、本地后台、定时监控与已有远控必要接线；取消范围不留作资源欠账。
- W5：两基线和新版同任务/平台/开关的黑盒复验；固定制品、记录模型预算差异，逐 ID 审签。

波次是施工依赖；当前范围以用户最新取消决定为准，剩余能力不降低验收要求；未施工不能记完成，不承诺无证据工期。不增宽学习机制，也不撤销 Learning Agent 产品定位。

## 5. W1 冻结合同

复用 session v1 既有 record types，不造第二磁盘格式。新进度端口只接只读 canonical transcript/envelope 和实际执行动作 intent/outcome；Session adapter 是唯一写口。副作用前 await intent；结果先 durable 后 settled，写入失败停止后续执行。finish 只收尾，不批写第二份。

只保存闭合 provider block；半截 delta 不伪造完整消息，token级崩溃保留是后续独立合同。内部 emit/permission 不当外部副作用。effect按 turnId+key 隔离；failed/cancelled 为已知结果，unknown 保留待核对。旧 v1 文件兼容读取，原事实不重写。

resume 必须检查 reconcileRequired、readRecords 和 compaction 投影。未知动作不自动重放，不从文件存在推成功；本纵切拒绝恢复，reconciliation 包后续记录人审确认。正常完成及工具已配对的失败/预算截断/取消继续走既有 resume。subagent 事件必须经同一 Session 写口、错误不可只等待后丢弃。

耐久失败与已写出的 unknown 结算均关闭当前 lease；统一 RunFailure 的可选 continuation=session_closed 穿过 runOneTurn，REPL/TUI停止，不能拿旧scaffold续跑。普通启动拒绝保留旧兼容行为。两个交互入口共用续轮交接：raw records始终提供序号高水位，无压缩窗口也必须传递；未回答call只从prompt读投影清理，按最近此前请求逐次配对，不用全历史call ID集合。交接读取失败关闭会话。

压缩的 source record位置与canonical ordinal分开。RunTurnResult新增可选compactionSourceRecords纯派生读模型，把有编号缺口/已有窗口的draft精确映射到真实journal；不新增状态或writer。旧library调用不传该字段时保留原连续编号映射，旧批写API保留warning合同；生产live接点的compact读取/映射/append失败都保留分类并停止。子代理写队列与in-flight跟踪各限128，溢出/拒绝明确失败；已结算promise及时回收。

F02 先核实语义：file ledger 的单次 tooling 授权不是 session cache 的临时决定，不得强接。需要新增 scope/lifetime 合同后再交消费包；本轮不会扩大权限。

## 6. 出口与回滚

成熟度仅 identified → contracted → mock_verified → real_verified → desktop_parity → release_qualified。矩阵初始 contracted；sourceState 保留原审计事实。可达和单元绿不等于实机追平。

出口：172行逐ID证据，无未关闭纪律/P0/P1；固定包、真实provider/任务、磁盘diff、项目检查/exit、断点恢复/TTY、取消清理、兼容、独立复核和回滚。学习关闭是基础对照条件；收益验收仍按P05。缺账号/硬件/源码的行写明确外部阻塞，保留目标，不能假完成。

写入限 new trylo cli 的 src/adapter/vendor、必要manifest/lock/scripts和文档。主权端口/public格式变更先ADR与合同测试。本线保存前置hash及独立patch；dirty tree按patch反向恢复，禁止整仓reset/revert。不开发布、私库push和自动化。

证据：[本轮目录](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/evidence/2026-10-04-parity-v1>)；施工记录：同阶段2026-10-04-施工记录-CLI-PARITY-V1.md；机器矩阵：evidence目录capability-coverage.json。

## 7. 全量 owner 矩阵

| ID | 能力 | 包 owner | 当前源码状态 | 优先级 | 本包成熟度 |
| --- | --- | --- | --- | --- | --- |
| C01 | 普通交互 Agent 入口 | R8 | 已有 | — | contracted |
| C02 | 模型流式响应与工具继续执行 | R8 | 已有 | — | contracted |
| C03 | 运行中补充输入/steer | R2 | 未接全 | P0 | contracted |
| C04 | 显式中断及工具取消 | R2 | 部分 | P0 | contracted |
| C05 | 工具并行/串行有序仲裁 | R7 | 缺失 | P1 | contracted |
| C06 | 完整 shell 命令字符串 | R1 | 缺失 | P0 | contracted |
| C07 | PowerShell/Bash/Zsh 等平台 shell | R1 | 部分 | P0 | contracted |
| C08 | PTY/交互程序 | R1 | 缺失 | P0 | contracted |
| C09 | 非 PTY 管道进程 | R1 | 已有 | — | contracted |
| C10 | 长运行命令 yield 与 session ID | R1 | 缺失 | P0 | contracted |
| C11 | write_stdin 后续交互/轮询 | R1 | 缺失 | P0 | contracted |
| C12 | 背景终端可发现与停止 | R1 | 缺失 | P0 | contracted |
| C13 | 进程组/后代清理 | R1 | 部分 | P0 | contracted |
| C14 | 输出限额与截断事实 | R1 | 部分 | P1 | contracted |
| C15 | 多文件 patch | R4 | 部分 | P0 | contracted |
| C16 | patch 新增文件 | R4 | 部分 | P1 | contracted |
| C17 | patch 删除文件 | R4 | 缺失 | P1 | contracted |
| C18 | patch 移动/重命名文件 | R4 | 缺失 | P1 | contracted |
| C19 | patch 的部分成功/失败证据 | R4 | 缺失 | P0 | contracted |
| C20 | 每轮净 diff 追踪 | R4 | 缺失 | P0 | contracted |
| C21 | 用户 /diff（含未跟踪） | R4 | 缺失 | P0 | contracted |
| C22 | 文件提及与模糊查找 | R5 | 部分 | P1 | contracted |
| C23 | ignore-aware 搜索 | R5 | 已有 | — | contracted |
| C24 | 模型本地读/grep/glob | R5 | 已有 | — | contracted |
| C25 | 本地图片查看 | R9 | 缺失 | P1 | contracted |
| C26 | 图片输入参数/附件 | R9 | 缺失 | P1 | contracted |
| C27 | 用户 Todo/Plan 工具 | R7 | 已有 | — | contracted |
| C28 | Plan 模式 | R7 | 缺失 | P1 | contracted |
| C29 | 结构化向用户提问 | R7 | 缺失 | P1 | contracted |
| C30 | 异步用户提问/消息 | R7 | 缺失 | P2 | contracted |
| C31 | AGENTS.md 分层指令 | R6 | 已有 | — | contracted |
| C32 | 指令上下文大小控制 | R6 | 已有 | — | contracted |
| C33 | 会话保存与恢复 | R3 | 已有 | — | contracted |
| C34 | 会话 fork | R3 | 缺失 | P1 | contracted |
| C35 | 持续上下文与 token usage | R2 | 部分 | P0 | contracted |
| C36 | 手动压缩 | R2 | 已有 | — | contracted |
| C37 | 自动压缩并继续 | R2 | 部分 | P0 | contracted |
| C38 | 会话回滚 | R4 | 缺失 | P1 | contracted |
| C39 | 会话列表/分页历史/归档 | R3 | 部分 | P1 | contracted |
| C40 | 会话重命名/导出 | R3 | 缺失 | P1 | contracted |
| C41 | 背景消息队列 | R2 | 未接全 | P2 | contracted |
| C42 | 子代理派发 | R7 | 部分 | P0 | contracted |
| C43 | 子代理输入/等待/恢复/关闭 | R7 | 未接全 | P0 | contracted |
| C44 | 子代理角色/模型配置 | R7 | 部分 | P1 | contracted |
| C45 | V2 团队消息/后续任务/中断/列表 | R7 | 缺失 | P2 | contracted |
| C46 | MCP stdio 与 HTTP | R6 | 已有 | — | contracted |
| C47 | MCP OAuth/凭据管理 | R6 | 缺失 | P1 | contracted |
| C48 | MCP resources/templates/read | R6 | 缺失 | P1 | contracted |
| C49 | MCP tool 安全策略/暴露 | R6 | 部分 | P1 | contracted |
| C50 | MCP 状态/刷新/elicitation | R6 | 部分 | P1 | contracted |
| C51 | Skills 元信息加载/校验 | R6 | 缺失 | P0 | contracted |
| C52 | Skills host/executor/orchestrator 来源 | R6 | 缺失 | P2 | contracted |
| C53 | Skills search/依赖获取 | R6 | 缺失 | P2 | contracted |
| C54 | Plugins/marketplace 安装/移除 | R6 | 缺失 | P1 | contracted |
| C55 | Apps/connector 工具 | R6 | 部分 | P2 | contracted |
| C56 | 模型可搜索的延迟工具 | R6 | 缺失 | P1 | contracted |
| C57 | 生命周期 Hooks | R6 | 缺失 | P1 | contracted |
| C58 | 缓存/实时网络搜索 | R9 | 缺失 | P1 | contracted |
| C59 | 生成图片 | R9 | 缺失 | P2 | contracted |
| C60 | memory检索与上下文 | R9 | 部分 | P2 | contracted |
| C61 | 持续 Goal/预算与生命周期 | R7 | 部分 | P2 | contracted |
| C62 | 权限方案与用户审批 | R10 | 已有 | — | contracted |
| C63 | OS sandbox 真实执行 | R10 | 缺失 | P0 | contracted |
| C64 | Windows沙箱安装/就绪 | R10 | 缺失 | P0 | contracted |
| C65 | 审批缓存及沙箱拒绝后重试 | R10 | 部分 | P1 | contracted |
| C66 | 命令执行策略与规则 | R10 | 部分 | P1 | contracted |
| C67 | 自动审批复核（guardian） | R10 | 缺失 | P2 | contracted |
| C68 | Provider自定义与本地模型 | R9 | 部分 | P1 | contracted |
| C69 | 认证/登录/退出 | R9 | 部分 | P1 | contracted |
| C70 | 模型目录/能力驱动工具 | R9 | 部分 | P1 | contracted |
| C71 | 响应重试/连接恢复 | R9 | 部分 | P1 | contracted |
| C72 | headless exec | R8 | 已有 | — | contracted |
| C73 | JSONL machine输出 | R8 | 已有 | — | contracted |
| C74 | 结构化最终输出/最后消息文件 | R9 | 部分 | P1 | contracted |
| C75 | exec恢复/fork与review | R4 | 部分 | P1 | contracted |
| C76 | app-server RPC服务与SDK schema | R10 | 部分 | P1 | contracted |
| C77 | 命令/文件等外部客户端RPC | R10 | 部分 | P2 | contracted |
| C78 | remote app-server/exec-server | R10 | 缺失 | P3 | contracted |
| C79 | worktree会话 | R10 | 缺失 | P2 | contracted |
| C80 | Cloud任务平台（本地 diff 能力仍保留） | R10 | 历史缺失 | — | 用户取消，不施工/不验收；原 contracted 非 PASS |
| C81 | 多行、粘贴保护、历史与外部编辑器 | R8 | 部分 | P1 | contracted |
| C82 | Composer运行中排队与草稿恢复 | R2 | 未接全 | P0 | contracted |
| C83 | 动态工具由客户端提供 | R6 | 缺失 | P2 | contracted |
| C84 | code-mode工具编排 | R10 | 缺失 | P3 | contracted |
| C85 | 实时语音 | R9 | 缺失 | P3 | contracted |
| C86 | 安装健康诊断/自动补全/升级 | R8 | 部分 | P1 | contracted |
| L01 | 连续模型—工具—结果—模型循环（共用 C01） | R8 | 已有 | — | contracted |
| L02 | 流式文本、工具参数及思考块（共用 C02） | R8 | 已有 | — | contracted |
| L03 | 并行安全工具与串行写操作调度（共用 C05） | R7 | 缺失 | P1 | contracted |
| L04 | 取消与中断后工具结果配对（共用 C04） | R2 | 部分 | P0 | contracted |
| L05 | API 错误重试、退避及模型 fallback | R9 | 部分 | P1 | contracted |
| L06 | context 太长、媒体过大、输出截断恢复 | R2 | 部分 | P1 | contracted |
| L07 | 轮数、token、金额及 usage/cost 约束 | R2 | 部分 | P2 | contracted |
| L08 | 工具 allow/deny、按需显露与合并 MCP（共用 C49） | R6 | 部分 | P1 | contracted |
| L09 | 读取文本，按 offset/limit 读取（共用 C24） | R5 | 已有 | — | contracted |
| L10 | 图像文件读取与图像 payload（共用 C25） | R9 | 缺失 | P1 | contracted |
| L11 | PDF 文件与页范围读取 | R5 | 缺失 | P1 | contracted |
| L12 | Notebook 读取 | R5 | 缺失 | P1 | contracted |
| L13 | Notebook 插入/替换/删除 cell | R5 | 缺失 | P1 | contracted |
| L14 | 精确编辑、replace_all、外部修改检测 | R4 | 部分 | P1 | contracted |
| L15 | 写文件/新文件、编辑 diff 与快照 | R4 | 部分 | P1 | contracted |
| L16 | Glob 文件匹配与 Grep 内容检索 | R5 | 部分 | P1 | contracted |
| L17 | shell 命令、超时、进度与输出（共用 C06） | R1 | 缺失 | P0 | contracted |
| L18 | 后台命令、输出查询与停止（共用 C10） | R1 | 缺失 | P0 | contracted |
| L19 | Windows PowerShell 专用工具（共用 C07） | R1 | 部分 | P0 | contracted |
| L20 | URL 抓取、网页内容处理 | R9 | 部分 | P1 | contracted |
| L21 | 网页搜索（共用 C58） | R9 | 缺失 | P1 | contracted |
| L22 | 模型主动多选问用户（共用 C29） | R7 | 缺失 | P1 | contracted |
| L23 | Todo 列表（共用 C27） | R7 | 已有 | — | contracted |
| L24 | Task 创建、读取、更新、列举与依赖/认领 | R7 | 缺失 | P1 | contracted |
| L25 | 进入计划与退出计划审批（共用 C28） | R7 | 缺失 | P1 | contracted |
| L26 | 同步/后台子 agent、模型继承/覆盖（共用 C42） | R7 | 部分 | P0 | contracted |
| L27 | 自定义 agent 文件、tools/model/MCP/skills/权限配置（共用 C44） | R7 | 部分 | P1 | contracted |
| L28 | 子 agent 的 worktree 隔离 | R10 | 缺失 | P2 | contracted |
| L29 | fork 子 agent 继承整个父对话 | R7 | 缺失 | P2 | contracted |
| L30 | TeamCreate/Delete、SendMessage、队友协作（共用 C45） | R7 | 缺失 | P2 | contracted |
| L31 | Trylo 工作团队席位、member_id、职责/工具约束 | R7 | 缺失 | P2 | contracted |
| L32 | managed-work 持久后台委派 | R10 | 缺失 | P2 | contracted |
| L33 | 主会话历史 JSONL、agent sidechain 与元数据 | R3 | 部分 | P0 | contracted |
| L34 | 最近会话继续、ID/搜索选择恢复、会话 fork、按消息截取 | R3 | 部分 | P1 | contracted |
| L35 | 手动压缩与自动压缩（共用 C37） | R2 | 部分 | P0 | contracted |
| L36 | 工具结果 microcompact；压缩边界恢复 | R2 | 缺失 | P1 | contracted |
| L37 | 文件 checkpoint、diff、rewind | R4 | 部分 | P0 | contracted |
| L38 | rename/tag/export/copy/diff/context/cost/status | R3 | 部分 | P1 | contracted |
| L39 | 全交互 TTY：草稿/光标/多行输入与长粘贴（共用 C81） | R8 | 部分 | P1 | contracted |
| L40 | 上下历史与历史搜索 | R8 | 部分 | P1 | contracted |
| L41 | 文件 @、IDE 选区 @、图像粘贴 | R8 | 部分 | P1 | contracted |
| L42 | 运行中提交额外消息/排队（共用 C03） | R2 | 未接全 | P0 | contracted |
| L43 | Markdown、表格、代码块、工具 diff | R8 | 部分 | P1 | contracted |
| L44 | 审批/提问/elicitation 队列与可见等待原因 | R8 | 部分 | P1 | contracted |
| L45 | Vim 输入模式 | R8 | 缺失 | P2 | contracted |
| L46 | 默认快捷键与自定义 keybindings | R8 | 部分 | P1 | contracted |
| L47 | theme/terminal setup/statusline/config/model/effort | R8 | 部分 | P1 | contracted |
| L48 | Output styles：用户/项目 Markdown 风格 prompt | R8 | 缺失 | P2 | contracted |
| L49 | user/project/local/managed settings 与额外目录 | R6 | 部分 | P1 | contracted |
| L50 | 项目指令 CLAUDE.md、rules、路径作用域及导入 | R6 | 部分 | P1 | contracted |
| L51 | 本地 memory 与自动 memory 读取 | R9 | 部分 | P2 | contracted |
| L52 | Skills：发现、slash、模型调用与 frontmatter（共用 C51） | R6 | 缺失 | P0 | contracted |
| L53 | Skills 限 tools/model/paths、fork execution、局部 hooks | R6 | 缺失 | P1 | contracted |
| L54 | Plugins/marketplace 安装、卸载、启停、更新、inline plugin-dir（共用 C54） | R6 | 缺失 | P1 | contracted |
| L55 | Plugin 贡献 commands/skills/agents/output styles | R6 | 缺失 | P1 | contracted |
| L56 | MCP 配置 CRUD、strict config、导入 desktop、serve | R6 | 部分 | P2 | contracted |
| L57 | MCP stdio/SSE/Streamable HTTP/WebSocket/IDE 连接 | R6 | 部分 | P1 | contracted |
| L58 | MCP OAuth/资源/prompts/elicitation/连接管理 | R6 | 部分 | P1 | contracted |
| L59 | deferred tool 搜索、减少工具描述上下文（共用 C56） | R6 | 缺失 | P1 | contracted |
| L60 | LSP 定义、引用、hover、符号、实现、调用图 | R5 | 缺失 | P1 | contracted |
| L61 | IDE 自动连接、选区与 IDE 日志 | R5 | 缺失 | P1 | contracted |
| L62 | 生命周期 hooks：tool/permission/stop/prompt/session/compact/subagent/task（共用 C57） | R6 | 缺失 | P1 | contracted |
| L63 | hooks 执行器：command/prompt/agent/HTTP；file-change/CWD/指令载入/worktree | R6 | 缺失 | P1 | contracted |
| L64 | 权限模式、工具/路径/命令规则及拒权过滤（共用 C66） | R10 | 部分 | P1 | contracted |
| L65 | OS sandbox 文件/网络边界与命令包装（共用 C63） | R10 | 缺失 | P0 | contracted |
| L66 | 非交互文本/JSON/流 JSON、双向流输入及 partial chunks | R8 | 部分 | P1 | contracted |
| L67 | JSON schema 约束输出、系统 prompt 替换/追加（结构化输出共用 C74） | R9 | 部分 | P1 | contracted |
| L68 | Anthropic 原生与兼容 endpoint、Bedrock/Vertex/Foundry | R9 | 缺失 | P1 | contracted |
| L69 | OAuth/API Key 登录/状态/注销与 doctor/update | R9 | 部分 | P1 | contracted |
| L70 | git worktree 开始/退出与 tmux 启动（共用 C79） | R10 | 缺失 | P2 | contracted |
| L71 | Trylo loop JSONL 可观测事件与子 agent 收据 | R3 | 部分 | P1 | contracted |
| A01 | remote-control / bridge | R10 | 缺失 | P3 | contracted |
| A02 | session server / cc:// direct connect | R10 | 缺失 | P3 | contracted |
| A03 | SSH remote CLI | R10 | 缺失 | P3 | contracted |
| A04 | daemon / worker /后台会话 ps/logs/attach/kill | R10 | 基线缺件 | P3 | contracted |
| A05 | BYOC/self-hosted runner / template jobs | R10 | 历史基线缺件 | — | 用户取消，不施工/不验收；原 contracted 非 PASS |
| A06 | CronCreate/Delete/List、remote trigger | R10 | 缺失 | P2 | contracted |
| A07 | sleep/proactive/monitor/brief、push、PR订阅 | R10 | 缺失 | P3 | contracted |
| A08 | Workflow scripts、终端捕获、context inspect/snip | R8 | 缺失 | P3 | contracted |
| A09 | WebBrowser/computer-use/Chrome集成 | R9 | 基线缺件 | P3 | contracted |
| A10 | voice mode、assistant/Kairos、ultraplan | R9 | 部分 | P3 | contracted |
| A11 | 内部 REPL、Tungsten、plan verifier、background PR | R10 | 基线缺件 | P3 | contracted |
| A12 | remote managed settings / snapshot chooser | R8 | 基线缺件 | P3 | contracted |
| F01 | 运行中耐久记录 | R3 | 未接全（开工快照） | P0 | mock_verified（W1闭合事实合同；平台fixture已过） |
| F02 | 持久权限账本消费 | R10 | 未接全 | P1 | contracted |
| F03 | 恢复时配置迁移 | R3 | 部分 | P1 | contracted |

## 细分施工入口（2026-10-04）

原R1–R10领域范围保留，现细化为26个施工包及2个整合/发行验收包。每ID唯一WP主责、接口前置和联验清单见 [28包独立目录](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/README.md>)；分包决策见 [细分ADR](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-CLI-PARITY-V1细分工作包.md>)。能力成熟度仍以原矩阵及证据为准。

## 2026-10-04 Windows复用路线更正

见 [更正ADR](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-WP04-Windows复用来源更正.md>)。旧CLI底层已安装sandbox-runtime 0.0.73带原生Windows helper；此前平台描述止于adapter旧注释，调查未覆盖实际依赖和制品。Windows先验证现成runtime/helper薄桥，Codex保留候选。新版生产缺口、未完成状态和实际隔离验收要求不因找到制品而改变。

## 强制实际复核（2026-10-04用户决定）

[实际复核与路线确认](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-实际复核与路线确认.md>)是WP01–WP28的强制签收项。文档中的具体源码判断和复用建议只作候选；进入生产集成前必须追到当前实际调用链、依赖实现/版本、预编译制品和最小闭包，跑有界探针并留失败/反例。代码纪律仍是第一门禁，vendor JS不因检测盲区豁免。

每根关键接线必须交“原判断→实际来源/hash→探针与未验证范围→选用/纠正路线→独立复核”记录。只读诊断成功不代表就绪，注册/搬运不代表接线，未验证阶段不能升成熟度。证据推翻文档时同步更正本包、来源建议、ADR和矩阵；已批准需求与Trylo owner不因候选事实更正失效。

