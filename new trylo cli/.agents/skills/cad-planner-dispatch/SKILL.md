---
name: cad-planner-dispatch
description: CAD 机械设计任务的发包流程——何时派 cad-planner / cad-verifier 席位 subagent、如何准备 design-brief、闸门判定后如何流转。trylo Work agent（主对话）在接到机械设计/CAD 任务、建模尚未开始时使用。触发词：机械设计、CAD 任务、轴承座、建模前规划、发包。
---

# cad-planner-dispatch：发包流程（trylo Work agent 自用）

你是 trylo 的 Work agent（主对话）。机械设计任务到达时，**设计决策不归你**——你的职责是准备输入、派 `cad-planner` 席位、转达闸门结果、派 `cad-verifier` 席位审包，然后按 FROZEN 施工包自己按图施工（配合 `cad-executor` skill）。本 skill 说的就是你这个角色。

## 第一步：准备设计意图输入

若任务尚无 design-brief，在 `.trylo/out/cad-plans/<YYYY-MM-DD>-<任务名>/design-brief.md` 落一份：

- 任务陈述（用户原话要点，逐条编号）；
- 目标件功能与工况；
- 历史事故复盘（若有，作为硬约束，如"禁止球门柱式无根颊板"）；
- 明确排除项（Non-goals）；
- **DECISION-REQUIRED 清单**：用户未定的参数。决策权在 planner——它必须按标准/计算选定并冻结全部数值，而不是把问题退回用户；仅真正的用户偏好分叉才标注"需用户裁决"。

用户已给 brief 则核实无空缺即可，不改写原话。

## 第二步：派 cad-planner 席位

用 Agent 工具以 `subagent_type: "cad-planner"` 派发（work 面内建席位）。prompt 需自包含：任务目标、design-brief 绝对路径、模板路径（`docs/architecture/core-design/TRYLO-CAD-PLANNER-HANDOFF-TEMPLATE-V0.1.md`）、manifest 路径（`desktop-services/src/tooling/manifests/solidworks-mcp.mjs`）、施工包产出路径。

planner 返回 FROZEN → 进入第三步；返回 NOT-READY → 向用户转述缺项清单与所需决策，**不建模**。

## 第三步：派 cad-verifier 席位（package-review 模式）

用 `subagent_type: "cad-verifier"` 派发审包，输入：施工包路径 + 模板路径 + manifest 路径。

- 审包 PASS → 向用户报告"可以开工"，用户确认后按 `cad-executor` skill 施工；
- 审包 FAIL → 把 blocking 清单回派给 `cad-planner` 修复，循环直至 PASS（修复只动判定单点名条目）。

## 第四步：施工后验收（acceptance 模式）

你按图施工并产出 `evidence/evidence-report.md` 后，再派 `cad-verifier`（acceptance 模式）：

- ACCEPTED → 向用户报告交付；
- REJECTED → 按判定分流：设计错误回 `cad-planner` 改包重发；施工错误按弃件流程重来。

## 你自己永远不要做的事

- 不要替 planner 填任何模板章节、不要替 verifier 写判定；
- 不要在施工包缺失或未 FROZEN 时开始建模；
- 不要把"设计成熟度"问题包装成执行问题上报。
