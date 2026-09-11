# L5 Phase 0 复用清单（交付物 0）

> 依据 L5_EXECUTION_TASK.md §2 + 31 号 §10.2。现场探针确认 Hermes 0.19.0 真实字段名。

## 复用清单

| 一期/官方符号 | 复用方式 | 薄适配点 | 确需自写 |
| --- | --- | --- | --- |
| `build_learning_graph` | 直接调用（curation_adapter.build_summary 包装） | 收窄为 nodes/edges/clusters/stats + usageReport + verdicts + frontmatter | — |
| `usage_report()`（无参，返回 **list**） | 直接调用 | 收窄为 `usageReport.{name}.{usedCount,lastUsedAt,...}`（snake→camel） | — |
| `scan_skill(Path, source)` | 直接调用（注意：**Path** 非 name） | 收窄为 `verdicts.{name}.{verdict,reasons}` + 脱敏 | — |
| `snapshot_skills(reason)` / `list_backups()` / `rollback` | 复用 | lifecycle.ensureSnapshot 包装 | — |
| `skill_manage`（edit/patch/delete deprecate 走 write approval） | 复用 staging | lifecycle 经 writeApproval 间接调 | — |
| `server.py` curation profile | 复用 profile 机制 | 新增 `_CURATION_PROFILE`/`_CURATION_TOOLS`（4 工具，无 memory_propose） | — |
| `skill-governance.js` 五态 transition | 复用 | lifecycle.transitionProposal 包装 | — |
| `learning-state.js` 持久化 | 复用 load/save + 顶层 section | 新增 `skillQuality` 节 | — |
| `extension.js` runHistoryMining 命令模板 | 复用 | runSkillQualityScan 同结构 | — |

## Phase 0 探针发现（写入设计）

1. **`usage_report()` 返回 list 且字段 snake_case**：`{name, use_count, view_count, patch_count, last_used_at, last_activity_at, state, provenance}`。**无** `verifiedOk/verifiedFailed/platforms/workspaces` 字段 → QualitySignal 这些字段标 null（§2.1 "缺 → null"）。
2. **`scan_skill` 要 `pathlib.Path` 不是 name**：签名 `(skill_path: Path, source='community')` → ScanResult{verdict, findings}。
3. **`platforms/workspaces` 从 SKILL.md frontmatter 读**（`applies_to_platform`/`applies_to_workspace`），curation_adapter 新增 frontmatter 输出。
4. **`snapshot_skills(reason)` 返回备份路径**；`list_backups()` 返回含 `id` 的列表。

## 与 27 §4 蓝图冲突

无重大冲突；两处实现层澄清（usage 字段映射、scan_skill Path 参数）已记录。

## 停手上报（L5 §9 触发时）

未触发任何停止条件。