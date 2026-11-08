# WP02 会话管理-fork与配置迁移

- 状态：已批准（依据用户要求独立文件夹拆分工作包；细化已授权版本范围）
- 阶段：P00 / CLI-PARITY-V1，普通 Agent 基底追平
- 负责人：Codex 编制；施工与独立复核人在领包时记名
- 最后更新：2026-10-04
- 依赖决策：[总版本合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/P00-CLI-PARITY-V1-复用复核接线技术规格.md>)、[分包ADR](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-CLI-PARITY-V1细分工作包.md>)、[仓库代码纪律](<D:/CC/trylo/new trylo cli/docs/00-总领/代码可读性可维护性与审计纪律.md>)；全部默认可复用，不查许可证。

- 所属原包：R3；角色：施工主责
- 主责能力：C34, C39, C40, L34, L38, F03
- 接口前置：[WP01](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP01-耐久会话与未知动作核对.md>)
- 集成联验：[WP11](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP11-diff-review-checkpoint与范围回退.md>)、[WP23](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP23-日用TUI输入-渲染-键位与等待原因.md>)、[WP25](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP25-本地RPC-worktree与code-mode.md>)
- 代码纪律：[统一施工合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-施工纪律与交接合同.md>) 为本包第一门禁；本包不得简化其中要求。
- 施工状态：工作包已编制，不能据此认定实现或验收完成。

## 强制实际复核（2026-10-04用户决定）

本包每根关键接线在进入生产集成前，都要先提交实际复核记录。 按 [实际复核与路线确认](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-实际复核与路线确认.md>)、[实际复核表](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-单包施工交接模板.md>) 执行；本包的源码现状、平台支持和直接复用建议均是待实际证据确认的候选，不能凭Codex或其他模型的文档结论直接施工。

必须追到当前新版消费者、来源实际依赖/版本、已有helper/制品及最小闭包；先比较最短真实复用途径，运行有界探针并记录正常结果、失败/反例、hash和未验证范围。上层注释、工具名、status成功、搬运/注册和扫描不到vendor都不能替代真实实现/接线/就绪证明。已批准范围、Trylo唯一owner与代码第一门禁保持不变。

实际复核否定原建议时，把证据与更正同步写回本包、来源报告、必要ADR及主矩阵复用建议；不伪升能力成熟度。[WP04来源更正](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-WP04-Windows复用来源更正.md>)作为复核先例，不把它外推成其他包已经验证。


## 1. 用户结果与边界

补齐会话选择、分叉和变更配置后的安全恢复。

本包接点/owner边界：**Session 管理服务；恢复兼容投影；CLI 会话命令**。沿用Trylo的既有唯一owner，来源代码只提供机械实现；涉及的新合同先冻结版本、状态转换和迁移，再动实现。学习控制面范围沿用总规格，不因复用能力扩权。

## 2. 逐项施工范围与直接复用

下表是分包时快照；最新成熟度以 [主能力矩阵](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/evidence/2026-10-04-parity-v1/capability-coverage.json>) 和工程产出证据为准。

| ID | 能力 / 优先级 | 源码审计状态 / 接线成熟度 | 尚需闭合 | 直接复用建议 |
| --- | --- | --- | --- | --- |
| C34 | 会话 fork / P1 | 缺失 / contracted | 没有会话 fork 和父子来源记录。 | 取 Codex ForkSnapshot 或旧 fork session 逻辑，接自有 session writer。 |
| C39 | 会话列表/分页历史/归档 / P1 | 部分 / contracted | session list/ID resume 有；缺分页预览、搜索、选择、归档。 | 复用旧会话 picker/查询层，或 Codex thread-store 查询边界。 |
| C40 | 会话重命名/导出 / P1 | 缺失 / contracted | 缺会话 rename/export 工作流。 | 取 Codex transcript exporter/rename 外围，写入新版 session 元信息。 |
| L34 | 最近会话继续、ID/搜索选择恢复、会话 fork、按消息截取 / P1 | 部分 / contracted | 按ID resume/list有；--last/搜索选择/fork/按消息截取没有。 | 取旧resume picker/continue/fork外壳，复用新版SessionPort。 |
| L38 | rename/tag/export/copy/diff/context/cost/status / P1 | 部分 / contracted | status/usage/details有；tag/copy/export/diff/context/cost菜单不全。 | 搬必要command handler/菜单，调用新版services。 |
| F03 | 恢复时配置迁移 / P1 | 部分 / contracted | resume要求workspace/provider/model/catalog匹配；改模型/工具后不能一般地接旧会话。 | 取旧/Codex恢复override/兼容投影做外围迁移；写明确迁移事实，保留旧记录。 |

