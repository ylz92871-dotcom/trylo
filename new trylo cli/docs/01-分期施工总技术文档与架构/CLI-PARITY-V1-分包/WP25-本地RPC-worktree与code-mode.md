# WP25 本地RPC-worktree与code-mode

- 状态：已批准（依据用户要求独立文件夹拆分工作包；细化已授权版本范围）
- 阶段：P00 / CLI-PARITY-V1，普通 Agent 基底追平
- 负责人：Codex 编制；施工与独立复核人在领包时记名
- 最后更新：2026-10-04
- 依赖决策：[总版本合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/P00-CLI-PARITY-V1-复用复核接线技术规格.md>)、[分包ADR](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-CLI-PARITY-V1细分工作包.md>)、[仓库代码纪律](<D:/CC/trylo/new trylo cli/docs/00-总领/代码可读性可维护性与审计纪律.md>)；全部默认可复用，不查许可证。

- 所属原包：R10；角色：施工主责
- 主责能力：C76, C77, C79, C84, L28, L70, A02
- 接口前置：[WP02](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP02-会话管理-fork与配置迁移.md>)、[WP03](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP03-权限规则-审批与持久账本.md>)、[WP04](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP04-OS隔离与Windows沙箱.md>)、[WP06](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP06-PTY-长进程-stdin与后台终端.md>)、[WP10](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP10-多文件patch与精确修改.md>)、[WP16](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP16-Plugin-动态工具与延迟搜索.md>)
- 集成联验：[WP22](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP22-工具并行-子代理与团队.md>)、[WP23](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP23-日用TUI输入-渲染-键位与等待原因.md>)、[WP24](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP24-Headless-诊断-输出样式与工作流入口.md>)、[WP26](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP26-远端-Cloud-daemon与定时后台任务.md>)
- 代码纪律：[统一施工合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-施工纪律与交接合同.md>) 为本包第一门禁；本包不得简化其中要求。
- 施工状态：工作包已编制，不能据此认定实现或验收完成。

## 强制实际复核（2026-10-04用户决定）

本包每根关键接线在进入生产集成前，都要先提交实际复核记录。 按 [实际复核与路线确认](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-实际复核与路线确认.md>)、[实际复核表](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-单包施工交接模板.md>) 执行；本包的源码现状、平台支持和直接复用建议均是待实际证据确认的候选，不能凭Codex或其他模型的文档结论直接施工。

必须追到当前新版消费者、来源实际依赖/版本、已有helper/制品及最小闭包；先比较最短真实复用途径，运行有界探针并记录正常结果、失败/反例、hash和未验证范围。上层注释、工具名、status成功、搬运/注册和扫描不到vendor都不能替代真实实现/接线/就绪证明。已批准范围、Trylo唯一owner与代码第一门禁保持不变。

实际复核否定原建议时，把证据与更正同步写回本包、来源报告、必要ADR及主矩阵复用建议；不伪升能力成熟度。[WP04来源更正](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-WP04-Windows复用来源更正.md>)作为复核先例，不把它外推成其他包已经验证。


## 1. 用户结果与边界

复用真实本地协议/工作树/code执行，不引入第二套核心owner。

本包接点/owner边界：**Trylo协议 adapter；委托ToolRunnerPort；工作树生命周期**。沿用Trylo的既有唯一owner，来源代码只提供机械实现；涉及的新合同先冻结版本、状态转换和迁移，再动实现。学习控制面范围沿用总规格，不因复用能力扩权。

## 2. 逐项施工范围与直接复用

下表是分包时快照；最新成熟度以 [主能力矩阵](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/evidence/2026-10-04-parity-v1/capability-coverage.json>) 和工程产出证据为准。

