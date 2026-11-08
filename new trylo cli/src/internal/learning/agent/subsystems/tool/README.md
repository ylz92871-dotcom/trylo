# 工具学习子系统

本目录持有已有工具学习的策略、编排、资产处理与专用适配，测试与被测模块同目录。

## 2026-11-04 研究、获取与进化施工

研究不再停在一次检索。规划工单可以阅读精确候选的 API、文档与源码，重新检索本地工具库，根据新证据改变方案；历史失败和重复信息会收束调查。原任务中实际挂载过的工具提供带 binding hash 的只读观察，后台库存缺失不能被解释成不存在该能力。所有决策与构造继续共用原 Board 生命周期额度，批准和恢复都不补额度。

显式 `tools acquire-learning` 授权后的 npm 链路继续到真实安装文件、独立冻结任务检查、实现与 source 调试，再保存不可变生产候选。既有 CLI/MCP、软件库 JSON 适配层、受限 JS 文件补丁分别有执行者；未接入自动构造的 GitHub/PyPI/MCP registry 只能作研究或现有工具复用线索。已生成纯工具也可以在保留原身份与检查契约后，改用获准 npm 依赖。后续调用仍须原生产独立验证和 exact activation，同一任务里的目录不热换。

源码精确编辑使用旧内容哈希和唯一文字锚点；底层展开为完整不可变源码，既不模糊修补，也不修改安装原件。升级上游先测试新版干净源码是否已经解决旧补丁的目的。仓库参考、发布者标签、已审查 tarball 身份、实际安装文件哈希分开记录，只有最后一种可以成为文件补丁基准。

检查答案先于实现冻结。重试、普通反馈及新增批准候选不能重新抽取 oracle；有新要求但旧契约覆盖不了时等待明确修订或新任务。用户批准的精确期望更正从已有契约派生，仅改对应 expected，保留其它输入、角色和 synthetic/heldout 样例。实现提示词不包含 host frozen basis 中的隐藏样例。生产检查只有真实返回值/工具错误不符才排实现调查；环境、权限、隔离与来源失败保持阻断。

后续使用的条件用法会在下次正常挂载时呈现。只有真实调用记录确实曝光了某条用法，且后续用户/验证者评价支持，才把该条建议标成有反馈支持；晚报的旧调用与模型自评不算。负面反馈保留情景并撤回对应建议，不能授予停用、修源或切换权限。

中断恢复区分已提交候选和未知外部调用。前者从 exact Board 产物恢复，不重付模型调用；后者须原 claim 过期和显式 recovery review，先 fence 旧 attempt，再保守结算原额度。已安装包用 `--resume-child` 续做，不重新签发安装许可。Desktop 的获取审阅与进度使用相同 CLI 合同。

获取失败后可在原任务额度内重新调查。`acquisition-inquiry-*` 绑定原批准决定和真实失败，复用研究端口；新的 acquire 选择物化为标准待审任务，须新的 exact 审批才继续获取与适配。`tool-funding-origin` 在 Board 内证明其原资金来源，缺失、关闭或他人活跃 claim 不会创建新 grant。已提交结果先零模型恢复；明确的 provider 停机可由用户重新确认同额度续查，不自动重试或切换默认模型。其他策略先作为可审阅提案保存，不能声称已经执行。

同一父版本、同一批实际使用事实的模型反馈换 ID 或措辞，仍归原调查。原始用户文字和当时工具目录由宿主有界绑定；无调用也能提出不足假设，捕获失败不伪装成空目录。反馈、旧条件和实际曝光按精确来源工作区读取，不把其他情景的 supported 状态继承给新版本。

修复任务的 create/compose 也须保全普通父候选的全部检查。正常宿主现在将更强 pure production 的 exact 原检查锚定在 Board 的不可变合同中，生成只接收训练证据；构造后自动准备保留完整原 checks 的生产后代，仍待原生产检查与单独启用审批。生产读取会拒绝同一候选另挂弱化检查。原检查是继承回归证据，不重新声称新鲜泛化证据；歧义的多父来源及训练输入侵入隐藏检查明确等待。旧不支持该合同的 adapter 继续安全等待。获准 npm 替代也保留 exact 生产合同。历史 P1/C1 退役不抹掉已保存替代品的来源证明，但不恢复旧执行权限。生产失败读取先筛选精确父版本，避免经替代品自身报告递归校验来源。

PA 的工具 focused-learning 通过公开 `createToolPersonalAgentLearning` 进入同一队列和工具生命周期额度。`scope` 保留原 workspace ID，`centralScope` 使用 workspaceRoot；新的中央 issue 可被 PA 直接读到，既有 hash-scope grant 不静默迁移或补额。缺工具学习开关、执行授权、精确 source 或额度时返回明确失败，不向协作 worker 派错域工作。

后台两分钟时间窗耗尽保存进度为 waiting，不冒充用户取消；只允许明确指定原任务的 manual 续做，自动边界不重发。中央当前执行每 grant 的固定额度与租约，不是跨任务总池或价值分配器；合成 fresh checks 和一次返回均不证明长期泛化或净收益。

本轮记录及最终验证边界见 `docs/02-分期工程产出/P05-Experience-Learning-V0.3/2026-11-04-施工记录-工具研究适配与持续进化.md`；施工中的测试文件和设计记录不构成已通过验收。

## 2026-11-03 可持续学习入口

