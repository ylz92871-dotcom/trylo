# CLI-PARITY-V1：28个工作包索引

> 2026-10-07 用户明确取消：删除 Cloud 任务平台、自托管/BYOC runner、模板部署和厂商私有服务接入的施工与验收要求；保留现有远程控制及后台任务、长进程、日志、取消、恢复、定时执行和条件监控，沿用现有执行体系。见 [最新范围决定](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-07-ADR-WP26范围收缩与本地后台能力保留.md>)。这不是暂缓或欠账；172 项仅为历史基线登记，C80/A05 从当前交付范围排除，其他条目取消的私有服务子项不计 PASS。

- 状态：已批准（依据用户要求独立文件夹拆分工作包；细化已授权版本范围）
- 阶段：P00 / CLI-PARITY-V1，普通 Agent 基底追平
- 负责人：Codex 编制；施工与独立复核人在领包时记名
- 最后更新：2026-10-07
- 依赖决策：[总版本合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/P00-CLI-PARITY-V1-复用复核接线技术规格.md>)、[分包ADR](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-CLI-PARITY-V1细分工作包.md>)、[仓库代码纪律](<D:/CC/trylo/new trylo cli/docs/00-总领/代码可读性可维护性与审计纪律.md>)；全部默认可复用，不查许可证。

## 拆分结果

同一个超大版本拆成 **26个施工包 + 2个全量验收包，共28包**。原 R1–R10 历史主责与 172 行基线登记保留；当前范围排除 C80/A05 与取消子项；细化后的每个ID只有一个主交付包。来源只用旧Trylo CLI与本地Codex，默认可以直接复用，不查许可证。本次不做token预算。

第一入口是 [施工纪律与交接合同](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-施工纪律与交接合同.md>)，第二入口是下表所领包。[机器可核查分包映射](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/能力分包映射.json>)记录172项唯一主责、接口前置、联验对象和开工快照；[单包交接模板](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-单包施工交接模板.md>)用于后续施工留档。

**工作包已分好，28包并未全部实现或验收。** WP01继承已经复核的W1耐久事实接点，继续做未闭合delta和人工核对；其他包应先核对最新调用链，已有能力做回归、缺失能力直接复用。[主能力矩阵](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/evidence/2026-10-04-parity-v1/capability-coverage.json>)是成熟度权威，分包快照不取代它。

## 强制实际复核（2026-10-04用户决定）

全部28包必须先按 [实际复核与路线确认](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-实际复核与路线确认.md>) 复核具体来源判断和施工路线，提交 [实际复核表](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/00-单包施工交接模板.md>)。源码判断/复用建议只作候选，不能因文档署名或已批准头省掉实际依赖、制品、探针、失败反例与独立复核；证据推翻建议后同步纠正文档。代码纪律第一，领域 owner 保持原合同，当前产品范围按最新用户取消决定执行。


## 施工包与验证包

