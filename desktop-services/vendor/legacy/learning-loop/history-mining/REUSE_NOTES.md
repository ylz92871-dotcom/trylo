# L4 Phase 0 复用清单（交付物 0）

> 依据 24 号 §6 + 30 号 §10.2。执行模型读毕一期/官方源码后，逐项记录"复用方式 / 薄适配点 / 确需自写"。
> 结论：**无 27 §3 蓝图与上游现实的冲突**；所有复制均只读参考，未触碰一期冻结合同。

## 复用清单

| 一期/官方符号 | 复用方式 | 薄适配点 | 确需自写 |
| --- | --- | --- | --- |
| `tools.session_search_tool.session_search` | 直接调用（`history_adapter.py` → `upstream.session_search`） | 收窄为 24 §4.1 DTO + evidenceHash | — |
| `hermes_state.SessionDB` | 仅作测试播种索引（`create_session`/`append_message`），删除/重建不影响 candidate | — | — |
| `learning-loop/evidence-builder.js` `_stripSecrets` | 复制（只读）到 `history_adapter.py` 的 `_strip_secrets` | — | — |
| `learning-loop/evidence-builder.js` canonical 思路 | 参考 sort+join 规则 | 字段白名单裁剪 → `provenance.js canonicalEvidence` + `history_adapter.py _canonical_evidence`（字节一致，已交叉验证） | — |
| `memory_context_adapter.py` | 薄适配模板（`history_adapter.py` 结构平行） | — | — |
| `memory-context-client.js` | 子进程/timeout/AbortSignal/settle-once 模板（`history-mining-client.js` 结构平行） | — | — |
| `learning_prompt_adapter.py` UNTRUSTED 模板 | 复用"UNTRUSTED REFERENCE DATA"边界写法 | `extension.js buildHistoryMiningPrompt` | — |
| `learning-loop/orchestrator.js` pre/post pending diff | 复用"唯一 pendingId 捕获"模式 | `mining-orchestrator.js _stageWithDiff`→内联 pre/post | — |
| `server.py` `TRYLO_MCP_PROFILE` 机制 | 复用 profile 注册 | 新增 `_HISTORY_PROFILE`/`_HISTORY_TOOLS` | — |
| `hermes-capability-manager.js` learning 接线 | 复用 | 新增 `HISTORY_*` 常量 + `tryGetHistoryMcpConfigArg` | — |
| `extension.js` `runClaudeCodeLearningReview` | 复用 runner 结构 | 改用 `tryGetHistoryMcpConfigArg` + HISTORY 提示词 | — |
| `learning-state.js` 持久化 | 复用 load/save + 顶层 section | 新增 `historyMining` 节（`getHistoryMining`/`addHistoryRun`/`pushHistoryCandidate`） | — |
| `reviewHermesPending` / `manageSkillBackups` 审批 | 复用（candidate 走同一 pending 审批列表） | — | — |

## 与蓝图假设的冲突（27 §3）

无冲突。唯一需要澄清的实现层决策（非冲突，按 30 §5.2 解释）：
- **patternKey 依据**：30 §5.2 写 `techTags ∪ errorCodes`，但历史 DTO（24 §4.1）不含 techTags/errorCodes，只含 `toolCategories`。实现以 `toolCategories` 作为领域代理（`aggregator.derivePatternKey`），已在 THREAT_MODEL + 交付报告注明。
- **`session_search` profile 参数**：现场探针确认 `profile='default'` 会过滤掉 `trylo-vscode` 来源会话（返回 0 条）；`history_adapter.py` 因此**不**传 profile（30 §1.2 复核留证）。

## 停手上报（24 §8 触发时）

未触发任何 24 §8 停止条件。四类均未出现：
- 无需自建 SQL/FTS/tokenizer（全程官方 `session_search`）。
- 无需把对话正文交给模型（只传最小化 DTO）。
- HISTORY profile 无需 apply/discard/rollback（propose-only）。
- 未改一期 normaliser/五态/hash/snapshot 合同（`git diff` 待复核）。