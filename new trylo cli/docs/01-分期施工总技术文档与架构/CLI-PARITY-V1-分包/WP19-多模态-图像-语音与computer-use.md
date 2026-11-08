# WP19 多模态-图像-语音与computer-use

- 状态：已批准（依据用户要求独立文件夹拆分工作包；细化已授权版本范围）
- 阶段：P00 / CLI-PARITY-V1，普通 Agent 基底追平
- 负责人：Codex 编制；施工与独立复核人在领包时记名
- 最后更新：2026-10-04
- 依赖决策：[总版本合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/P00-CLI-PARITY-V1-复用复核接线技术规格.md>)、[分包ADR](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-CLI-PARITY-V1细分工作包.md>)、[仓库代码纪律](<D:/CC/trylo/new trylo cli/docs/00-总领/代码可读性可维护性与审计纪律.md>)；全部默认可复用，不查许可证。

- 所属原包：R9；角色：施工主责
- 主责能力：C25, C26, C59, C85, L10, A09, A10
- 接口前置：[WP12](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP12-搜索-LSP与IDE导航.md>)、[WP18](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP18-Provider-认证-Responses与结构化输出.md>)
- 集成联验：[WP13](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP13-PDF与Notebook读写.md>)、[WP21](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP21-用户问答-Plan-Task与Goal生命周期.md>)、[WP23](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP23-日用TUI输入-渲染-键位与等待原因.md>)
- 代码纪律：[统一施工合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-施工纪律与交接合同.md>) 为本包第一门禁；本包不得简化其中要求。
- 施工状态：工作包已编制，不能据此认定实现或验收完成。

## 强制实际复核（2026-10-04用户决定）

本包每根关键接线在进入生产集成前，都要先提交实际复核记录。 按 [实际复核与路线确认](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-实际复核与路线确认.md>)、[实际复核表](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-单包施工交接模板.md>) 执行；本包的源码现状、平台支持和直接复用建议均是待实际证据确认的候选，不能凭Codex或其他模型的文档结论直接施工。

必须追到当前新版消费者、来源实际依赖/版本、已有helper/制品及最小闭包；先比较最短真实复用途径，运行有界探针并记录正常结果、失败/反例、hash和未验证范围。上层注释、工具名、status成功、搬运/注册和扫描不到vendor都不能替代真实实现/接线/就绪证明。已批准范围、Trylo唯一owner与代码第一门禁保持不变。

实际复核否定原建议时，把证据与更正同步写回本包、来源报告、必要ADR及主矩阵复用建议；不伪升能力成熟度。[WP04来源更正](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-WP04-Windows复用来源更正.md>)作为复核先例，不把它外推成其他包已经验证。


## 1. 用户结果与边界

接实际存在的媒体实现，保留缺件和实验条件的真实限制。

本包接点/owner边界：**自有内容块；媒体ToolPort；授权与设备边界**。沿用Trylo的既有唯一owner，来源代码只提供机械实现；涉及的新合同先冻结版本、状态转换和迁移，再动实现。学习控制面范围沿用总规格，不因复用能力扩权。

## 2. 逐项施工范围与直接复用

下表是分包时快照；最新成熟度以 [主能力矩阵](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/evidence/2026-10-04-parity-v1/capability-coverage.json>) 和工程产出证据为准。

| ID | 能力 / 优先级 | 源码审计状态 / 接线成熟度 | 尚需闭合 | 直接复用建议 |
| --- | --- | --- | --- | --- |
| C25 | 本地图片查看 / P1 | 缺失 / contracted | 无本地图像查看工具，消息合同也只有文本。 | 取 utils/image/view_image，扩展自有内容块与工具结果。 |
| C26 | 图片输入参数/附件 / P1 | 缺失 / contracted | 无图片参数、附件、剪贴板图片输入链。 | 复用旧图片准备或 Codex attachment/composer 状态，接多模态 provider。 |
| C59 | 生成图片 / P2 | 缺失 / contracted | 无图像生成工具和输出素材链。 | 取 ext/image-generation 服务 adapter，接有能力的实际图像服务。 |
| C85 | 实时语音 / P3 | 缺失 / contracted | 无语音输入/实时对话及对应内容协议。 | 直接复用 voice-host/realtime 客户端；接真实服务与设备入口。 |
| L10 | 图像文件读取与图像 payload（共用 C25） / P1 | 缺失 / contracted | 无本地图像查看工具，消息合同也只有文本。 | 取 utils/image/view_image，扩展自有内容块与工具结果。 |
| A09 | WebBrowser/computer-use/Chrome集成 / P3 | 基线缺件 / contracted | 旧browser/computer-use部分构建为空数组；新版也无完整链。 | 仅复用非空transport/Chrome集成；空工具部分明确补实现。 |
| A10 | voice mode、assistant/Kairos、ultraplan / P3 | 部分 / contracted | 语音见C85；assistant/Kairos/ultraplan部分为stub。 | 取非空voice/assistant或Codex voice-host；stub不报完成。 |

