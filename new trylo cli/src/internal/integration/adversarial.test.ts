import assert from "node:assert/strict";
import test from "node:test";
import type { ToolBindingDraft, ToolBoardCommandDraft } from "../tooling/contract/types.js";
import { candidate } from "../tooling/testing/fixtures.js";
import { ADAPTER_ALLOWED_COMMAND_TYPES } from "./contract/rejection.js";
import type { MappingResult } from "./contract/rejection.js";
import { mapContentDraft } from "./content/index.js";
import {
  bindingAdmission,
  jobAdmission,
  packageAdmission,
  proposalAdmission,
  promptPatchDraft,
  rollbackAdmission,
  skillDraft,
  suspendAdmission,
  tamper,
  toolEvidenceAdmission,
  userRuleDraft,
  withdrawAdmission,
  withdrawDraft,
  workflowDraft,
} from "./testing/fixtures.js";
import { mapToolCommandDraft } from "../learning/agent/subsystems/tool/adapters/board/index.js";
import type { BoardCommand } from "../learning/control/commands.js";

/**
 * 映射层对抗测试：调用方可以自由构造 draft 与 admission，映射层必须 fail closed。
 *
 * 与 `boundary.test.ts` 的分工（外审 R3 §3 P3-3 的文件长度纪律）：本文件只覆盖
 * **映射/准入语义**；「副作用为零」「常驻扫描」「Board 可追溯性门的真实强度」
 * 这类**边界**证据在 `boundary.test.ts`。权限身份与跨 store 隔离在
 * `grant-identity.test.ts`，避免单文件继续膨胀。
 */

const VERSION_ID = "pkg:pdf-lint:1.0.0";

const bindingDraft: ToolBindingDraft = {
  draftId: "bind-1",
  scope: "docs",
  taskFamily: "docs",
  packageVersionId: VERSION_ID,
  candidateId: "cand-mit",
};

function toolDrafts(): readonly ToolBoardCommandDraft[] {
  return [
    {
      kind: "submit_gap",
      gap: {
        gapId: "gap-1",
        kind: "tool_not_found",
        observationIds: ["obs-1", "obs-2"],
        capability: "pdf",
        taskFamily: "docs",
        criticality: "high",
        repeatCount: 3,
        fallbackAvailable: false,
        explanation: "连续三次找不到 pdf 表格读取能力",
      },
    },
    { kind: "submit_candidate", candidate: candidate({ candidateId: "cand-mit", name: "pdf-lint" }) },
    { kind: "submit_binding_draft", draft: bindingDraft },
    { kind: "submit_evidence", evidenceId: "ev-tool-1", summary: "十段验证通过" },
    { kind: "request_suspend", packageVersionId: VERSION_ID, reason: "连续失败" },
    { kind: "request_rollback", packageVersionId: VERSION_ID, reason: "效果回退" },
  ];
}

async function assertWhitelisted(
  result: Promise<MappingResult<readonly BoardCommand[]>>,
  label: string,
): Promise<void> {
  const resolved = await result;

  assert.equal(resolved.ok, true, `${label} should map`);

  if (!resolved.ok) {
    return;
  }

  for (const command of resolved.value) {
    assert.equal(
      (ADAPTER_ALLOWED_COMMAND_TYPES as readonly string[]).includes(command.type),
      true,
      `${label} emitted ${command.type}`,
    );
    assert.notEqual(command.type, "activate");
    assert.notEqual(command.type, "record_approval_decision");
  }
}

test("no source kind can emit activation or approval commands", async () => {
  assertWhitelisted(Promise.resolve(mapContentDraft(userRuleDraft(), proposalAdmission())), "user_rule");
  assertWhitelisted(Promise.resolve(mapContentDraft(promptPatchDraft(), proposalAdmission())), "prompt_patch");
  assertWhitelisted(Promise.resolve(mapContentDraft(skillDraft(), proposalAdmission())), "skill");
  assertWhitelisted(
    Promise.resolve(mapContentDraft(workflowDraft(), proposalAdmission({ scope: "docs" }))),
    "workflow",
  );
  assertWhitelisted(Promise.resolve(mapContentDraft(withdrawDraft(), withdrawAdmission())), "withdraw");

  const admissions = [
    jobAdmission(),
    packageAdmission(),
    bindingAdmission(),
    toolEvidenceAdmission(),
    suspendAdmission(),
    rollbackAdmission(),
  ];
  const drafts = toolDrafts();

  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index];
    const admission = admissions[index];

    assert.notEqual(admission, undefined);

    if (draft === undefined || admission === undefined) {
      continue;
    }

    // 未注入 authority port 时 submit_evidence 只能失败；其余 kind 仍必须映射。
    const mapped = await mapToolCommandDraft(draft, admission);

    if (draft.kind === "submit_evidence") {
      assert.equal(mapped.ok, false, "evidence cannot map without an authority port");
      continue;
    }

    assert.equal(mapped.ok, true, `${draft.kind} should map`);
  }
});

