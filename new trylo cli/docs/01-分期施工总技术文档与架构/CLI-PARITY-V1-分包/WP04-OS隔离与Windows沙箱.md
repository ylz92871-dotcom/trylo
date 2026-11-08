# WP04 OS隔离与Windows沙箱

- 状态：已批准（依据用户要求独立文件夹拆分工作包；细化已授权版本范围）
- 阶段：P00 / CLI-PARITY-V1，普通 Agent 基底追平
- 负责人：Codex 编制；施工与独立复核人在领包时记名
- 最后更新：2026-10-04
- 依赖决策：[总版本合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/P00-CLI-PARITY-V1-复用复核接线技术规格.md>)、[分包ADR](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-CLI-PARITY-V1细分工作包.md>)、[仓库代码纪律](<D:/CC/trylo/new trylo cli/docs/00-总领/代码可读性可维护性与审计纪律.md>)；全部默认可复用，不查许可证。

- 所属原包：R10；角色：施工主责
- 主责能力：C63, C64, L65
- 接口前置：[WP03](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP03-权限规则-审批与持久账本.md>)
- 集成联验：[WP05](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP05-平台shell与普通进程.md>)、[WP06](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP06-PTY-长进程-stdin与后台终端.md>)、[WP10](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP10-多文件patch与精确修改.md>)、[WP25](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP25-本地RPC-worktree与code-mode.md>)、[WP26](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP26-远端-Cloud-daemon与定时后台任务.md>)
- 代码纪律：[统一施工合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-施工纪律与交接合同.md>) 为本包第一门禁；本包不得简化其中要求。
- 施工状态：工作包已编制，不能据此认定实现或验收完成。

## 强制实际复核（2026-10-04用户决定）

本包每根关键接线在进入生产集成前，都要先提交实际复核记录。 按 [实际复核与路线确认](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-实际复核与路线确认.md>)、[实际复核表](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-单包施工交接模板.md>) 执行；本包的源码现状、平台支持和直接复用建议均是待实际证据确认的候选，不能凭Codex或其他模型的文档结论直接施工。

必须追到当前新版消费者、来源实际依赖/版本、已有helper/制品及最小闭包；先比较最短真实复用途径，运行有界探针并记录正常结果、失败/反例、hash和未验证范围。上层注释、工具名、status成功、搬运/注册和扫描不到vendor都不能替代真实实现/接线/就绪证明。已批准范围、Trylo唯一owner与代码第一门禁保持不变。

实际复核否定原建议时，把证据与更正同步写回本包、来源报告、必要ADR及主矩阵复用建议；不伪升能力成熟度。[WP04来源更正](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-WP04-Windows复用来源更正.md>)作为复核先例，不把它外推成其他包已经验证。


## 1. 用户结果与边界

复用真实平台隔离实现，证明路径和网络边界在 OS 层生效。

本包接点/owner边界：**Isolation adapter；Permission 决策输入；平台 helper**。沿用Trylo的既有唯一owner，来源代码只提供机械实现；涉及的新合同先冻结版本、状态转换和迁移，再动实现。学习控制面范围沿用总规格，不因复用能力扩权。

## 2. 逐项施工范围与直接复用

下表是分包时快照；最新成熟度以 [主能力矩阵](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/evidence/2026-10-04-parity-v1/capability-coverage.json>) 和工程产出证据为准。

| ID | 能力 / 优先级 | 源码审计状态 / 接线成熟度 | 尚需闭合 | 直接复用建议 |
| --- | --- | --- | --- | --- |
| C63 | OS sandbox 真实执行 / P0 | 缺失 / contracted | 当前是计划/路径检查；没有 OS 文件系统/网络沙箱执行。 | 优先核查旧CLI已安装sandbox-runtime 0.0.73与预编译Windows helper的最小闭包，接Trylo真实执行端口；Codex隔离保留候选，实际文件/网络边界仍须实机证明。 |
| C64 | Windows沙箱安装/就绪 / P0 | 缺失 / contracted | 没有 Windows OS sandbox 安装、就绪与故障诊断链。 | 优先复用现成srt-win.exe与Windows install/status/ACL机械层，固定版本/hash/制品路径；status可跑不等于installed/ready，Codex setup作为候选。 |
| L65 | OS sandbox 文件/网络边界与命令包装（共用 C63） / P0 | 缺失 / contracted | 当前是计划/路径检查；没有 OS 文件系统/网络沙箱执行。 | 优先核查旧CLI已安装sandbox-runtime 0.0.73与预编译Windows helper的最小闭包，接Trylo真实执行端口；Codex隔离保留候选，实际文件/网络边界仍须实机证明。 |

