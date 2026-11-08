/**
 * 集成层测试夹具。
 *
 * 夹具一律用各域真实的 builder / inducer 构造，而不是手写字面量：
 * 「映射测试与实现同源假绿」的头号来源是夹具复制了实现里假设的形状。
 * 这里只有 fixture 自身的不变式被违反时才 throw，那不是业务分支。
 */

import type {
  ExternalVerdict,
  PromptOp,
  TaskFamily,
  VersionPins,
} from "../../learning/domains/shared/types.js";
import type { PromptAttributionRecord } from "../../learning/agent/subsystems/method/legacy-prompt/attribution.js";
import { buildPromptPatchDraft, type PromptPatchDraft } from "../../learning/agent/subsystems/method/legacy-prompt/builder.js";
import { induceSkill, type SkillDraft, type SkillEpisode } from "../../learning/domains/skill/inducer.js";
import { buildUserRule, type UserRuleDraft, type WithdrawCommandDraft } from "../../learning/domains/user/builder.js";
import { induceWorkflow, type WorkflowDraft, type WorkflowEpisode } from "../../learning/domains/workflow/inducer.js";
import type {
  EvaluationEvidenceDraft,
  EvaluationMetrics,
} from "../../evaluation/types.js";
import type {
  ContentEvidenceAdmission,
  ContentProposalAdmission,
  ToolBindingAdmission,
  ToolEvidenceAdmission,
  ToolJobAdmission,
  ToolObservationAdmission,
  ToolPackageAdmission,
  ToolRollbackAdmission,
  ToolSuspendAdmission,
  WithdrawAdmission,
} from "../contract/admission.js";
import type { ValidationRecord } from "../../tooling/contract/types.js";
import { VALIDATION_STAGE_ORDER } from "../../tooling/contract/types.js";

/**
 * 模拟运行期被篡改或来自旧版本的输入。
 *
 * adapter 的全部校验正是为了这类输入存在：类型层不可信，必须在边界上拒绝。
 * 这是测试里唯一允许绕过类型系统的地方。
 */
export function tamper<T>(value: T, patch: Record<string, unknown>): T {
  return { ...value, ...patch } as T;
}

export const FAMILY: TaskFamily = {
  id: "ts-unit-fix",
  intentClass: "fix_failing_unit_test",
  checkKind: "unit_test",
};

export const VERSIONS: VersionPins = {
  model: "m1",
  toolset: "t1",
  codeBaseline: "c1",
  workflow: "w1",
};

export function userRuleDraft(): UserRuleDraft {
  const result = buildUserRule({
    text: "以后都这样：先跑指定检查再改代码",
    taskFamilyId: FAMILY.id,
  });
  if (result.kind !== "draft") {
    throw new Error(`user rule fixture broken: ${result.kind}`);
  }

  return result.draft;
}

export function withdrawDraft(): WithdrawCommandDraft {
  const result = buildUserRule({ text: "撤回刚才那条规则" });
  if (result.kind !== "withdraw") {
    throw new Error(`withdraw fixture broken: ${result.kind}`);
  }
  return result.draft;
}

export function promptRecord(
  overrides: Partial<PromptAttributionRecord> = {},
): PromptAttributionRecord {
  const ops: readonly PromptOp[] = [
    { op: "add_constraint", constraintHash: "c-1" },
  ];
  const external: ExternalVerdict = {
    kind: "exit_code",
    result: "pass",
    ref: "run-1",
    selfGenerated: false,
  };

  return {
    baselinePromptHash: "b-1",
    candidatePatch: ops,
    taskFamily: FAMILY,
    versions: VERSIONS,
    causalObservationRefs: ["obs-1", "obs-2"],
    externalResult: external,
    expectedBenefit: "同一意图族的退出码从 fail 变 pass",
    regressionRisks: ["可能过度约束其他任务族"],
    privacy: { rawUserTextStored: false, allowedFields: ["intentClass"] },
    threshold: 2,
    proposalEligible: true,
    activationEligible: false,
    ...overrides,
  };
}

export function promptPatchDraft(
  overrides: Partial<PromptAttributionRecord> = {},
): PromptPatchDraft {
  return buildPromptPatchDraft(promptRecord(overrides));
}