| ID | 能力 / 优先级 | 源码审计状态 / 接线成熟度 | 尚需闭合 | 直接复用建议 |
| --- | --- | --- | --- | --- |
| C76 | app-server RPC服务与SDK schema / P1 | 部分 / contracted | Desktop 单轮 stdio 审批已有；不是完整 thread/turn/config API 服务。 | 复用 app-server 的 schema/client/双向RPC机械层，映射 Trylo 服务。 |
| C77 | 命令/文件等外部客户端RPC / P2 | 部分 / contracted | 文件/命令工具已有；客户端 RPC 缺 watch、command session/resize 等。 | 复用 exec-server/file-system sidecar 与新版过程/文件端口连接。 |
| C79 | worktree会话 / P2 | **已接线** / contracted | 管理端口+创建/列出/归属/删除已交付并自证（58/58，两轮有牙验证）；未做 CLI 命令面与真机 `--layer=platform` 验收，故仍为 contracted。 | 已取 Codex `codex-rs/worktree/`（lib.rs/paths.rs/git.rs/metadata.rs）。 |
| C84 | code-mode工具编排 / P3 | 缺失 / contracted | 无 code-mode 的代码化工具编排/等待协议。 | **（2026-10-06 实测更正）** 不可按「复用 sidecar」直接施工：该 sidecar 是 `code-mode-host` 二进制、进程内嵌 V8（`code-mode-runtime/src/v8_init.rs:42-56`，crate `codex-code-mode-runtime`），不在两基线语言面内；复用须先交付预编译制品。见 evidence/2026-10-06-WP25。 |
| L28 | 子 agent 的 worktree 隔离 / P2 | **已接线** / contracted | 租约层已交付（创建→绑定子代理→受保护释放）；调用方尚未在生产入口启用，故保持 contracted。 | 已取 Codex `exec/src/worktree.rs` + `exec/src/lib.rs:1087-1091` 语义。 |
| L70 | git worktree 开始/退出与 tmux 启动（共用 C79） / P2 | 缺失 / contracted | worktree 部分已交付（见下）；**tmux 部分 source_missing**。 | **（2026-10-06 实测更正）** worktree 部分取 Codex `codex-rs/worktree/`；tmux 在来源中不存在——全仓仅 `terminal-detection`（user-agent）、`cli/doctor`（诊断）与一处 `#[ignore]` 手动烟雾测试，`worktree/**` 与 `tui/src/worktree_*.rs` 无引用。 |
| A02 | session server / cc:// direct connect / P3 | 缺失 / contracted | 无session server/direct connect。 | 取旧server/remote机械层，接自有session。 |

源码定位与条件限制（先读这些行，再沿真实import/build闭包取文件）：

- **C76**：[C76源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:93>)；cli/src/main.rs:1314` AppServer；`:1427` GenerateTs、`:1438` JSONSchema；app-server/src/message_processor.rs:1234/:1570` 真正分派；CLI命令标Experimental；很多v2 RPC本身稳定并被TUI/exec消费；app-server协议适配桥，不把RPC事件改成Trylo核心类型
- **C77**：[C77源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:94>)；`app-server-protocol/src/protocol/common.rs:963` fs/readFile→998 watch；`:1322` command/exec/write/terminate/resize；常规RPC；process/*是另组Experimental API；`exec-server`/file-system sidecar，UI/Agent共享执行端口
- **C79**：[C79源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:96>)；tui/src/chatwidget/slash_dispatch.rs:253` managed picker；features/src/lib.rs:1244` Worktrees Experimental；默认false（该feature block）；单独实验追平项；`worktree`与git-utils，不重造Git工作树
- **C84**：[C84源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:101>)；core/src/tools/spec_plan.rs:791` executors，`:893` wait；core/tools/code_mode`；code_mode UnderDevelopment false；code_mode_host Stable true仅宿主，不代表用户mode启用；专用code-mode sidecar/工具桥；不是正常底座第一批
- **L28**：[L28源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:53>)；普通 Agent schema 支持 worktree；remote isolation 在 external 字面量分支不可达；[AgentTool.tsx:110](<D:/CC/trylo/trylo cli/src/tools/AgentTool/AgentTool.tsx:110>)、[AgentTool.tsx:691](<D:/CC/trylo/trylo cli/src/tools/AgentTool/AgentTool.tsx:691>)
- **L70**：[L70源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:95>)；`isWorktreeModeEnabled` 本地恒 true；tmux 需实际程序及对应平台；[worktreeModeEnabled.ts:9](<D:/CC/trylo/trylo cli/src/utils/worktreeModeEnabled.ts:9>)、[tools.ts:225](<D:/CC/trylo/trylo cli/src/tools.ts:225>)、[cli.tsx:249](<D:/CC/trylo/trylo cli/src/entrypoints/cli.tsx:249>)
- **A02**：[A02源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:105>)；`DIRECT_CONNECT`；server 创建 backend/session manager；[main.tsx:4009](<D:/CC/trylo/trylo cli/src/main.tsx:4009>)、[main.tsx:4106](<D:/CC/trylo/trylo cli/src/main.tsx:4106>)

复用工程边界另见 [最小闭包、薄桥与sidecar建议](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/reuse-engineering.md>)。源码有入口不等于此包真实可用。

## 3. 包内接线任务与验收

### WP25.1 本地RPC与app-server委托

施工：固定Codex本地binary/schema，经stdio双向RPC映射审批、turn、事件与delegate reference。

验收：拒绝/批准/取消/断连/重启resume实际一致；外部Agent接委托口，不能塞ProviderPort。

### WP25.2 工作树生命周期

施工：取旧 worktree 机械层，归属、创建/复用/清理事实由既有任务服务管理。

验收：真实工作区隔离与diff可取回；父子task对应真实路径；用户dirty成果不被清理掉。

### WP25.3 code-mode与动态工具

施工：复用Codex code执行/工具调用桥，经权限和catalog快照执行；不会直接取得host无限权限。

验收：真实多工具执行、返回值/错误/取消/沙箱约束正确；登记代码工具不等于实际能调用。

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
