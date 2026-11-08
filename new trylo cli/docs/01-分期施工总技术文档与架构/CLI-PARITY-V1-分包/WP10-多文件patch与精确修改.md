# WP10 多文件patch与精确修改

- 状态：已批准（依据用户要求独立文件夹拆分工作包；细化已授权版本范围）
- 阶段：P00 / CLI-PARITY-V1，普通 Agent 基底追平
- 负责人：Codex 编制；施工与独立复核人在领包时记名
- 最后更新：2026-10-04
- 依赖决策：[总版本合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/P00-CLI-PARITY-V1-复用复核接线技术规格.md>)、[分包ADR](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-CLI-PARITY-V1细分工作包.md>)、[仓库代码纪律](<D:/CC/trylo/new trylo cli/docs/00-总领/代码可读性可维护性与审计纪律.md>)；全部默认可复用，不查许可证。

- 所属原包：R4；角色：施工主责
- 主责能力：C15, C16, C17, C18, C19, L14, L15
- 接口前置：[WP01](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP01-耐久会话与未知动作核对.md>)、[WP03](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP03-权限规则-审批与持久账本.md>)、[WP04](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP04-OS隔离与Windows沙箱.md>)、[WP05](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP05-平台shell与普通进程.md>)
- 集成联验：[WP11](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP11-diff-review-checkpoint与范围回退.md>)、[WP13](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP13-PDF与Notebook读写.md>)、[WP25](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP25-本地RPC-worktree与code-mode.md>)
- 代码纪律：[统一施工合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-施工纪律与交接合同.md>) 为本包第一门禁；本包不得简化其中要求。
- 施工状态：工作包已编制，不能据此认定实现或验收完成。

## 强制实际复核（2026-10-04用户决定）

本包每根关键接线在进入生产集成前，都要先提交实际复核记录。 按 [实际复核与路线确认](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-实际复核与路线确认.md>)、[实际复核表](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-单包施工交接模板.md>) 执行；本包的源码现状、平台支持和直接复用建议均是待实际证据确认的候选，不能凭Codex或其他模型的文档结论直接施工。

必须追到当前新版消费者、来源实际依赖/版本、已有helper/制品及最小闭包；先比较最短真实复用途径，运行有界探针并记录正常结果、失败/反例、hash和未验证范围。上层注释、工具名、status成功、搬运/注册和扫描不到vendor都不能替代真实实现/接线/就绪证明。已批准范围、Trylo唯一owner与代码第一门禁保持不变。

实际复核否定原建议时，把证据与更正同步写回本包、来源报告、必要ADR及主矩阵复用建议；不伪升能力成熟度。[WP04来源更正](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-WP04-Windows复用来源更正.md>)作为复核先例，不把它外推成其他包已经验证。


## 1. 用户结果与边界

直接复用 Codex apply-patch 实现，支持安全的多文件变更。

本包接点/owner边界：**ToolPort；路径授权；file_write事实；patch helper**。沿用Trylo的既有唯一owner，来源代码只提供机械实现；涉及的新合同先冻结版本、状态转换和迁移，再动实现。学习控制面范围沿用总规格，不因复用能力扩权。

## 2. 逐项施工范围与直接复用

下表是分包时快照；最新成熟度以 [主能力矩阵](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/evidence/2026-10-04-parity-v1/capability-coverage.json>) 和工程产出证据为准。