源码定位与条件限制（先读这些行，再沿真实import/build闭包取文件）：

- **C34**：[C34源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:51>)；`cli/src/main.rs:1561` Fork；`core/src/thread_manager.rs:1313` fork_thread、`:1347` fork_from_history；常规；fork snapshot 明确，不等于覆盖旧会话；`ForkSnapshot` 和父子 provenance 语义
- **C39**：[C39源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:56>)；`app-server-protocol/src/protocol/common.rs:577` archive、`:703` unarchive、`:751` list、`:842` turns/list、`:848` items/list；CLI cli/src/main.rs:1501/:1548；常规；持久化/索引服务支持；thread-store/state 薄查询层
- **C40**：[C40源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:57>)；`tui/src/chatwidget/slash_dispatch.rs:305` rename、`:437` export；app-server-protocol/src/protocol/common.rs:611 name/set；常规；旧 Trylo表层组件 / Codex transcript exporter
- **L34**：[L34源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:59>)；普通 CLI resume/continue/picker；print 支持 resume-session-at；[main.tsx:1036](<D:/CC/trylo/trylo cli/src/main.tsx:1036>)、[main.tsx:3160](<D:/CC/trylo/trylo cli/src/main.tsx:3160>)、[main.tsx:3641](<D:/CC/trylo/trylo cli/src/main.tsx:3641>)、[print.ts:689](<D:/CC/trylo/trylo cli/src/cli/print.ts:689>)
- **L38**：[L38源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:63>)；普通命令注册；仍按各命令 availability/isEnabled 过滤；[commands.ts:269](<D:/CC/trylo/trylo cli/src/commands.ts:269>)、[commands.ts:297](<D:/CC/trylo/trylo cli/src/commands.ts:297>)、[commands.ts:335](<D:/CC/trylo/trylo cli/src/commands.ts:335>)、[commands.ts:476](<D:/CC/trylo/trylo cli/src/commands.ts:476>)
- **F03**：[耐久接线能力矩阵](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/evidence/2026-10-04-parity-v1/capability-coverage.json>)

复用工程边界另见 [最小闭包、薄桥与sidecar建议](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/reuse-engineering.md>)。源码有入口不等于此包真实可用。

## 3. 包内接线任务与验收

### WP02.1 会话列表与选择

施工：直接复用旧 sessionStorage 与 Codex rollout 外围的列表、元信息和筛选机械层，映射现有 SessionPort。

验收：列出、选择、找不到、损坏文件、删除失败有可见结果；不要求 UI 才能管理会话。

### WP02.2 fork 与历史边界

施工：复制持久事实到新会话身份，明确 parent、起点和不继承的执行中句柄/临时权限。

验收：新会话修改不污染父会话；父子可独立 resume；运行中副作用不会被 fork 自动重放。

### WP02.3 配置迁移

施工：复用恢复 override/兼容投影；分类 workspace/provider/model/catalog 变更，留迁移事实和旧记录。

验收：兼容迁移可续跑，工具 schema 不兼容明确拒绝；迁移失败原会话仍可读，旧版本数据有合同测试。

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