export function skillDraft(): SkillDraft {
  const episode = (
    id: string,
    outcome: "success" | "failure",
    failureMode?: string,
  ): SkillEpisode => {
    const base = {
      id,
      taskFamily: FAMILY,
      trajectory: {
        nodeIds: ["repro", "patch", "verify"],
        stepCount: 3,
        hadFailureRecovery: outcome === "failure",
        hadChecks: true,
      },
      outcome,
      steps: ["reproduce failing test", "patch the production code", "re-run the same test"],
      checks: ["unit_test exit 0"],
    };

    if (failureMode === undefined) {
      return base;
    }

    return { ...base, failureMode };
  };
  const result = induceSkill([
    episode("s1", "success"),
    episode("s2", "success"),
    episode("f1", "failure", "patched tests instead of production code"),
  ]);
  if (result.kind !== "draft") {
    throw new Error(`skill fixture broken: ${result.kind}`);
  }

  return result.draft;
}

export function workflowDraft(): WorkflowDraft {
  const flow = (id: string, outcome: "success" | "failure"): WorkflowEpisode => ({
    id,
    taskFamily: FAMILY,
    trajectory: {
      nodeIds: ["repro", "patch", "verify"],
      stepCount: 3,
      hadFailureRecovery: true,
      hadChecks: true,
    },
    nodeInputs: { repro: "failing test", patch: "diff", verify: "command" },
    nodeOutputs: { repro: "stack", patch: "files", verify: "exit_code" },
    fallback: "repro",
    outcome,
  });
  const result = induceWorkflow([flow("w1", "success"), flow("w2", "failure")]);
  if (result.kind !== "draft") {
    throw new Error(`workflow fixture broken: ${result.kind}`);
  }

  return result.draft;
}

export function metrics(): EvaluationMetrics {
  return {
    successImproved: true,
    qualityDelta: 0.2,
    costDelta: 0,
    latencyDelta: -10,
    criticalRegression: false,
    failureDiversity: 0.5,
    successRate: 0.8,
  };
}

export function evidenceDraft(
  overrides: Partial<EvaluationEvidenceDraft> = {},
): EvaluationEvidenceDraft {
  return {
    proposalId: "prop-1",
    baselineRef: "base-1",
    candidateRef: "cand-1",
    replay: { baselineRef: "base-1", candidateRef: "cand-1", compared: true },
    externalAnchors: [
      { kind: "exit_code", result: "pass", ref: "run-1", selfGenerated: false },
    ],
    weakSignals: [],
    negativeCritique: [],
    metrics: metrics(),
    verdict: "recommend_shadow",
    externalPass: true,
    sampleConfidence: "sufficient",
    confidenceInterval: { n: 12, low: 0.1, high: 0.4 },
    generatorRoleId: "generator-a",
    evaluatorRoleId: "evaluator-b",
    notes: ["replayed against the same task family"],
    deterministicChecks: ["unit_test"],
    shadowRecommended: true,
    threshold: 2,
    commandKind: "submit_evidence",
    ...overrides,
  };
}

export function proposalAdmission(
  overrides: Partial<ContentProposalAdmission> = {},
): ContentProposalAdmission {
  return {
    commandId: "cmd-1",
    issuedAt: "2026-09-13T00:00:00.000Z",
    risk: "low",
    hypothesis: "把这条经验固化成资产后，同一意图族的外部结果会变好",
    requiredVerifiers: ["unit_test"],
    ...overrides,
  };
}

export function withdrawAdmission(
  overrides: Partial<WithdrawAdmission> = {},
  draft: WithdrawCommandDraft = withdrawDraft(),
): WithdrawAdmission {
  return {
    commandId: "cmd-2",
    issuedAt: "2026-09-13T00:00:00.000Z",
    entityId: "prop-1",
    entityType: "proposal",
    reason: "用户明确撤回",
    // 外审 P1-1：admission 必须与被撤回 draft 同源（payloadId/assetKind 回显）。
    payloadId: draft.command.payloadId,
    assetKind: draft.command.assetKind,
    // WP-F：目标解析依据必须显式声明，否则不可解析即拒绝。
    targetResolution: "user_explicit_entity",
    ...overrides,
  };
}

/**
 * C 侧证据 admission（WP-F 之后）：不再携带 provenance / kinds，只携带
 * 一个不透明 `receiptRef` 与主体坐标。
 */
export function evidenceAdmission(
  overrides: Partial<ContentEvidenceAdmission> = {},
): ContentEvidenceAdmission {
  return {
    commandId: "cmd-3",
    issuedAt: "2026-09-13T00:00:00.000Z",
    evidenceId: "ev-1",
    dataVersion: "evalset-2026-09-13",
    receiptRef: "receipt:test-1",
    candidateVersion: "cand-1",
    scope: CONTENT_SCOPE,
    ...overrides,
  };
}

