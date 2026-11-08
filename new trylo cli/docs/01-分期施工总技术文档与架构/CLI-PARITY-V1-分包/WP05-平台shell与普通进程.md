# WP05 平台shell与普通进程

- 状态：已批准（依据用户要求独立文件夹拆分工作包；细化已授权版本范围）
- 阶段：P00 / CLI-PARITY-V1，普通 Agent 基底追平
- 负责人：Codex 编制；施工与独立复核人在领包时记名
- 最后更新：2026-10-04
- 依赖决策：[总版本合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/P00-CLI-PARITY-V1-复用复核接线技术规格.md>)、[分包ADR](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-CLI-PARITY-V1细分工作包.md>)、[仓库代码纪律](<D:/CC/trylo/new trylo cli/docs/00-总领/代码可读性可维护性与审计纪律.md>)；全部默认可复用，不查许可证。

- 所属原包：R1；角色：施工主责
- 主责能力：C06, C07, C09, L17, L19
- 接口前置：[WP01](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP01-耐久会话与未知动作核对.md>)、[WP03](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP03-权限规则-审批与持久账本.md>)、[WP04](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP04-OS隔离与Windows沙箱.md>)
- 集成联验：[WP06](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP06-PTY-长进程-stdin与后台终端.md>)、[WP07](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP07-取消-进程树清理与输出限额.md>)、[WP10](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP10-多文件patch与精确修改.md>)、[WP12](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP12-搜索-LSP与IDE导航.md>)、[WP15](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP15-MCP传输-资源-认证与连接管理.md>)、[WP17](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP17-生命周期Hooks.md>)
- 代码纪律：[统一施工合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-施工纪律与交接合同.md>) 为本包第一门禁；本包不得简化其中要求。
- 施工状态：工作包已编制，不能据此认定实现或验收完成。

## 强制实际复核（2026-10-04用户决定）

本包每根关键接线在进入生产集成前，都要先提交实际复核记录。 按 [实际复核与路线确认](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-实际复核与路线确认.md>)、[实际复核表](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-单包施工交接模板.md>) 执行；本包的源码现状、平台支持和直接复用建议均是待实际证据确认的候选，不能凭Codex或其他模型的文档结论直接施工。

必须追到当前新版消费者、来源实际依赖/版本、已有helper/制品及最小闭包；先比较最短真实复用途径，运行有界探针并记录正常结果、失败/反例、hash和未验证范围。上层注释、工具名、status成功、搬运/注册和扫描不到vendor都不能替代真实实现/接线/就绪证明。已批准范围、Trylo唯一owner与代码第一门禁保持不变。

实际复核否定原建议时，把证据与更正同步写回本包、来源报告、必要ADR及主矩阵复用建议；不伪升能力成熟度。[WP04来源更正](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-WP04-Windows复用来源更正.md>)作为复核先例，不把它外推成其他包已经验证。


## 1. 用户结果与边界

让完整 shell 语法和非 PTY 进程在统一授权与恢复下可用。

本包接点/owner边界：**ProcessPort；现 ShellSpawner 兼容 adapter**。沿用Trylo的既有唯一owner，来源代码只提供机械实现；涉及的新合同先冻结版本、状态转换和迁移，再动实现。学习控制面范围沿用总规格，不因复用能力扩权。

## 2. 逐项施工范围与直接复用

下表是分包时快照；最新成熟度以 [主能力矩阵](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/evidence/2026-10-04-parity-v1/capability-coverage.json>) 和工程产出证据为准。