- 正常模型请求共用 `trylo-tool-gap` 报告一次有事实支撑的语义机会；`tool_learning_report` 提供 context / uses / opportunity / feedback。执行传感器只传调用坐标、版本和哈希，成功返回不等于任务质量通过。用户显式入口为 `tools queue`、`tools feedback <report.json>` / `tools feedbacks <versionId>`；PA 继续使用统一工具库的公开 requestCapability。
- `pipeline-worker` 在已有 Board 工单内先读取工具库、旧版本与任务反馈，再调用规划端口；可选择复用、用法建议、一次定向研究、获取待授权、改进、静态组合、创建或合理退出。普通需求不再强制要求人写 request.json。真实需求/契约先于样例冻结；合成样例明确标注，源码修正不得降低原预期。
- `learning-funding` 经原 `coordinate_learning` writer 使用中央 `tool-allowance` 政策。规划、研究后的再规划和生成共用一份任务生命周期额度，单次预留对应单次模型请求；未知用量保守记账，恢复不补额度。纯源码修正最多两次且继续消耗同一额度。学习额度不是工具权限。
- 报告工具在任务报告边界异步交接并派发原后台 worker，close/下次打开补交；执行热循环不检索、生成或安装，当前任务的目录保持冻结。取消与迟到归档仍由 Board claim 和原 monitor 拦截。
- `tool-task-feedback` 保存独立评估，绑定已有 version/session/use/contentHash；`feedback-learning` 将有归因的实现/用法问题幂等排队并恢复丢交接。环境、配置或归因未知不自动改造。原 improve 所有者消费这些反馈；后续挂载按情景提供有来源的经验，context 查询按工具/工作区取建议。负面建议不产生停用或切换权限，长期操作继续走原生产所有者。
- `composition` 将 2–8 个固定版本的已有纯 JSON 工具静态编译为一个候选，保留依赖版本/数据流来源，重走原隔离检查、不可变归档和生产审批。没有把有副作用的 CLI/MCP 调用藏进组合函数；外部包获取/安装继续使用原 exact-byte 与许可证准入流程。

兼容：原 plan / recipe / result schemaVersion=1 继续读取，新字段为加法；旧 create 配方和明确授权的 improve 配方保留。旧库修改请求可从已有 evidenceRefs 精确还原父版本，不改原工单身份。新增 task-feedback / decision 是原 Board 不可变资产，不产生第二个 writer。含新中央 tool grant 的数据应先升级读取程序，旧程序不得降级写回。公开运行数据路径不迁移，已激活版本不会因学习候选而自动替换。

完整实现、调研、自审、验证边界与继续运行方法见：`docs/02-分期工程产出/P05-Experience-Learning-V0.3/2026-11-03-实现与自审-可持续工具学习.md`。本轮真实 provider 样本停在规划服务失败；本地合同、模型行为、原生/安装包和长期净收益是不同证据。

```text
tool/
  index.ts                    纯策略与合同入口
  domain/
    awareness/                三源信号、佐证、决策、频控
    refine/                   描述精炼与覆盖层语义
    evolution/                候选、配方、生产计划、独立验证与使用合同
    curator.ts                工具缺口与候选编排策略
    pipeline.ts               现有纯候选流水线
  assets/
    acquisition/              比较、许可证、准入策略
    builder/                  工具设计与不可变版本构建
    contribution/             贡献包及用户驱动提交合同
    my-tools/                 只读投影、命令草案
    validation/               既有隔离验证阶段编排
    quarantine/               纯档案路径、内容与大小审计
    events/memory-log.ts      纯内存事件累积
  runtime/
    index.ts                  宿主组合入口
    gap-session.ts            账本与 close/outbox 交接编排
    awareness-runtime.ts      事实汇总、提议、提示
    refine-runtime.ts         描述精炼编排
    ledger-file.ts            原追加账适配
    overlay-file.ts            原覆盖层文件适配
    evolution-*.ts            生成、归档、试用与跨任务复用
    pipeline-*.ts             Board 工单、配方、队列、worker 与状态
    production-*.ts           生产资产、检查、审批消费、激活与只读视图
    outbox-*.ts               可恢复提议交接
  adapters/
    board/                    工具草案到共享 Board 命令映射
    acquisition/              白名单平台检索、隔离获取、npm 安装/验收适配
    evolution/                工具专属生成指令、verifier 与后台分发
    quarantine/               受授权的隔离收容与文件写入
    events/                   原事件文件的追加与恢复
  testing/production-fixtures.ts 工具生产专属测试夹具
```

`index.ts`、`domain/awareness/index.ts`、`domain/refine/index.ts`、`domain/evolution/index.ts` 是纯策略/合同出口；宿主使用 `runtime/index.ts` 和按职责分组的 adapter 入口。内部模块只依赖合同、端口或共享设施，不通过旧路径绕回本域实现。

共享所有者保持原位：`learning/control` 的 Board 状态与唯一 writer、Permission、通用执行/工具运行/沙箱、provider 传输、UI；`tooling` 的 contract/catalog/approval/deferred/dynamic/exposure/package-spi/plugin/sandbox/testing/side-effects。`adapters/tool-evolution` 的 `artifact-worker.ts`（`createArtifactWorker`）和候选进程 executor/protocol/JSON profile 为检查学习与工具生产共用，继续由原基础设施持有；本域只持有工具生成指令与薄专用工厂。

CLI 保留旗面、凭据/连接选择、宿主数据根解析、权限与隔离后端组合。工具学习的 close/outbox 交接和生产启停编排在本目录。运行数据仍使用原 `tryloHome/learning/tool`、`learning/board` 等位置，资产身份、哈希、持久化格式与权限语义不变。

保留旧路径的薄转接及具体消费者、移除条件见同批迁移记录与 `evidence/2026-11-03-method-tool-relocation/compatibility.json`。五个受保护子系统（技能、工作流、检查、路由、协作）及用户学习保持原位；其调用不因本次迁移改写。历史证据与同源旧生成 JS 不改写。