源码定位与条件限制（先读这些行，再沿真实import/build闭包取文件）：

- **C25**：[C25源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:42>)；`core/src/tools/spec_plan.rs:1269` ViewImageHandler 注册；`handlers/view_image.rs`；Stable 默认 true；模型输入能力仍影响结果；`utils/image` + view_image handler 的边界语义
- **C26**：[C26源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:43>)；`utils/cli/src/shared_options.rs:13` image 参数；`tui/src/bottom_pane/chat_composer.rs:885` image paste 开关、`:1221` path 附件；常规；平台剪贴板/模型 image modality 有条件；图片准备/附件 DTO、Composer attachment state
- **C59**：[C59源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:76>)；`core/src/tools/spec_plan.rs:699` availability；`:714` free plan排除、`:719` provider capability、`:724` modality；app-server/src/extensions.rs:114 install；flag Stable true，但需账户、模型、backend/service；不能计所有provider默认可用；`ext/image-generation` service adapter；Trylo接自己的provider
- **C85**：[C85源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:102>)；`tui/src/chatwidget/slash_dispatch.rs:336` toggle；`app-server/src/request_processors/turn_processor.rs:277` real start；`app-server-protocol/src/protocol/common.rs:1046` experimental RPC；voice/model/backend/host能力有条件；旧realtime_conversation flag已Removed false，不能据此宣称功能没有接线；`voice-host` / realtime provider adapter，条件能力单列
- **L10**：[L10源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:35>)；普通 FileRead 分支；需真实图像处理依赖与 vision provider；[FileReadTool.ts:654](<D:/CC/trylo/trylo cli/src/tools/FileReadTool/FileReadTool.ts:654>)、[FileReadTool.ts:188](<D:/CC/trylo/trylo cli/src/tools/FileReadTool/FileReadTool.ts:188>)
- **A09**：[A09源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:112>)；WebBrowser 有 `WEB_BROWSER_TOOL`，computer-use 有 `CHICAGO_MCP`；`@ant/*` 构建替换成空 BROWSER_TOOLS/COMPUTER_USE_TOOLS，故不能算完整可用；[tools.ts:117](<D:/CC/trylo/trylo cli/src/tools.ts:117>)、[cli.tsx:86](<D:/CC/trylo/trylo cli/src/entrypoints/cli.tsx:86>)、[build.mjs:132](<D:/CC/trylo/trylo cli/scripts/build.mjs:132>)
- **A10**：[A10源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:113>)；`VOICE_MODE` / `KAIROS` / `ULTRAPLAN`；部分 chooser/dialog 是 stub；[commands.ts:70](<D:/CC/trylo/trylo cli/src/commands.ts:70>)、[commands.ts:80](<D:/CC/trylo/trylo cli/src/commands.ts:80>)、[commands.ts:104](<D:/CC/trylo/trylo cli/src/commands.ts:104>)、[AssistantSessionChooser.ts:1](<D:/CC/trylo/trylo cli/src/assistant/AssistantSessionChooser.ts:1>)

复用工程边界另见 [最小闭包、薄桥与sidecar建议](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/reuse-engineering.md>)。源码有入口不等于此包真实可用。

## 3. 包内接线任务与验收

### WP19.1 图片与媒体块

施工：复用 Codex图像/多模态和旧图片读入机械层，格式/MIME/大小经边界守卫转换。

验收：本地真实图片被模型消费；坏文件/超限/不支持模型明确失败；不把路径字符串当图像。

### WP19.2 语音与实时交互

施工：抽取本地确实存在的 realtime/voice 外围，连接设备授权、会话取消与TUI呈现。

验收：真实音频输入/输出/打断/退出证据；chooser stub 不复制成“已完成语音”。

### WP19.3 computer-use 缺件处理

施工：核查 A09 的空 BROWSER_TOOLS/COMPUTER_USE_TOOLS；只接两基线中真实可取的实现。

验收：缺失部分保留 source_missing 与目标，不复制空数组充数；在本范围找到实装前不能验收该ID。

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