| ID | 能力 / 优先级 | 源码审计状态 / 接线成熟度 | 尚需闭合 | 直接复用建议 |
| --- | --- | --- | --- | --- |
| C06 | 完整 shell 命令字符串 / P0 | 缺失 / contracted | run_shell 无 shell；只有结构化 steps/管道，缺完整 shell 语法。 | 取 shell-command 与 shell 参数构造，执行现成系统 shell。 |
| C07 | PowerShell/Bash/Zsh 等平台 shell / P0 | 部分 / contracted | Windows 可启动程序，但缺用户可选 PowerShell/Bash 等完整 shell 环境。 | 取 Codex shell_detect；旧 shellProvider/powershellProvider 同语言可直接搬。 |
| C09 | 非 PTY 管道进程 / — | 已有 / contracted | 非 PTY pipes 的普通程序执行已有。 | 沿用原 spawner；与 PTY 共用进程结果合同。 |
| L17 | shell 命令、超时、进度与输出（共用 C06） / P0 | 缺失 / contracted | run_shell 无 shell；只有结构化 steps/管道，缺完整 shell 语法。 | 取 shell-command 与 shell 参数构造，执行现成系统 shell。 |
| L19 | Windows PowerShell 专用工具（共用 C07） / P0 | 部分 / contracted | Windows 可启动程序，但缺用户可选 PowerShell/Bash 等完整 shell 环境。 | 取 Codex shell_detect；旧 shellProvider/powershellProvider 同语言可直接搬。 |

源码定位与条件限制（先读这些行，再沿真实import/build闭包取文件）：

- **C06**：[C06源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:23>)；`core/src/tools/spec_plan.rs:1079` 注册；`core/src/tools/handlers/unified_exec/exec_command.rs:290` get_command；`core/src/shell.rs:22` derive_exec_args；常规；shell_tool/unified_exec 均 Stable 默认 true；实际 shell 解释管道、重定向和控制语法；`shell-command` / shell 检测与参数构造，接 Trylo ProcessPort
- **C07**：[C07源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:24>)；`core/src/shell.rs:22`，`:32` PowerShell `-Command`；`:62` 从执行环境恢复 shell；常规；远端使用远端 OS/shell，指定其他 shell 有校验；`shell-command/src/shell_detect`，而非字符串替换器
- **C09**：[C09源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/codex-baseline.md:26>)；`core/src/tools/handlers/shell_spec.rs:50` tty=false 使用 pipes；`utils/pty/src/pipe.rs` 为真实实现；常规；PTY 与 pipes 是两种后端；同一 ProcessPort 可选择两种后端
- **L17**：[L17源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:42>)；普通 Bash；命令级权限、并发安全判定与 sandbox 包装；[tools.ts:197](<D:/CC/trylo/trylo cli/src/tools.ts:197>)、[BashTool.tsx:434](<D:/CC/trylo/trylo cli/src/tools/BashTool/BashTool.tsx:434>)、[BashTool.tsx:539](<D:/CC/trylo/trylo cli/src/tools/BashTool/BashTool.tsx:539>)
- **L19**：[L19源码入口](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/legacy-baseline.md:44>)；条件路径：Windows + 外部 `CLAUDE_CODE_USE_POWERSHELL_TOOL=1`，外部默认关闭；[shellToolUtils.ts:17](<D:/CC/trylo/trylo cli/src/utils/shell/shellToolUtils.ts:17>)、[PowerShellTool.tsx](<D:/CC/trylo/trylo cli/src/tools/PowerShellTool/PowerShellTool.tsx>)

复用工程边界另见 [最小闭包、薄桥与sidecar建议](<D:/CC/trylo/new trylo cli/docs/99-施工调研/2026-10-04-baseline-audit/reuse-engineering.md>)。源码有入口不等于此包真实可用。

## 3. 包内接线任务与验收

### WP05.1 直接复用 shell provider

施工：抽取旧 bash/powershell/detection/quoting 与 Codex shell-command 机械层，配置和 cwd 通过端口输入。

验收：PowerShell 与 bash 的引号、管道、重定向、退出码不靠字符串猜测；指定 shell 不存在显式失败。

### WP05.2 pipes 进程接线

施工：将 Codex pipe 后端接 ProcessPort，兼容现一次性 ShellSpawner，不搬旧 bootstrap 和全局状态。

验收：stdout/stderr/exit/cwd/env/argv 正确；命令含空格、中文、非零退出有真实磁盘与输出证据。

### WP05.3 执行边界与事实

施工：每个实际启动先获授权和耐久 intent，后产生运行/退出事实；依赖 WP07 清理约定。