| ID | 能力 / 优先级 | 源码审计状态 / 接线成熟度 | 尚需闭合 | 直接复用建议 |
| --- | --- | --- | --- | --- |
| C15 | 多文件 patch / P0 | 部分 / contracted | 单文件 edit 有；缺一次多文件 add/update/delete/move patch。 | 直接复用 Codex apply-patch 二进制或其 parser/update 最小闭包。 |
| C16 | patch 新增文件 / P1 | 部分 / contracted | write_file 能新增；统一 patch 内的 AddFile 分支没有。 | 复用 apply-patch AddFile，沿已有 checkpoint/权限写盘。 |
| C17 | patch 删除文件 / P1 | 缺失 / contracted | 标准 patch 没有 DeleteFile；不能用任意命令绕行算同等 patch 能力。 | 复用 apply-patch DeleteFile 与实际改动 delta。 |
| C18 | patch 移动/重命名文件 / P1 | 缺失 / contracted | edit 禁止 rename/move；无标准多文件移动补丁。 | 复用 apply-patch move_path，审批覆盖源和目的路径。 |
| C19 | patch 的部分成功/失败证据 / P0 | 缺失 / contracted | 无多文件 patch 的部分成功 delta；单文件失败不改盘是另一种合同。 | 直接复用 AppliedPatchDelta/ApplyPatchFailure，映射新版事件。 |
| L14 | 精确编辑、replace_all、外部修改检测 / P1 | 部分 / contracted | diff已有；无old_string/replace_all及等价外部修改检查。 | 取FileEditTool匹配/替换/读版本校验。 |
| L15 | 写文件/新文件、编辑 diff 与快照 / P1 | 部分 / contracted | write/新增文件/写前快照已有；编辑差异预览与统一diff呈现待补。 | 保留新写工具/checkpoint，直接搬旧FileEditToolDiff/StructuredDiff视图。 |

源码定位与条件限制（先读这些行，再沿真实import/build闭包取文件）：

- **C15**：[C15源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:32>)；`core/src/tools/spec_plan.rs:1255` 注册；`apply-patch/src/lib.rs:401` apply_hunks；条件：模型目录声明 apply_patch_tool_type；不是单文件 edit；`apply-patch` parser + file update 实现
- **C16**：[C16源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:33>)；`apply-patch/src/parser.rs:67` AddFile；`apply-patch/src/lib.rs:508` 执行；常规 patch 能力；同 C15
- **C17**：[C17源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:34>)；`apply-patch/src/parser.rs:71` DeleteFile；`apply-patch/src/lib.rs:536` 执行；常规 patch 能力；必须沿 Trylo 权限流程；同 C15
- **C18**：[C18源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:35>)；`apply-patch/src/parser.rs:76` move_path；`apply-patch/src/lib.rs:619` 真实目的路径写入；常规 patch 能力；不能宣称多文件事务全有或全无；同 C15，保留部分失败 delta
- **C19**：[C19源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:36>)；`apply-patch/src/lib.rs:247` AppliedPatchDelta；`:314` ApplyPatchFailure、`:333` into_parts；常规；显式报告已发生变更；直接复用 patch result/delta 语义，转成 Trylo DTO
- **L14**：[L14源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:39>)；普通 Edit 工具；旧内容验证与写权限；[tools.ts:204](<D:/CC/trylo/trylo cli/src/tools.ts:204>)、[FileEditTool.ts:125](<D:/CC/trylo/trylo cli/src/tools/FileEditTool/FileEditTool.ts:125>)、[FileEditTool.ts:138](<D:/CC/trylo/trylo cli/src/tools/FileEditTool/FileEditTool.ts:138>)
- **L15**：[L15源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:40>)；普通 Write 工具；写权限、file-history 接点；[tools.ts:205](<D:/CC/trylo/trylo cli/src/tools.ts:205>)、[FileWriteTool.ts:135](<D:/CC/trylo/trylo cli/src/tools/FileWriteTool/FileWriteTool.ts:135>)、[FileWriteTool.ts:223](<D:/CC/trylo/trylo cli/src/tools/FileWriteTool/FileWriteTool.ts:223>)

复用工程边界另见 [最小闭包、薄桥与sidecar建议](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/reuse-engineering.md>)。源码有入口不等于此包真实可用。

## 3. 包内接线任务与验收

### WP10.1 原实现与最小闭包

施工：固定 apply-patch 源码及 parser/streaming/file_update 等实际闭包，优先独立 binary。

验收：制品可单独启动且缺依赖显式失败；不能只复制 parser 声称完整实现。

### WP10.2 多文件与匹配合同

施工：接新增/删除/移动/精确与宽容匹配，决定 CRLF/末尾换行、symlink、路径与部分失败。

验收：多文件磁盘 diff 与计划吻合；路径越界/上下文失配拒绝；CRLF 和用户既有修改保留。

### WP10.3 授权和耐久副作用

施工：解析所有目标后统一授权，按真实写入事实记账，失败与取消给明确已改/未改/未知范围。

验收：取消/崩溃不报整体成功；partial write 可核对；原 edit_file absent 行为保留。

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
