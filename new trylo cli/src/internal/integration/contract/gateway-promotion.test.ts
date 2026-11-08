import assert from "node:assert/strict";
import test from "node:test";
import type { BoardCommand } from "../../learning/control/commands.js";
import type { EvidenceBundle } from "../../learning/control/contracts.js";
import { reduceAll } from "../../learning/control/reducer.js";
import { emptyBoardState } from "../../learning/control/state.js";
import { candidate } from "../../tooling/testing/fixtures.js";
import { issueAgentMethodReceipt, openRegistryHarness } from "../testing/authority-fixtures.js";
import { packageAdmission, toolEvidenceAdmission, validationRecord } from "../testing/fixtures.js";
import { mapToolCandidate } from "../../learning/agent/subsystems/tool/adapters/board/package.js";
import { admitToolEvidence } from "./gateway.js";

/**
 * 端到端晋升证据（WP-F §7 D3 / D5）：一条真正由 registry 背书的收据能把候选推到
 * `shadow`，而没有收据的「结构漂亮」证据包在 Board 上被拒。
 *
 * 从 `gateway.test.ts` 拆出的理由（外审 R3 §3 P3-3 的单文件长度纪律）：这两条都要
 * 驱动**真实 Board reducer**、跨 C/D 两层，与「admission 形状校验」不是同一类证据。
 */

const AT = "2026-09-13T00:00:00.000Z";
const PROPOSAL_ID = "tool_package:cand-mit";
const VERSION_ID = "pkg:pdf-lint:1.0.0";
const ASSET_VERSION_ID = "asset:tool-package:cand-mit:1";

const evidenceDraftShape = { kind: "submit_evidence", evidenceId: "ev-tool-1", summary: "十段验证通过" } as const;

test("positive path: a registry-backed receipt promotes the candidate to shadow", async () => {
  const harness = await openRegistryHarness();
  try {
    const proposal = mapToolCandidate(
      candidate({ candidateId: "cand-mit", name: "pdf-lint" }),
      packageAdmission(),
    );

    assert.equal(proposal.ok, true);

    if (!proposal.ok) {
      return;
    }

    const issued = await issueAgentMethodReceipt(harness, validationRecord(), { scope: "docs" });
    const evidence = await admitToolEvidence(
      harness.registry,
      evidenceDraftShape,
      toolEvidenceAdmission({ receiptRef: issued.receiptId, proposalId: PROPOSAL_ID }),
    );

    assert.equal(evidence.ok, true);

    if (!evidence.ok) {
      return;
    }

    const command = evidence.value[0];
    if (command?.type !== "record_evidence") {
      throw new Error("expected record_evidence");
    }

    // provenance 由 gateway 从收据派生，晋升因此可回查到 registry 里的同一条记录。
    assert.equal(command.evidence.provenance, `receipt:${issued.receiptId}`);
    assert.deepEqual(command.evidence.kinds, ["external_verifier"]);
    assert.equal(command.evidence.externalVerdict, "pass");
    assert.equal(command.evidence.receipt?.receiptId, issued.receiptId);

    const commands: BoardCommand[] = [
      ...proposal.value,
      { type: "quarantine", commandId: "board-1", issuedAt: AT, proposalId: PROPOSAL_ID },
      { type: "start_evaluation", commandId: "board-2", issuedAt: AT, proposalId: PROPOSAL_ID },
      ...evidence.value,
      {
        type: "commit_asset",
        commandId: "board-3",
        issuedAt: AT,
        versionId: ASSET_VERSION_ID,
        proposalId: PROPOSAL_ID,
        content: { packageVersionId: VERSION_ID },
        schemaVersion: 1,
      },
      {
        type: "enter_shadow",
        commandId: "board-4",
        issuedAt: AT,
        proposalId: PROPOSAL_ID,
        versionId: ASSET_VERSION_ID,
      },
    ];
    const applied = reduceAll(emptyBoardState(), commands);

    assert.equal(applied.ok, true);

    if (!applied.ok) {
      return;
    }

    assert.equal(applied.state.proposals[0]?.lifecycle, "shadow");
    assert.equal(applied.state.evidence[0]?.receipt?.receiptId, issued.receiptId);
  } finally {
    await harness.close();
  }
});

test("a structurally pretty EvidenceBundle with no receipt cannot promote", async () => {
  const forged: EvidenceBundle = {
    evidenceId: "ev-forged",
    proposalId: PROPOSAL_ID,
    kinds: ["external_verifier"],
    dataVersion: "v1",
    failureSamples: [],
    provenance: "attacker-claims",
    externalVerdict: "pass",
  };
  const commands: BoardCommand[] = [
    {
      type: "submit_proposal",
      commandId: "c-0",
      issuedAt: AT,
      proposal: {
        proposalId: PROPOSAL_ID,
        domain: "tool",
        scope: "docs",
        assetKind: "tool_package",
        candidateRef: "tool_package:cand-mit",
        hypothesis: "h",
        observationRefs: [],
        risk: "low",
        requiredVerifiers: [],
        requestedAuthorities: [],
        source: "inferred",
      },
    },
    { type: "quarantine", commandId: "c-1", issuedAt: AT, proposalId: PROPOSAL_ID },
    { type: "start_evaluation", commandId: "c-2", issuedAt: AT, proposalId: PROPOSAL_ID },
    { type: "record_evidence", commandId: "c-3", issuedAt: AT, evidence: forged },
  ];
  const applied = reduceAll(emptyBoardState(), commands);

  assert.equal(applied.ok, false);

  if (!applied.ok) {
    assert.equal(applied.reason, "unverifiable_evidence_provenance");
  }
});