验收：拒权不启动，提交后失联保留 unknown；环境与隔离不能因兼容路径被绕过。

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

## 2026-10-04 Windows 路径解析缺陷实际复核

本包新增必修阻塞项：当前直接 argv tokenizer 会删除未引用 Windows 路径的反斜杠，引用 UNC 也会被改写；普通引用盘符路径和正斜杠路径有不同结果，不能概括为所有绝对路径都失败。字母丢失还须追查解析前控制字符，不能凭错误渲染归因。

按 [实际复核与修复指令](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-实际复核-Windows命令路径解析.md>) 执行：红例先行，直接/真实 shell 语法显式区分，管道/审批/执行共享解析规则，保持权限不扩大，最后提交真实入口和隔离安装证明。本记录是缺陷证据与修复任务，未表示生产修复完成；C09/L17 的 Windows 签收仍未闭合。

## 2026-10-04 实际复核结论回写（三处更正）

施工与复核证据见 [WP05 施工记录](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/2026-10-04-WP05-施工记录.md>) 与 [`evidence/2026-10-04-WP05/`](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/evidence/2026-10-04-WP05/>)。以下三条修正本包原表述，成熟度按此下调，不伪升。

**一、shell 是「一次运行的决定」，不是 `run_shell` 的每 call 参数。** 原表 C06/C07 的复用建议未说明暴露方式。实测：给 `RUN_SHELL_BINDING` 加 `shell` 属性会改 `parameters` ⇒ 改 `toolCatalogHash` ⇒ `session-open.ts:90` 拒绝该改动之前记录的所有会话（B1 期 hash `173ebcaabec3a777d34b3521e51903c8` vs 加属性后 `bf7b75e755f53893854f6dfea043aa93`）。三方证据一致指向运行级：Codex `session.rs:1192` 的 `user_shell_override` 唯一生产设置方是 `..._for_tests`、Codex `shell.rs:92` 是唯一常规入口 `default_user_shell()`、旧 Trylo `resolveDefaultShell.ts` 读 `settings.defaultShell`。故落在 `settings/schema.ts` 的 `shell` 枚举键，**不进** `PACKAGED_DEFAULTS`（unset 有意义，打包会替用户选解释器）。

**二、Codex 的「指定 shell 不存在」处理不能照抄。** `get_shell_by_model_provided_path`（`shell_detect.rs:330-334`）以 `unwrap_or_else(ultimate_fallback_shell)` 静默回退到 `cmd`/`sh`。WP05.1 验收写的是「指定 shell 不存在显式失败」，本包按验收做，**有意偏离**并在此登记。

**三、C09「已有 / contracted」在 Windows 上原不成立。** 两项阻塞：(1) 宿主真实 `process.execPath` 是绝对路径，被 `allowAbsoluteExecutable:false` 以 `path_outside_workspace` 拒——注意 `resolveInsideWorkspace` 的 `failFast` 对绝对路径无条件拒绝，所以**工作区内的绝对路径同样被拒**，只能用 `./x` 形状；(2) 未引用 Windows 路径的反斜杠被 tokenizer 吃掉分隔符。两项均已修并各有红例（`01-tokenizer-red-before-fix.log`）。修法为**按词判定** `isWindowsPathWord(word, following)`，由 tokenizer 与管道拆分共用，满足「解析规则统一」。

另记两条本包实测、来源未载的事实：PowerShell 5.1 执行失败命令时**退出码为 0**（假成功），本包新增 `$LASTEXITCODE` tail 修正，Codex `shell.rs` 无此段；Windows 上 `child.kill()` 只终止 `cmd.exe`，孙进程存活并持有继承的 stdio（`OPEN-WP05-1`，修它需改 `shell-spawn.ts`）。

**成熟度更正**：C06/C07/L19 由「contracted」下调为「零件存在、生产不可达」——`shell-detect.ts` 与 `shell-mode.ts` 均无生产消费者。C09 为「本机 win32 真机验证通过」，18 条真实进程测试附磁盘证据。Linux/macOS 全部未测；安装产物（`dist/` 布局与独立启动）未取证。
