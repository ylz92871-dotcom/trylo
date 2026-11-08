# WP13 PDF与Notebook读写

- 状态：已批准（依据用户要求独立文件夹拆分工作包；细化已授权版本范围）
- 阶段：P00 / CLI-PARITY-V1，普通 Agent 基底追平
- 负责人：Codex 编制；施工与独立复核人在领包时记名
- 最后更新：2026-10-04
- 依赖决策：[总版本合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/P00-CLI-PARITY-V1-复用复核接线技术规格.md>)、[分包ADR](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-CLI-PARITY-V1细分工作包.md>)、[仓库代码纪律](<D:/CC/trylo/new trylo cli/docs/00-总领/代码可读性可维护性与审计纪律.md>)；全部默认可复用，不查许可证。

- 所属原包：R5；角色：施工主责
- 主责能力：L11, L12, L13
- 接口前置：[WP03](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP03-权限规则-审批与持久账本.md>)、[WP10](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP10-多文件patch与精确修改.md>)、[WP11](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP11-diff-review-checkpoint与范围回退.md>)、[WP12](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP12-搜索-LSP与IDE导航.md>)
- 集成联验：[WP19](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP19-多模态-图像-语音与computer-use.md>)、[WP23](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP23-日用TUI输入-渲染-键位与等待原因.md>)
- 代码纪律：[统一施工合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-施工纪律与交接合同.md>) 为本包第一门禁；本包不得简化其中要求。
- 施工状态：工作包已编制，不能据此认定实现或验收完成。

## 强制实际复核（2026-10-04用户决定）

本包每根关键接线在进入生产集成前，都要先提交实际复核记录。 按 [实际复核与路线确认](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-实际复核与路线确认.md>)、[实际复核表](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-单包施工交接模板.md>) 执行；本包的源码现状、平台支持和直接复用建议均是待实际证据确认的候选，不能凭Codex或其他模型的文档结论直接施工。

必须追到当前新版消费者、来源实际依赖/版本、已有helper/制品及最小闭包；先比较最短真实复用途径，运行有界探针并记录正常结果、失败/反例、hash和未验证范围。上层注释、工具名、status成功、搬运/注册和扫描不到vendor都不能替代真实实现/接线/就绪证明。已批准范围、Trylo唯一owner与代码第一门禁保持不变。

实际复核否定原建议时，把证据与更正同步写回本包、来源报告、必要ADR及主矩阵复用建议；不伪升能力成熟度。[WP04来源更正](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-WP04-Windows复用来源更正.md>)作为复核先例，不把它外推成其他包已经验证。


## 1. 用户结果与边界

复用现成文档工具，保持 notebook 结构和真实页范围。

本包接点/owner边界：**reader ToolPort；Notebook mutating adapter；file_write事实**。沿用Trylo的既有唯一owner，来源代码只提供机械实现；涉及的新合同先冻结版本、状态转换和迁移，再动实现。学习控制面范围沿用总规格，不因复用能力扩权。

## 2. 逐项施工范围与直接复用

下表是分包时快照；最新成熟度以 [主能力矩阵](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/evidence/2026-10-04-parity-v1/capability-coverage.json>) 和工程产出证据为准。

| ID | 能力 / 优先级 | 源码审计状态 / 接线成熟度 | 尚需闭合 | 直接复用建议 |
| --- | --- | --- | --- | --- |
| L11 | PDF 文件与页范围读取 / P1 | 缺失 / contracted | 没有PDF页范围/图像读取链。 | 取FileReadTool PDF分支与页提取辅助。 |
| L12 | Notebook 读取 / P1 | 缺失 / contracted | 没有Notebook cell-aware读取。 | 取FileReadTool Notebook分支+utils/notebook。 |
| L13 | Notebook 插入/替换/删除 cell / P1 | 缺失 / contracted | 没有Notebook cell插入/替换/删除。 | 搬NotebookEditTool+utils/notebook。 |

源码定位与条件限制（先读这些行，再沿真实import/build闭包取文件）：

- **L11**：[L11源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:36>)；普通 FileRead 分支；页面提取/工具安装另受平台和依赖影响；[FileReadTool.ts:236](<D:/CC/trylo/trylo cli/src/tools/FileReadTool/FileReadTool.ts:236>)、[FileReadTool.ts:897](<D:/CC/trylo/trylo cli/src/tools/FileReadTool/FileReadTool.ts:897>)、[FileReadTool.ts:987](<D:/CC/trylo/trylo cli/src/tools/FileReadTool/FileReadTool.ts:987>)
- **L12**：[L12源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:37>)；普通 FileRead 分支，cells 映射到工具结果；[FileReadTool.ts:670](<D:/CC/trylo/trylo cli/src/tools/FileReadTool/FileReadTool.ts:670>)、[FileReadTool.ts:823](<D:/CC/trylo/trylo cli/src/tools/FileReadTool/FileReadTool.ts:823>)
- **L13**：[L13源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:38>)；普通工具表，定义 shouldDefer；不是随意整文件 JSON 替换；[tools.ts:206](<D:/CC/trylo/trylo cli/src/tools.ts:206>)、[NotebookEditTool.ts:32](<D:/CC/trylo/trylo cli/src/tools/NotebookEditTool/NotebookEditTool.ts:32>)、[NotebookEditTool.ts:90](<D:/CC/trylo/trylo cli/src/tools/NotebookEditTool/NotebookEditTool.ts:90>)

复用工程边界另见 [最小闭包、薄桥与sidecar建议](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/reuse-engineering.md>)。源码有入口不等于此包真实可用。

## 3. 包内接线任务与验收

### WP13.1 PDF 页范围读取

施工：抽取旧 PDF 读取/页选择与必要依赖，复用已有 reader 结果格式。

验收：真实多页 PDF 范围/页数/错误可见，超限有界；图片页与文本页限制如实呈现。

### WP13.2 Notebook 读取与编辑

施工：取 NotebookEditTool/types/notebook/utils/notebook 算法；替换 ToolDef/UI与旧读盘全局依赖。

验收：cell ID/插入/替换/删除实际有效；metadata、输出和未修改 cell 保留；非法 JSON 原文件不变。

### WP13.3 原子写与回退

施工：接权限、atomic write、checkpoint 和耐久写事实，验证失败和取消。

验收：文件损坏/写入失败不伪造成功；真实 diff 可审阅和范围回退。

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