test("the adapter never fabricates fields the admission did not supply", async () => {
  const forgeries: readonly { readonly label: string; readonly result: MappingResult<readonly BoardCommand[]> }[] = [
    { label: "empty commandId", result: mapContentDraft(userRuleDraft(), proposalAdmission({ commandId: "" })) },
    { label: "unparseable issuedAt", result: mapContentDraft(userRuleDraft(), proposalAdmission({ issuedAt: "later" })) },
    {
      // 第二轮质量审计 F1（外审 P1-7 残留）：regex+Date.parse 曾把不存在的
      // 日期归一化到下个月；严格日历校验后必须在映射层拒绝。
      label: "impossible calendar date",
      result: mapContentDraft(userRuleDraft(), proposalAdmission({ issuedAt: "2026-02-30T00:00:00.000Z" })),
    },
    { label: "missing risk", result: mapContentDraft(userRuleDraft(), tamper(proposalAdmission(), { risk: undefined })) },
    {
      label: "missing hypothesis",
      result: mapContentDraft(userRuleDraft(), tamper(proposalAdmission(), { hypothesis: undefined })),
    },
    {
      label: "workflow without an admitted scope",
      result: mapContentDraft(workflowDraft(), proposalAdmission()),
    },
    {
      label: "candidate without admitted authorities",
      result: await mapToolCommandDraft(
        toolDrafts()[1] as ToolBoardCommandDraft,
        tamper(packageAdmission(), { requestedAuthorities: undefined }),
      ),
    },
  ];
  for (const item of forgeries) {
    assert.equal(item.result.ok, false, `${item.label} must not be mapped`);
  }
});

test("untrusted entry input never throws: unknown JSON fails closed (P1-11)", async () => {
  const admissions = [
    jobAdmission(),
    packageAdmission(),
    bindingAdmission(),
    toolEvidenceAdmission(),
    suspendAdmission(),
    rollbackAdmission(),
  ] as const;
  const garbage: readonly unknown[] = [
    null,
    undefined,
    42,
    "submit_gap",
    {},
    { kind: "exploding_kind" },
    { kind: "submit_evidence", evidenceId: 1 },
  ];

  for (const draft of garbage) {
    const content = mapContentDraft(draft, proposalAdmission());
    assert.equal(content.ok, false, `mapContentDraft(${String(draft)}) must fail closed`);
    const tool = await mapToolCommandDraft(draft, toolEvidenceAdmission());
    assert.equal(tool.ok, false, `mapToolCommandDraft(${String(draft)}) must fail closed`);
  }

  const drafts = toolDrafts();

  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index];
    const wrongAdmission = admissions[(index + 1) % admissions.length];
    if (draft === undefined || wrongAdmission === undefined) {
      throw new Error("fixture admission missing");
    }

    const result = await mapToolCommandDraft(draft, wrongAdmission);

    assert.equal(result.ok, false, `draft ${draft.kind} must refuse a mismatched admission`);
  }
});

test("a candidate cannot smuggle extra permissions past the exact-match gate (P1-2)", async () => {
  const draft: ToolBoardCommandDraft = {
    kind: "submit_candidate",
    candidate: candidate({ candidateId: "cand-mit", name: "pdf-lint" }),
  };
  const smuggled = await mapToolCommandDraft(draft, packageAdmission({
    requestedAuthorities: ["fs.read", "network.full", "shell.exec"],
  }));

  assert.equal(smuggled.ok, false);

  if (!smuggled.ok) {
    assert.equal(smuggled.reason, "authority_mismatch");
  }

  const missing = await mapToolCommandDraft(draft, packageAdmission({ requestedAuthorities: [] }));

  assert.equal(missing.ok, false);
  const exact = await mapToolCommandDraft(draft, packageAdmission({ requestedAuthorities: ["fs.read"] }));

  assert.equal(exact.ok, true);
});

test("a withdraw admission that does not match its draft is refused (P1-1)", () => {
  const draft = withdrawDraft();
  const mismatchedPayload = mapContentDraft(draft, withdrawAdmission({ payloadId: "something-else" }));

  assert.equal(mismatchedPayload.ok, false);

  if (!mismatchedPayload.ok) {
    assert.equal(mismatchedPayload.reason, "invalid_admission");
  }

  const mismatchedKind = mapContentDraft(draft, withdrawAdmission({ assetKind: "skill" }));

  assert.equal(mismatchedKind.ok, false);
  const bound = mapContentDraft(draft, withdrawAdmission());

  assert.equal(bound.ok, true);
});

test("a withdraw admission without an authoritative target resolution is refused", () => {
  // WP-F / 外审 R2 §3.3：模糊自然语言撤回不得映射到任意 entityId。
  const draft = withdrawDraft();
  const resolutions: readonly unknown[] = [undefined, "guessed", "model_recall", 42];

  for (const resolution of resolutions) {
    const result = mapContentDraft(
      draft,
      withdrawAdmission({ targetResolution: resolution as never }),
    );

    assert.equal(result.ok, false, `targetResolution ${String(resolution)} must be refused`);

    if (!result.ok) {
      assert.equal(result.reason, "unresolvable_withdraw_target");
    }
  }
});
