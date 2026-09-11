# User Cognition Skill — 方法论（v0.1）

> 职责：决定 *Trylo 应该怎样认识一个 Coding Agent 用户*，并通过尽量少但尽量高价值的对话取得高质量认知 Evidence。
> 它 **不是** User Model，**不是** 固定问卷，也 **不直接** 修改长期画像。它的产物是 Evidence（Skill doc §0/§2/§17）。

## 六个职责（对应实现模块）

| 职责 | 说明 | 实现 |
| --- | --- | --- |
| Cognition Map | Trylo 该了解用户的哪些工程维度 | `cognition-skill/map.ts`（`QUESTION_BANK`） |
| Cognition Trigger | 什么时候值得发起认知对话 | `cognition.ts` `evaluateCognitionTrigger` |
| Question Selector | 当下最值得消除哪个不确定性 | `cognition-skill/question-selector.ts` `selectQuestion` |
| Question Strategy | 用什么工程场景/对照/边界问题问 | `cognition-skill/question-strategy.ts` `frameQuestion` |
| Answer Resolution | 回答说明了什么、够不够明确、是否追问 | `cognition-skill/answer-resolution.ts` `resolveAnswer` |
| Stop / Interruption | 什么时候停止、什么时候不打扰 | `cognition-skill/stop.ts` `checkStop` / `shouldStopAfterAnswer` |

目标不是"拿到最多信息"，而是**最大化每一次用户打扰带来的长期工程认知价值**。

第五模式是受约束的聊天（无工具、无写文件），不是问卷。题库只给面试官当提纲。任务中的轻量确认仍用时间线卡片，组队澄清不进入第五模式。Work 的产物选择、授权和停止必须进入 Trace。

## Cognition Map（v0.1 粒度，保持粗）

- agent_autonomy、planning_direct_execution、engineering_depth、
  maintainability_speed、verification_audit、refactor、risk_tolerance、
  cost、interaction、engineering_language（当前 P0 落地前七个问题，见 `map.ts`）。
- 粒度刻意不拆细（Skill doc §4/§25.1 允许后续扩展）。

## Question Strategy 核心（Skill doc §11）

1. **优先真实场景**：有当前真实任务就用当前工程上下文提问。
2. **冷启动才用典型场景**：没有真实上下文时用具体、可理解的典型工程场景。
3. **尽量形成 scope**：避免"你不喜欢审计吗"，用"普通功能和核心链路是否一样"。
4. **优先对照**：快速实现 vs 提前扩展、低成本 vs 更深审核、自主 vs 先问。
5. **主动找边界**："能快就快"要追问"如果加快意味着减少核心链路验证，还优先速度吗"。
6. **不诱导**：认知是取证，不是把用户训练成 Agent 想要的样子。

## Answer Resolution（Skill doc §13）

- 回答清晰 → 拆成带 scope 的 Evidence。
- 回答模糊（"看情况"）→ `reask`，若价值高才追问，否则停止。
- 回答过宽（"以后都直接做"）→ `confirm_scope`，追问边界再形成 Evidence。
- 一个回答含多个 scope（"小功能直接做，大架构先问我"）→ 拆成多条不同 scope 的 Evidence。

## Stop / Interruption（Skill doc §14/§15）

- 低频、高价值、可拒绝、可延后、不阻断。
- 冷启动：核心维度已覆盖 / 回答开始重复 / 边际收益明显下降 → 停。
- 工程中：原则上只解决当前一个高价值问题，确认后立即回工程。
- 用户拒绝不是负面 Evidence，默认继续工程任务并进入 cooldown。

## 输出（Skill doc §17）

- 对用户：`next_message`（提问 / 追问 / 确认 / 结束语）。
- 对系统：多份 `cognition_result`，进入 **Evidence Layer**（`origin.channel='cognition'`），
  再经 Conclusion → User Model。User Cognition **绝不直接改 User Model**。

## 升级与治理（Skill doc §18–§21）

- 用户变化进入 User Model，不修改 Skill 方法论。
- Skill 升级来自"哪种提问方法更容易得到稳定高价值 Evidence"。
- 升级必须走 proposal → approval → snapshot → rollback 治理，不得自我即时改写。

## 硬规则（Skill doc §24 摘要）

1. Cognition 不等于 User Model，不直接写画像。
2. 冷启动不得强制大量弹窗，允许长期被动学习。
3. 主动认知是低频高价值行为。
4. 弹窗必须可拒绝且默认不阻断工作。
5. Skill 结果必须进 Evidence Layer。
6. 工程中 Cognition 原则上只解决当前一个高价值问题。
7. Skill 个性化来自 User Model，不为每个用户改写 Skill。