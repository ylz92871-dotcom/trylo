# 中央学习时机分析入口

这是接收已给条件、一次求值并返回时机建议的独立模块。当前CLI/调度器未调用它；不新增服务、timer、Board writer、学习执行或预算分配。研究及源依据见仓库`work/learning-timing-20261104/README.md`，P05交接记录在本轮时机工作包。

## 三个入口

- `analyzeLearningTiming(json, options?)`：有限、无环、risk-neutral/additive的predictive context模型，比较完整剩余策略；输出单一首公共控制的支配证书、已有可行lower策略DAG、数值理由与条件后继。
- `analyzeLearningStartWindow(json, options?)`：固定程序、无新观察、外生用途/干扰、单一闭合法开始区间；从占用profile/phase折点、soft用途和joint二次响应推导开始时点，区分取得的最大与未取得的sup。
- `analyzeTopicLearningTiming(json, options?)`：复用现`TopicBudgetBid`守卫/full hash，绑定外部已经选定的离散q、当前context和完整评价；收到bid但无未来模型时返回请求basis及`requires_timing_model`。

JSON在边界解析一次，外部输入严格校验，失败为`invalid_input / unsupported_model / binding_mismatch / planning_limit / numeric_limit`，带reason/at。已知分析失败转结果，意外程序错误重抛。新入口是附加的临时分析合同schemaVersion1；不修改现bid、allocation、grant或持久化schema，也不提供旧研究point quote导入/cache兼容。

## 同一个完整目标

`evaluationRef`必须标识同一业务终点/合法tail、收益与费用协议。utilityUnit相同不证明目标相同。所有r/K、closed响应与upper均须在当前basis、实际history/进度/资源条件下成立。

在充分context x，edge的条件值为`r(x,a)+Σ p(y|x,a)V(y)`。r是到下一context之前的条件新增净值，p只乘child一次；closed已覆盖完整后续，不再加child。已有费用不重复扣，普通业务自然信息保留在相应baseline，未形成的计算能力不免费给对照。

source负责context充分性、controlled K、价值/upper覆盖与现实可行性。模型可以使用完整history或真正充分摘要，不能按同名time/node把不同belief/active年龄/receipt覆盖/剩余资源合并。当前实现memo每个context一次；这是给定图上的算法，不保证取得这张图廉价。

## 三种predictive项

`PredictiveTimingModel`公开完整输入类型。header为`schemaVersion:1`、`modelKind:'finite_predictive_expected'`、sourceScope/basisRef/evaluationRef/utilityUnit、root、`coverage:'complete-declared-family'`、reference、contexts。

- `closed`：真实完整lower programRef与[L,U]；firstControl对应这条完整policy的实际单一第一公共操作。
- `edge`：source声明真实可行的公开operationRef、immediate[L,U]与穷尽outcome row。weight是非负相对权重，精确归一后使用；零权重不生成后继/程序。first leg可行及child条件相符仍是来源前提。
- `closed_upper_frontier`：同一firstControl策略族的完整upper及frontierScopeRef，没有可执行程序。它可排除尚未展开竞争；永不从U制造lower或推荐。mixed-first frontier不在该合同内。

edge只有每个正质量child都已有匹配完整lower policy时才拼接lower；否则它仅有upper。context/root全无lower时为`no_witness`，lower/witness/gap为null，不能填0。取max lower只保存best-known真实见证，未决时不会默认推荐它或等待。

`noMoreAction`识别closed或upper-frontier中的`no_more_processing`覆盖项；它本身不产生lower。null明确此声明家族没有该项，不能用于隐藏可能的退出/普通业务竞争者。报告reference可为null；提供时保scopeRef和值界，仅报告增量，不因有benchmark便增加一个可执行动作。

strict/nonInferior来自已有完整first-c lower与全部其它first upper的`>`/`≥`比较。第一控制正确不保证同控制内部的opaque程序已最优，需同时看完整gap。单一控制没有其他比较对象，不能解读成有正数优势或完整policy唯一。相等upper不证明真正并列；点值并列及其穷尽范围单列。

## 请求basis与重新判断

Topic入口的JSON字段为`{schemaVersion:1,bid,quota,contextRef,evaluationRef,model}`。先以model:null取得basis，再由原source提供同basisRef的完整条件模型。响应的sourceScope须等于bid.scope，utilityUnit/evaluationRef须匹配。basis包含actual full bid hash和外给q；当前q点只回显追溯，不自动作为完整时机r插入。模型hash由本模块对实际声明自行计算。

contextRef由caller维护，应覆盖相关实际history、业务mode、κ/进展、观察能力、资源与模型版本。hash/字符串匹配防机械旧basis复用，不认证source重算、校准、实时状态或权限。更换q/bid/context/目标要形成新请求；不调用prepare/invoke/funding.inspect来补数据。

输出保留basis/modelHash与策略可观察分支。实际执行了相应公开操作并取得匹配观察后，可在当前条件仍成立时进入已有child；未覆盖history、source/目标/可行前提变化要由原owner重建模型。旧等待截止、active年龄与外生日历T不因再次call而重置。上次建议pause不证明实际已暂停，费用/mode按owner确认。

## 物理开始族

`LearningStartWindowModel`要求program/basis/evaluation引用、utility/time单位、完整I(t)、joint worlds内的duration/useBy/gross二次/未来fee/profile，以及source声明全区间real starts合法。gross不得已含另列费用；错过soft useBy只失去对应gross，费用仍付。T只是本受限模型闭合全部占用/费用的范围，跨T未给tail不代表真实Permission非法。

折点为phase−profile端点、useBy−duration与合法区间端点。每open cell先混合world二次系数再加合法凹顶点，另算实际boundary与单侧limit；flat窗口端点按实际值判断。不会逐隐藏world各选最佳。

`max_attained`的maximizer是一个取得见证，不宣称唯一；`supremum_unattained`保maximizer:null、实际bestKnown与gap。options.requestedRegret若提供，必须是外给正效用regret；按真实净值导数界构造满足该family误差的内部点，仍保sup未取得，无默认ε或时间间隔。实数start不认证宿主能在该时点dispatch；若只有grid/slot，须原source给相应控制域另建模型。

## 数值和证据范围

Number代表其实际binary64值；fraction literal是有界`n/d`字符串（负号只在分子、正分母），输出规范n/d。整数输入仍可产生2/3时点与4/3值，不round回浮点后沿用原严格证书。JSON数字若先下溢为0，算术不会恢复原作者的实数意图；需要更小正权重时用fraction literal。

4096-bit最大工作帽及有限图/物理候选帽是分析规模限制，不是预算或真实CPU/内存/时钟承诺。超过帽明确失败，不用截断prefix或0冒充完整解。精确算术不能认证现实forecast、联合统计覆盖或学习效果；所有证书条件于source声明。

本轮只运行隔离TypeScript与新模块必要合同，记录源码闭包hash/快照和结果；无真实provider、native Desktop、包装发行或长期收益验收。论文启发、替代方案、反例、尚未移植的连续event/区间K/checkpoint链及下一步源识别问题保留在研究归档。