| 包 | 用户交付 | 原领域 | 主责ID数 | 接口前置（提供可消费合同，不等整包验收） |
| --- | --- | --- | --- | --- |
| [WP01](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP01-耐久会话与未知动作核对.md>) | 耐久会话与未知动作核对 | R3 | 4 | 无 |
| [WP02](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP02-会话管理-fork与配置迁移.md>) | 会话管理-fork与配置迁移 | R3 | 6 | WP01 |
| [WP03](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP03-权限规则-审批与持久账本.md>) | 权限规则-审批与持久账本 | R10 | 6 | WP01 |
| [WP04](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP04-OS隔离与Windows沙箱.md>) | OS隔离与Windows沙箱 | R10 | 3 | WP03 |
| [WP05](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP05-平台shell与普通进程.md>) | 平台shell与普通进程 | R1 | 5 | WP01, WP03, WP04 |
| [WP06](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP06-PTY-长进程-stdin与后台终端.md>) | PTY-长进程-stdin与后台终端 | R1 | 5 | WP05 |
| [WP07](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP07-取消-进程树清理与输出限额.md>) | 取消-进程树清理与输出限额 | R1/R2 | 4 | WP05, WP06 |
| [WP08](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP08-运行中输入-steer与排队.md>) | 运行中输入-steer与排队 | R2 | 4 | WP01, WP07 |
| [WP09](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP09-上下文预算-压缩与截断恢复.md>) | 上下文预算-压缩与截断恢复 | R2 | 7 | WP01, WP08 |
| [WP10](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP10-多文件patch与精确修改.md>) | 多文件patch与精确修改 | R4 | 7 | WP01, WP03, WP04, WP05 |
| [WP11](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP11-diff-review-checkpoint与范围回退.md>) | diff-review-checkpoint与范围回退 | R4 | 5 | WP02, WP10 |
| [WP12](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP12-搜索-LSP与IDE导航.md>) | 搜索-LSP与IDE导航 | R5 | 7 | WP03, WP05 |
| [WP13](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP13-PDF与Notebook读写.md>) | PDF与Notebook读写 | R5 | 3 | WP03, WP10, WP11, WP12 |
| [WP14](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP14-Skill与项目指令实际消费.md>) | Skill与项目指令实际消费 | R6 | 9 | WP03, WP09 |
| [WP15](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP15-MCP传输-资源-认证与连接管理.md>) | MCP传输-资源-认证与连接管理 | R6 | 7 | WP03, WP05, WP18 |
| [WP16](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP16-Plugin-动态工具与延迟搜索.md>) | Plugin-动态工具与延迟搜索 | R6 | 9 | WP14, WP15 |
| [WP17](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP17-生命周期Hooks.md>) | 生命周期Hooks | R6 | 3 | WP03, WP05, WP09 |
| [WP18](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP18-Provider-认证-Responses与结构化输出.md>) | Provider-认证-Responses与结构化输出 | R9 | 9 | WP03 |
| [WP19](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP19-多模态-图像-语音与computer-use.md>) | 多模态-图像-语音与computer-use | R9 | 7 | WP12, WP18 |
| [WP20](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP20-Web搜索-抓取与memory读取.md>) | Web搜索-抓取与memory读取 | R9 | 5 | WP12, WP18 |
| [WP21](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP21-用户问答-Plan-Task与Goal生命周期.md>) | 用户问答-Plan-Task与Goal生命周期 | R7 | 9 | WP03, WP08, WP09 |
| [WP22](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP22-工具并行-子代理与团队.md>) | 工具并行-子代理与团队 | R7 | 11 | WP02, WP06, WP07, WP08, WP18, WP21 |
| [WP23](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP23-日用TUI输入-渲染-键位与等待原因.md>) | 日用TUI输入-渲染-键位与等待原因 | R8 | 13 | WP06, WP08, WP11, WP12, WP19, WP21, WP22 |
| [WP24](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP24-Headless-诊断-输出样式与工作流入口.md>) | Headless-诊断-输出样式与工作流入口 | R8 | 7 | WP02, WP09, WP11, WP18, WP23 |
| [WP25](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP25-本地RPC-worktree与code-mode.md>) | 本地RPC-worktree与code-mode | R10 | 7 | WP02, WP03, WP04, WP06, WP10, WP16 |
| [WP26](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP26-远端-Cloud-daemon与定时后台任务.md>) | 本地后台任务、调度监控与既有远控接线 | R10 | 8（历史10） | WP07, WP17, WP18, WP22, WP25 |
| [WP27](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP27-全量整合回归与172项复核.md>) | 全量整合与当前范围复核 | 验收 | 172行登记；当前170个ID的批准子能力验收 | WP01, WP02, WP03, WP04, WP05, WP06, WP07, WP08, WP09, WP10, WP11, WP12, WP13, WP14, WP15, WP16, WP17, WP18, WP19, WP20, WP21, WP22, WP23, WP24, WP25, WP26 |
| [WP28](<D:/CC/trylo/new trylo cli/docs/01-分期施工总技术文档与架构/CLI-PARITY-V1-分包/WP28-固定制品-真实provider-TTY与发行验收.md>) | 固定制品-真实provider-TTY与发行验收 | 验收 | 当前批准范围实机验收；取消项不作欠账 | WP27 |

## 接口就绪后的推进层次

编号按领域便于定位，不代表只能从01串行干到28。下列是无环前置关系的拓扑层次；每层只是可并行边界，实际资源分配另按施工者安排。前置接口未就绪时，消费包可先做自己的来源闭包和合同。

- 层1：WP01。
- 层2：WP02, WP03。
- 层3：WP04, WP18。
- 层4：WP05。
- 层5：WP06, WP10, WP12, WP15。
- 层6：WP07, WP11, WP19, WP20。
- 层7：WP08, WP13。
- 层8：WP09。
- 层9：WP14, WP17, WP21。
- 层10：WP16, WP22。
- 层11：WP23, WP25。
- 层12：WP24, WP26。
- 层13：WP27。
- 层14：WP28。

跨包消费的联验关系在各包单列，可能双向。先交版本合同和真实adapter，再联合验证；缺实际消费保持partial，不能拿“双方等整包完成”当推进方式。WP27可以提前做核对，但全量签收要等26施工包证据闭合；WP28依赖固定候选的真实安装/账户/任务/TTY验收。

## 工作边界与完成定义

每包都包含用户结果、逐项ID/缺口、直接复用源码定位、3根接线任务、成功与失败验收、owner边界、前置、联验、证据和回滚。具体细节按真实代码相邻合同收敛，不照名字再造第二套服务。

A04/A05/A09/A11/A12等源缺件保留在原主责包；实验/开关/服务/平台条件也保留。当前范围内找不到真实实现就记未闭合；用户取消项明确排除，不能复制空壳凑历史 172 项。代码纪律先行、门禁红先修、独立四眼复核、用户dirty成果保护和真实恢复验收均沿用原仓库要求。

施工记录：[P00工程产出](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁>)。分包决策与验证：[细分ADR](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/2026-10-04-ADR-CLI-PARITY-V1细分工作包.md>)、[分包完整性核查](<D:/CC/trylo/new trylo cli/docs/02-分期工程产出/P00-工程地基与质量门禁/evidence/2026-10-04-workpackage-split/validation.json>)。本轮仅整理文档，不改生产源码，也不启动新一轮接线。
