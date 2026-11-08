# 方法学习

本目录拥有方法学习及由方法实际使用形成的稳定经验。2026-11-03 的目录迁移已成为历史基线；当前机制升级由同日用户完整实现任务授权，经验不另建子系统。User Learning 仍与 Agent Learning 并列。

2026-11-04深化采用当前用户授权，最终机制与验证见P05的[设计与施工记录](../../../../../../docs/02-分期工程产出/P05-Experience-Learning-V0.3/2026-11-04-设计与施工-方法经验持续学习.md)和[收束与验收](../../../../../../docs/02-分期工程产出/P05-Experience-Learning-V0.3/2026-11-04-收束与验收.md)。11-03规格与证据保留为历史基线；研究、数学核验、正常入口、失败与真实模型限制分别记录，不把脚本模型或后验阈值当作真实长期效果证明。

## 入口

- `index.ts`：方法合同、模型槽/档案端口与 `createMethodBoard` 服务。只依赖纯域和注入端口，不加载文件存储或宿主实现。
- `adapters/index.ts`：供宿主组装的 `wireMethodLearning`、开关判定、唯一方法档案 Board 适配器，以及旧 prompt 提案 mapper。宿主传入 `boardRoot`、时钟和事件 sink。
- `experience-port.ts`：情景、采用/偏离/阻塞/纠正、按需展开与快照绑定模型提炼的窄合同。
- `legacy-prompt/index.ts`：既有 prompt patch 归因、检测和提案接口。其既有提案后评估流程位于 `orchestration/prompt-pipeline.ts`，通用 evaluator 仍由共享评估层拥有。

## 模块职责

```text
method/
  index.ts
  port.ts
  domain/
    contracts.ts          # 卡/账目/额度合同
    gate.ts               # 卡准入
    gate-draft.ts         # 外部草稿解码
    release.ts            # 失败事实与方法学习意图放权
    niche.ts              # 变体分组身份
    vocabulary.ts         # 标签词汇
    *.test.ts
  assets/
    archive.ts            # 变体档案纯投影
    settlement.ts         # 反馈沉降提案
    settlement.test.ts
  orchestration/
    board.ts              # 方法学习服务与 turn 生命周期
    board-ledger.ts       # 事实/记账编排
    board-write.ts        # 调用档案端口，不直接落盘
    compile.ts            # 开拍方法槽编译
    prompt-pipeline.ts    # 既有 prompt 提案后评估流程
    *.test.ts
  adapters/
    index.ts
    wiring.ts             # 可注入组合入口
    board-writer.ts       # 方法合同到共享 Board 的唯一档案适配
    method-commit.ts      # 卡/记账命令构造
    method-fielding.ts    # 上场与反馈命令、持久投影
    content/
      prompt-patch.ts      # 旧 prompt patch 提案映射
      prompt-patch.test.ts
    *.test.ts             # CLI、进程重启与反馈生命周期回归
  legacy-prompt/
    index.ts
    attribution.ts
    builder.ts
    detector.ts
    parse-episode.ts
    patch.ts
    task-family.ts
    prompt.test.ts
```

域逻辑依赖合同与端口；适配器依赖域逻辑。内部编排的 `BoardState` 只属于方法服务内存视图，不是共享 Board 持久状态的第二个所有者。

升级模块：`domain/inference*` 与 `scope-learning` 拥有条件统计和前瞻范围更新；`experience-facts/source/state` 拥有版本、证据与转换合同；`orchestration/experience-{runtime,review,effects}` 拥有情景选择、评审和中断后幂等收尾。`adapters/experience-*` 复用共享 Board、现有 provider 和中央额度，不拥有另一份存储或权限。

普通任务先由现有槽接点提示情景入口，模型通过 `method_context` 表达业务事实。稳定匹配加载精简表达作为默认起点；原文只在 expand 时展开。未显式进入情景的旧调用者保留活跃/中间方法的试用槽；这种展示和旧 helped bool 不伪造新 A，也不能把旧 stable 标签当作资格。

## 共享所有者与宿主接点

共享 `learning/control/` 保留 Board 合同、reducer、方法留存守卫及身份恢复；共享 `adapters/learning-store/` 保留真实持久 writer。方法的 `adapters/board-writer.ts` 只复用这一个写入口，不复制日志或状态。

`loop/method-*.ts` 保留执行侧接点与独立端口合同，`surface/cli/` 保留命令、数据根路径、事件和模型宿主适配；权限、通用执行、工具运行、沙箱和传输保持原有所有者。运行时根路径仍由宿主提供，方法资产继续沿用既有 `prompt/prompt_patch` 标识。

## 旧路径兼容

| 兼容旧入口（相对 src/internal/） | 当前保留调用方 | 删除条件 |
| --- | --- | --- |
| `learning/method/contracts.ts` | `surface/cli/user-learning-config.ts` | 用户学习独立任务获授权更新为本域入口，且全仓无旧路径调用 |
| `integration/method/wiring.ts` | `integration/user-learning/switch.ts` | 用户学习独立任务获授权更新为适配器入口，且全仓无旧路径调用 |

兼容文件只重新导出本目录实现，不拥有学习逻辑。保留者为方法学习目录迁移任务；清偿归后续用户学习调用方整理任务。

## 检查与证据

本轮证据在 `evidence/2026-11-04-method-learning/`：源/编译cohort、过程IR、情境采用窗口、修订/再资格、预算调度、独立数学与行为合同。真实核对先AMD HTTP400，再显式qianwen后备HTTP200但30秒超时，两个请求均无完整评审；不能宣称真实模型学习闭环或净收益验收。下文11-03的零调用记录不代表本轮。

迁移映射、原调用方及范围边界见 `docs/02-分期工程产出/P05-Experience-Learning-V0.3/evidence/2026-11-03-method-tool-relocation/`。路径扫描必须覆盖本目录真实实现及仍在执行层的接点，不能只扫描兼容壳。

上文迁移证据限定目录整理。当前升级的证据另归 `evidence/2026-11-03-method-experience/`：独立数值、有限模拟、恢复合同及正常生产入口对照分列。真实 provider 验收被自动审批拒绝，调用为零，不能据本地证据宣称整体目标完成。

旧 Board 不含 observation、methodExperienceFacts 或新额度 domain 时按缺省解码；无采用/范围历史不迁造。新的反馈来源分开，revision 替换同机会的判断；退出 epoch 使用原始上场序号，迟到正反馈不能复活旧版本。旧二进制不能解释新命令时应拒绝加载学习账；停用方法学习即可回退普通执行，保留全部原始账与证据，不删除/改写历史。
