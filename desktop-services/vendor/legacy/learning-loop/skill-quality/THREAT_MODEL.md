# L5 威胁模型

> L5-A 交付物。覆盖 27 §4 隐含威胁 + 31 号 §9 补充 4 类。每条带"具体缓解（代码位置或合同）"+"对应强制测试 ID"。

| 编号 | 威胁 | 严重度 | 具体缓解（代码位置或合同） | 强制测试 |
| --- | --- | --- | --- | --- |
| T-L5-1 | merge 顺序违例（先 deprecate 后 edit）→ 被吸收方内容丢失 | P0 | `lifecycle.buildMergeProposal` `ordering:'absorber-edit-first'` + pendingIds [edit, deprecate]；UI 禁用 deprecate "先 apply" | T4 / T-order |
| T-L5-2 | 信号来源不可追溯（signalSource 全 null）→ 暗箱评分 | P1 | `signals.js` 逐字段写 signalSource；缺数据 → null + source null；无模型分数 | T2 / T7 |
| T-L5-3 | destructive action 漏 snapshot（手动 stage 跳过 lifecycle） | P0 | `lifecycle.buildProposal` 对 destructive 必调 `ensureSnapshot`；无 snapshotter → SNAPSHOT_REQUIRED；失败 → SNAPSHOT_FAILED | T6 |
| T-L5-4 | 同 Skill 已有 pending 又新 stage → 覆盖用户审查 | P0 | `lifecycle._ensureNoPending` → SKILL_PENDING_BUSY 抛错，不 stage | T5 |
| T-usage-1 | usage 数据不可用 → 静默补 0（被 detector 误用为"用过 0 次"） | P0 | `curation_adapter._build_usage_report` 失败 → 整次 build_summary 抛错 fail-closed；signals 缺 usage → null + excludeFromDetector | T1 / T8 |
| T-scan-1 | scan_skill 对某 Skill 抛错 → 该 Skill 无 verdict | P1 | `_build_verdicts` 单 Skill 标 `VERDICT_MISSING`（警告），不 abort 整次 | T1 |
| T-platform-1 | 相似但平台/workspace 适用域冲突 → 误合并 | P0 | `detector.computeHardRejects` 绝对否定；冲突对不进 pairs | T3 |
| T-secret-1 | 信号/verdict 含 secret | P1 | `signals._stripSecrets` + curation_adapter verdict reason 脱敏 | 守卫 grep |

## 严重度 → 停止条件映射

- T-L5-1 / T-L5-3 / T-L5-4 任一未拦截 → 立即停手 + 报告（27 §4.6 破坏性变更必须人工审批+快照+回滚可证明）。
- T-L5-2 / T-scan-1 触发但被记录 → 纳入 P3，不停手。