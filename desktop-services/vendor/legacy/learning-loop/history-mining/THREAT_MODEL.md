# L4 威胁模型

> L4-A 交付物（24 §7 表格）。覆盖 24 号 §5（5 类）+ 30 号 §9 补充（T6-T10，附严重度）。
> 目的：每条威胁给出"具体缓解（代码位置或合同）"+"对应强制测试 ID"（30 §11.1 A 验收门槛）。
> 严重度：P0=必须拦截否则停手；P1=高；P2=中。30 §9.1 映射到 24 §8 停止条件。

## 24 §5 / 30 §9 威胁清单

| ID | 威胁 | 严重度 | 具体缓解（代码位置或合同） | 强制测试 |
| --- | --- | --- | --- | --- |
| T-hist-1 | 历史 prompt injection：恶意会话内容试图指挥 miner 产出危险 Skill / 写 Memory 后门 | P0 | 1) `history_adapter.py` 只回传收窄 DTO（30 §4.1 白名单），正文不进 runner；2) miner 输入包 `UNTRUSTED REFERENCE DATA` 边界（`learning_prompt_adapter` 模板，30 §4.2）；3) runner 输出受严格 JSON 合同（白名单 + 长度上限 + 类型 + 17 §6.3 禁键）拦截，落在 `_validateRunnerOutput`（`mining-orchestrator.js:50-67`）；语义性危险指令（如"exfiltrate"等）**不**在此层拦截，依赖官方 admin 的 `security blocked` 扫描（`skill_propose` / `memory_propose` 自带）。**T3a 验证 17 §6.3 禁键路径**，T3 改名后只验证"无 pending → 无 candidate"；4) 官方安全扫描（write_approval/skill_propose 自带） | T3/T3a |
| T-hist-2 | 跨 workspace 泄漏：A 的历史进入 B 的候选 | P0 | 32 G0: 1) caller (`extension.js:handleRunHistoryMining`) 通过 `workspace.path` 传 `getWorkspaceRoot()` 权威值；2) `retrieval-planner` 透传到 `expectedScope.workspacePath`；3) `history_adapter` 用官方 `SessionDB.get_session(sid).cwd` **比对**（Windows `normcase+normpath` / POSIX `normpath`），不匹配/cwd 缺失 → fail-closed 跳过；4) DTO 增加 `workspacePath` 字段（verified cwd）供 UI/aggregator 引用；5) SessionDB 打不开 → 整次 build_results 返 `ok:false`（不可降级为放行）；6) `aggregator.js` F2 cluster key 仍按 `(patternKey, workspace_label)` 拆（`workspace_label` 是 caller 传的非验证值；32 G0 之前是唯一可见的"workspace"概念，32 G0 之后由 adapter 兜底） | T7/T14/T14a/T14b/T14c/T14d/T15 |
| T-hist-3 | provenance 伪造：候选引用不存在/已删除的 session | P1 | `provenance.validate`（sources 含 sessionId/turnId/evidenceHash）；`extension.js deleteSession` 调 `provenance.purgeSession` 删除传播（30 §6.1） | T7 |
| T-hist-4 | 预算绕过：后台模式无限模型调用 | P0 | `mining-orchestrator.js` budgetModelCalls（默认 3）硬上限，超限抛 `BudgetExhausted` → `status='failed', errorCode='BUDGET_EXHAUSTED'`，不写 pending（30 §7.1） | T9 |
| T-hist-5 | 单来源伪装多来源：同一 session 多 turn 被算作"独立来源" | P0 | `aggregator.js` 独立来源=不同 sessionId（30 §5.1）；单源仅显式命令低置信路径（singleSource 标记） | T4 |
| T6 | 模型输出超过输出 JSON schema（多余字段、错误类型、巨长字符串） | P0 | `mining-orchestrator.js` runner 输出严格校验（白名单+长度上限+类型）；`RUNNER_OUTPUT_INVALID`；含 17 §6.3 禁止字段 → 整次 run `OUTPUT_FORBIDDEN_FIELD` 终止 | T11 |
| T7 | 候选 evidenceHash 碰撞导致不同证据误并簇 | P2 | `provenance.sha256`（收窄后）+ `patternKey` sorted(toolCategories) 派生；碰撞进审计日志 `HASH_COLLISION_SUSPECTED`（30 §8） | T12 |
| T8 | 并发/重入导致两个 run 共享同一 pendingId | P0 | `mining-orchestrator.js` 单实例锁 `_running`；跨实例锁文件 `HERMES_HOME/history_mining.lock`（TTL 60s）；pre/post pending diff 唯一 pendingId（30 §7.4） | T9 + 单实例断言 |
| T9 | 用户禁用后 scheduled 触发器残留导致静默运行 | P0 | 触发器每次 tick 检查 `tryloCode.learning.historyMining.enabled`；同 runId 重复触发去重；`enabled=false` 后台 → `rejected('DISABLED')`（30 §8） | T9 |
| T10 | 历史内容含与系统提示同形 token，诱导 miner 走错 profile | P1 | 输出合同不允许 `model_choice`/`profile` 字段；UNTRUSTED REFERENCE DATA 边界（30 §4.2）；HISTORY profile 无 apply/discard/rollback/session_search | T3 |

## 严重度 → 停止条件映射（30 §9.1）

- **T-hist-1 / T6 / T8 / T9 任一未拦截** → 24 §8 停止条件 #5（injection/预算拦截失败）具体化 → **立即停手 + 报告**。
- **T-hist-2 / T-hist-3 / T7** 触发但被审计日志捕获 → 不停手（已记录），纳入 P3。
- **T10 发生** → 24 §8 停止条件 #3（profile 越权）具体化 → **立即停手**。
- **T-hist-4（预算）无法硬预算** → 24 §8 停止条件 #6 → 停手。

## 审计日志 / 副作用记录点

- `HASH_COLLISION_SUSPECTED`：30 §8 边缘表，patternKey 已去重但 evidenceHash 与既有候选相同 → 审计。（实现：orchestrator 在候选落库前比对既有 evidenceHash 集合。）
- `PROPOSAL_PENDINGID_COLLISION`：candidate.proposal.pendingId 与 L0 既有 pendingId 重叠 → fail closed、上报 24 §8。

## 强制测试 ID 索引（30 §13.2）

T0 self-test / T1 官方检索复用 / T2 DTO 最小化 / T3 恶意历史 injection / T4 稳定性门槛 / T5 双来源成候选 / T6 proposal E2E / T7 删除传播与隔离 / T8 DB 重建降级 / T9 禁用/预算/abort / T10 重启幂等 / T11 模型输出超 schema / T12 evidenceHash 碰撞。