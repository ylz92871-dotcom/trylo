# WP14 Skill与项目指令实际消费

- 状态：已批准（依据用户要求独立文件夹拆分工作包；细化已授权版本范围）
- 阶段：P00 / CLI-PARITY-V1，普通 Agent 基底追平
- 负责人：Codex 编制；施工与独立复核人在领包时记名
- 最后更新：2026-10-04
- 依赖决策：[总版本合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/P00-CLI-PARITY-V1-复用复核接线技术规格.md>)、[分包ADR](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-CLI-PARITY-V1细分工作包.md>)、[仓库代码纪律](<D:/CC/trylo/new trylo cli/docs/00-总领/代码可读性可维护性与审计纪律.md>)；全部默认可复用，不查许可证。

- 所属原包：R6；角色：施工主责
- 主责能力：C31, C32, C51, C52, C53, L49, L50, L52, L53
- 接口前置：[WP03](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP03-权限规则-审批与持久账本.md>)、[WP09](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP09-上下文预算-压缩与截断恢复.md>)
- 集成联验：[WP16](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP16-Plugin-动态工具与延迟搜索.md>)、[WP17](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP17-生命周期Hooks.md>)、[WP22](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP22-工具并行-子代理与团队.md>)
- 代码纪律：[统一施工合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-施工纪律与交接合同.md>) 为本包第一门禁；本包不得简化其中要求。
- 施工状态：工作包已编制，不能据此认定实现或验收完成。

## 强制实际复核（2026-10-04用户决定）

本包每根关键接线在进入生产集成前，都要先提交实际复核记录。 按 [实际复核与路线确认](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-实际复核与路线确认.md>)、[实际复核表](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-单包施工交接模板.md>) 执行；本包的源码现状、平台支持和直接复用建议均是待实际证据确认的候选，不能凭Codex或其他模型的文档结论直接施工。

必须追到当前新版消费者、来源实际依赖/版本、已有helper/制品及最小闭包；先比较最短真实复用途径，运行有界探针并记录正常结果、失败/反例、hash和未验证范围。上层注释、工具名、status成功、搬运/注册和扫描不到vendor都不能替代真实实现/接线/就绪证明。已批准范围、Trylo唯一owner与代码第一门禁保持不变。

实际复核否定原建议时，把证据与更正同步写回本包、来源报告、必要ADR及主矩阵复用建议；不伪升能力成熟度。[WP04来源更正](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-WP04-Windows复用来源更正.md>)作为复核先例，不把它外推成其他包已经验证。


## 1. 用户结果与边界

直接复用 loader 与调用算法，让安装后的技能真正影响任务。

本包接点/owner边界：**SkillDescriptor/context；项目指令装载；现资产治理 owner**。沿用Trylo的既有唯一owner，来源代码只提供机械实现；涉及的新合同先冻结版本、状态转换和迁移，再动实现。学习控制面范围沿用总规格，不因复用能力扩权。

## 2. 逐项施工范围与直接复用

下表是分包时快照；最新成熟度以 [主能力矩阵](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/evidence/2026-10-04-parity-v1/capability-coverage.json>) 和工程产出证据为准。

| ID | 能力 / 优先级 | 源码审计状态 / 接线成熟度 | 尚需闭合 | 直接复用建议 |
| --- | --- | --- | --- | --- |
| C31 | AGENTS.md 分层指令 / — | 已有 / contracted | AGENTS 祖先/局部规则、来源/hash、每轮重读与冻结已有。 | 继续复用现有 project-instructions，不重建 loader。 |
| C32 | 指令上下文大小控制 / — | 已有 / contracted | 项目规则和读取输出已有预算/截断。 | 沿用现有预算；补齐最终请求估算见 C35。 |
| C51 | Skills 元信息加载/校验 / P0 | 缺失 / contracted | 没有用户 SKILL.md 的加载、元数据、校验和选用链。 | 直接复用 codex-skills parser/loading/selection；TS可取旧 SkillTool。 |
| C52 | Skills host/executor/orchestrator 来源 / P2 | 缺失 / contracted | 无 host/executor/orchestrator 多来源 Skill provider。 | 取 skills provider 接口与渐进加载，将来源转换为 Trylo DTO。 |
| C53 | Skills search/依赖获取 / P2 | 缺失 / contracted | 无 Skill 搜索/依赖发现/安装消费链。 | 复用 ext/skills 与 mcp_skill_dependencies 的外围流程。 |
| L49 | user/project/local/managed settings 与额外目录 / P1 | 部分 / contracted | 分层配置有；local/managed/settings sources/add-dir不全。 | 取旧settings source/权限目录解析。 |
| L50 | 项目指令 CLAUDE.md、rules、路径作用域及导入 / P1 | 部分 / contracted | AGENTS/CLAUDE/GEMINI文件发现已有；缺旧rules的paths过滤与import完整兼容。 | 只取claudemd import/path-scope规则解析，复用现有发现/冻结链。 |
| L52 | Skills：发现、slash、模型调用与 frontmatter（共用 C51） / P0 | 缺失 / contracted | 没有用户 SKILL.md 的加载、元数据、校验和选用链。 | 直接复用 codex-skills parser/loading/selection；TS可取旧 SkillTool。 |
| L53 | Skills 限 tools/model/paths、fork execution、局部 hooks / P1 | 缺失 / contracted | 无完整Skill tools/model/paths/fork/hooks语义。 | 搬loadSkillsDir/SkillTool/registerSkillHooks。 |

