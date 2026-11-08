import type { BoardCommand, ProposalDraft } from "./commands.js";
import type { EvidenceBundle, LearningProposal } from "./contracts.js";

export const T0 = "2026-09-12T00:00:00.000Z";

let seq = 0;

export function resetIds(): void {
  seq = 0;
}

export function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

export function baseDraft(
  overrides: Partial<ProposalDraft> & Pick<ProposalDraft, "source" | "assetKind" | "scope">,
): ProposalDraft {
  return {
    proposalId: overrides.proposalId ?? nextId("p"),
    domain: overrides.domain ?? "user",
    scope: overrides.scope,
    assetKind: overrides.assetKind,
    candidateRef: overrides.candidateRef ?? "cand-1",
    hypothesis: overrides.hypothesis ?? "hypothesis",
    observationRefs: overrides.observationRefs ?? ["obs-1"],
    risk: overrides.risk ?? "low",
    requiredVerifiers: overrides.requiredVerifiers ?? [],
    requestedAuthorities: overrides.requestedAuthorities ?? [],
    source: overrides.source,
    ...(overrides.baseVersionId !== undefined
      ? { baseVersionId: overrides.baseVersionId }
      : {}),
    ...(overrides.compoundChildIds !== undefined
      ? { compoundChildIds: overrides.compoundChildIds }
      : {}),
  };
}

export function command<T extends BoardCommand["type"]>(
  type: T,
  rest: Omit<Extract<BoardCommand, { type: T }>, "type" | "commandId" | "issuedAt"> & {
    commandId?: string;
    issuedAt?: string;
  },
): Extract<BoardCommand, { type: T }> {
  return {
    type,
    commandId: rest.commandId ?? nextId("c"),
    issuedAt: rest.issuedAt ?? T0,
    ...rest,
  } as Extract<BoardCommand, { type: T }>;
}

export function userRuleDraft(
  extra: Partial<ProposalDraft> = {},
): ProposalDraft {
  return baseDraft({
    source: "user_explicit",
    assetKind: "user_rule",
    scope: extra.scope ?? "user",
    ...extra,
  });
}

export function inferredDraft(
  extra: Partial<ProposalDraft> = {},
): ProposalDraft {
  return baseDraft({
    source: "inferred",
    assetKind: extra.assetKind ?? "prompt_patch",
    scope: extra.scope ?? "project",
    ...extra,
  });
}

/**
 * Board 层的通过证据夹具。
 *
 * WP-F / 外审 R2 §3.1 之后，Board 不再接受「结构漂亮的 EvidenceBundle」：
 * 携带 external_verifier / user_feedback 权力的证据必须带权威收据坐标
 * （`receipt` + `provenance === receipt:<id>`）。这里的坐标是**合成的测试坐标**，
 * 只为让 reducer 层的状态机测试继续可跑——它不产生任何独立证据权力，
 * 真正的权威判定在 `integration/contract/gateway.ts` 读回 registry 时完成。
 */
export function passEvidence(proposalId: string, extra: Partial<EvidenceBundle> = {}): EvidenceBundle {
  const receiptId = extra.receipt?.receiptId ?? nextId("receipt-test");
  const evidence: EvidenceBundle = {
    evidenceId: extra.evidenceId ?? nextId("e"),
    proposalId,
    kinds: extra.kinds ?? ["external_verifier"],
    dataVersion: extra.dataVersion ?? "v1",
    failureSamples: extra.failureSamples ?? [],
    provenance: extra.provenance ?? `receipt:${receiptId}`,
    externalVerdict: extra.externalVerdict ?? "pass",
    receipt: extra.receipt ?? {
      receiptId,
      checksDigest: "checks:fixture",
      sourceDigest: "source:fixture",
    },
  };

  if (extra.baselineRef !== undefined) {
    return { ...evidence, baselineRef: extra.baselineRef };
  }

  return evidence;
}

export function proposalOf(
  state: { proposals: ReadonlyArray<LearningProposal> },
  proposalId: string,
): LearningProposal {
  const found = state.proposals.find((item) => item.proposalId === proposalId);
  if (found === undefined) {
    throw new Error(`proposal ${proposalId} missing`);
  }
  return found;
}