源码定位与条件限制（先读这些行，再沿真实import/build闭包取文件）：

- **C63**：[C63源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:80>)；`sandboxing/src/lib.rs:1` Linux、`:7` macOS、`:12` Windows；core/src/tools/orchestrator.rs:121；平台能力；是进程/filesystem/network隔离而非只匹配命令文本；`sandboxing` + exec-server sidecar，窄端口
- **C64**：[C64源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:81>)；app-server-protocol/src/protocol/common.rs:1241 setupStart、`:1246` readiness；app-server/src/message_processor.rs:1674 dispatch；Windows；windows_sandbox_service新flag UnderDevelopment false，不等于所有Windows沙箱都实验；`windows-sandbox-rs` / readiness/setup adapter
- **L65**：[L65源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:90>)；配置后能力；adapter转调BaseSandboxManager，旧平台注释不界定实际支持；当前底层runtime 0.0.73明确支持原生Windows并附x64/arm64 helper（见Windows复用来源更正ADR）；[sandbox-adapter.ts:488](<D:/CC/trylo/trylo cli/src/utils/sandbox/sandbox-adapter.ts:488>)、[sandbox-adapter.ts:574](<D:/CC/trylo/trylo cli/src/utils/sandbox/sandbox-adapter.ts:574>)、[sandbox-adapter.ts:704](<D:/CC/trylo/trylo cli/src/utils/sandbox/sandbox-adapter.ts:704>)

复用工程边界另见 [最小闭包、薄桥与sidecar建议](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/reuse-engineering.md>)。源码有入口不等于此包真实可用。

## 3. 包内接线任务与验收

### WP04.1 平台 helper 与构建闭包

施工：Windows优先试接旧CLI已安装sandbox-runtime 0.0.73和预编译srt-win helper，固定实际JS依赖闭包、binary hash和制品路径；Codex保留候选与对照，不重写隔离算法。

验收：隔离配置来源唯一；不支持的平台给显式 unavailable，不能把 prompt/注释当 sandbox。

### WP04.2 文件与网络策略

施工：授权决定传入隔离 adapter，明确继承环境、工作区、symlink、网络与启动失败语义。

验收：授权外读写和网络实际失败；允许目标可运行；路径含空格/中文和 symlink 不能越界。

### WP04.3 取消与平台证明

施工：连接 Process 生命周期与隔离失败合同，实测 Windows PowerShell 和对应支持平台。

验收：启动失败、用户拒绝、超时均不退回无隔离执行；平台缺实机证据只标未验证。

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


## 2026-10-04 来源更正与接线约束

[Windows复用来源更正ADR](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-WP04-Windows复用来源更正.md>)纠正旧adapter平台注释导致的路线偏差。已找到现成Windows runtime/helper，应优先验证薄桥接线；新版真实隔离缺口仍未据此关闭。vendor JS不受现扫描覆盖是门禁盲区，不能豁免代码纪律；原闭包静态依赖node-forge，关闭网络配置不等于不加载。status exit=0仅证明诊断可跑，当前本机用户不存在、WFP不可枚举。路径布局、依赖版本、真实安装和文件/网络拒绝都按ADR逐项留证据。

## 2026-10-04 域名白名单实际复核

现有HTTP CONNECT/SOCKS在MITM分支之前进行主机/端口过滤，基本域名白名单不必依赖证书签发。优先验证保留WFP与现成代理过滤、拆分静态证书模块，使基础执行和域名白名单在无node-forge的固定安装制品中运行。不能用全阻断代替域名白名单，也不能用--no-save或门禁白名单掩盖依赖。具体源码证据、拆分边界、失败回退与验收见[实际复核记录](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-实际复核-WP04域名白名单与MITM边界.md>)；若合同要求MITM功能，仍须用成熟替代/修复完整交付，不删目标。本段不表示探针或完整功能已经验收。