export const CONTENT_SCOPE = "ts-unit-fix";

export const TOOL_SCOPE = "docs";

/**
 * 完整通过的十段验证记录（外审 P0-2 夹具）：D 证据的 external_verifier 只能由
 * 这样的可查验记录派生，测试不得再手写 kinds/externalVerdict。
 */
export function validationRecord(
  overrides: Partial<ValidationRecord> = {},
): ValidationRecord {
  const passing = VALIDATION_STAGE_ORDER.map((stage) => ({
    stage,
    passed: true,
    detail: "ok",
  }));
  return {
    validationId: "val-1",
    packageVersionId: "pkg:pdf-lint:1.0.0",
    stages: passing,
    verdict: "pass",
    actor: "verifier",
    ...overrides,
  };
}

export function jobAdmission(
  overrides: Partial<ToolJobAdmission> = {},
): ToolJobAdmission {
  return {
    commandId: "cmd-tool-1",
    issuedAt: "2026-09-13T00:00:00.000Z",
    jobId: "job-1",
    observationId: "obs-1",
    scope: TOOL_SCOPE,
    maxAttempts: 3,
    ...overrides,
  };
}

export function packageAdmission(
  overrides: Partial<ToolPackageAdmission> = {},
): ToolPackageAdmission {
  return {
    commandId: "cmd-tool-2",
    issuedAt: "2026-09-13T00:00:00.000Z",
    scope: TOOL_SCOPE,
    hypothesis: "这个候选能补上 pdf 表格读取能力",
    observationRefs: ["obs-1"],
    requestedAuthorities: ["fs.read"],
    ...overrides,
  };
}

export function bindingAdmission(
  overrides: Partial<ToolBindingAdmission> = {},
): ToolBindingAdmission {
  return {
    commandId: "cmd-tool-3",
    issuedAt: "2026-09-13T00:00:00.000Z",
    risk: "medium",
    hypothesis: "在 docs 任务族改用这个已验证版本",
    observationRefs: ["obs-1"],
    ...overrides,
  };
}

/** 夹具覆盖允许显式传 undefined，模拟"字段被剥掉"的旧版本输入。 */
type FixtureOverrides<T> = { [K in keyof T]?: T[K] | undefined };

/**
 * D 侧证据 admission（WP-F 之后）。
 *
 * 旧形状携带 `validationRecord` / `provenance` / `generatorId` / `verifierId`
 * 与自报 `kinds`——那些字段已被删除（外审 R2 §3.1）。现在只有一个不透明
 * `receiptRef`；`receipt:test-1` 在本仓的任何 registry 中都不存在，因此
 * 用它构成的夹具只能证明「拒绝路径」。
 */
export function toolEvidenceAdmission(
  overrides: FixtureOverrides<ToolEvidenceAdmission> = {},
): ToolEvidenceAdmission {
  return {
    commandId: "cmd-tool-4",
    issuedAt: "2026-09-13T00:00:00.000Z",
    proposalId: "tool_package:cand-mit",
    dataVersion: "validation-2026-09-13",
    receiptRef: "receipt:absent",
    scope: TOOL_SCOPE,
    packageVersionId: "pkg:pdf-lint:1.0.0",
    ...overrides,
  } as ToolEvidenceAdmission;
}

export function suspendAdmission(
  overrides: Partial<ToolSuspendAdmission> = {},
): ToolSuspendAdmission {
  return {
    commandId: "cmd-tool-5",
    issuedAt: "2026-09-13T00:00:00.000Z",
    proposalId: "tool_package:cand-mit",
    packageVersionId: "pkg:pdf-lint:1.0.0",
    ...overrides,
  };
}

export function rollbackAdmission(
  overrides: Partial<ToolRollbackAdmission> = {},
): ToolRollbackAdmission {
  return {
    commandId: "cmd-tool-6",
    issuedAt: "2026-09-13T00:00:00.000Z",
    proposalId: "tool_package:cand-mit",
    packageVersionId: "pkg:pdf-lint:1.0.0",
    requireBoardPreviousVersion: true,
    ...overrides,
  };
}

export function observationAdmission(
  overrides: Partial<ToolObservationAdmission> = {},
): ToolObservationAdmission {
  return {
    scope: TOOL_SCOPE,
    outcome: "failed",
    causalRefs: ["turn-1"],
    privacyClass: "redacted",
    ...overrides,
  };
}