源码定位与条件限制（先读这些行，再沿真实import/build闭包取文件）：

- **C31**：[C31源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:48>)；`core/src/agents_md.rs:40` AGENTS.md、`:42` AGENTS.override.md、`:55` load、`:189` 父路径 discovery；常规；含读取预算与项目根规则；`agents_md` 的发现/优先级算法，转 Trylo context fragment
- **C32**：[C32源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:49>)；`core/src/agents_md.rs:154` remaining budget 截断；`core/src/context_manager/history.rs:327` TruncationPolicy；常规；不会无限把外部资料注入模型；预算与截断叶子，可复用策略
- **C51**：[C51源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:68>)；`skills/src/parser.rs:44` frontmatter parser；`app-server/src/message_processor.rs:1474` skills/list；`app-server/src/extensions.rs:123` install skills；常规；真实 SKILL.md，不是只有用户传入一段prompt；`codex-skills` parser/loading/selection；最适合摘取
- **C52**：[C52源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:69>)；`app-server/src/extensions.rs:117` provider chain、`:127` context预算；skills/src/loading.rs:111 precedence/IO contract；条件：各来源 provider 和配置；不是全部用户都连接orchestrator；skills provider接口与渐进加载，而非只复制metadata
- **C53**：[C53源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:70>)；`features/src/lib.rs:1506` skill_search Stable true、`:1500` MCP dependency install true；app-server/src/extensions.rs:133 gate；稳定但具体来源/安装需支持及授权；`ext/skills` discovery、`core/src/mcp_skill_dependencies`
- **L49**：[L49源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:74>)；普通 CLI 配置；`--settings`/`--setting-sources`/`--add-dir`；[main.tsx:1048](<D:/CC/trylo/trylo cli/src/main.tsx:1048>)、[permissionsLoader.ts](<D:/CC/trylo/trylo cli/src/utils/permissions/permissionsLoader.ts>)
- **L50**：[L50源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:75>)；普通 context 自动发现；`--bare` 关自动发现，需要显式 context；[claudemd.ts:4](<D:/CC/trylo/trylo cli/src/utils/claudemd.ts:4>)、[claudemd.ts:618](<D:/CC/trylo/trylo cli/src/utils/claudemd.ts:618>)、[claudemd.ts:697](<D:/CC/trylo/trylo cli/src/utils/claudemd.ts:697>)、[main.tsx:1024](<D:/CC/trylo/trylo cli/src/main.tsx:1024>)
- **L52**：[L52源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:77>)；普通 skills/commands/plugin skills 合并，运行时过滤；[loadSkillsDir.ts:78](<D:/CC/trylo/trylo cli/src/skills/loadSkillsDir.ts:78>)、[loadSkillsDir.ts:185](<D:/CC/trylo/trylo cli/src/skills/loadSkillsDir.ts:185>)、[commands.ts:460](<D:/CC/trylo/trylo cli/src/commands.ts:460>)、[commands.ts:563](<D:/CC/trylo/trylo cli/src/commands.ts:563>)
- **L53**：[L53源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:78>)；普通 frontmatter 解析；SkillTool 经权限调用；MCP 提供 skills 另受 `MCP_SKILLS`；[loadSkillsDir.ts:203](<D:/CC/trylo/trylo cli/src/skills/loadSkillsDir.ts:203>)、[SkillTool.ts:432](<D:/CC/trylo/trylo cli/src/tools/SkillTool/SkillTool.ts:432>)、[commands.ts:550](<D:/CC/trylo/trylo cli/src/commands.ts:550>)

复用工程边界另见 [最小闭包、薄桥与sidecar建议](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/reuse-engineering.md>)。源码有入口不等于此包真实可用。

## 3. 包内接线任务与验收

### WP14.1 发现与解析

施工：取旧 loadSkillsDir/frontmatter/argumentSubstitution/markdownConfigLoader 与 Codex skills 外围。

验收：层级、frontmatter、参数、重复项、损坏配置和实际来源可解释；不整搬旧 settings/cache singleton。

### WP14.2 指令进入请求

施工：冻结项目指令优先级、显式技能调用与上下文装载 receipt，经现 context builder 输出。

验收：真实任务消费安装的技能/项目指令；约束对行为有证据；仅列出名称不能验收。

### WP14.3 fork 与卸载

施工：fork 转给 WP22 子代理端口；卸载停止后续注入；学习治理资产沿用原审批与激活 owner。

验收：普通 Skill 与受治理学习资产来源区分；真实 fork 消费在两包连接后验；卸载后不留隐藏缓存。

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
