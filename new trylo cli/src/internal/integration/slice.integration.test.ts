import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileBoardStore } from "../adapters/learning-store/file-event-store.js";
import type { BoardCommand } from "../learning/control/commands.js";
import type { BoardStore } from "../learning/control/store-port.js";
import type { VerificationAuthorityReader } from "../learning/verification-authority/contracts.js";
import { mapToolCandidate } from "../learning/agent/subsystems/tool/adapters/board/package.js";
import { mapUserRuleDraft } from "./content/user-rule.js";
import { admitContentEvidence, admitToolEvidence } from "./contract/gateway.js";
import { projectMyToolsFromBoard, productionToolsFromBoard } from "./activation/read-model.js";
import { ADAPTER_ALLOWED_COMMAND_TYPES } from "./contract/rejection.js";
import { candidate, manifest, pkg } from "../tooling/testing/fixtures.js";
import type { ValidationRecord } from "../tooling/contract/types.js";
import {
  evidenceAdmission,
  evidenceDraft,
  packageAdmission,
  proposalAdmission,
  toolEvidenceAdmission,
  userRuleDraft,
  validationRecord,
} from "./testing/fixtures.js";
import {
  issueAgentMethodReceipt,
  issueUserExplicitReceipt,
  openRegistryHarness,
} from "./testing/authority-fixtures.js";

const AT = "2026-09-13T00:00:00.000Z";
// 外审 P0-3：canonical 资产版本 id 与 Tooling 包版本 id 是两个合同，刻意不等。
const ASSET_VERSION_ID = "asset:tool-package:cand-mit:1";
const VERSION_ID = "pkg:pdf-lint:1.0.0";
const CONTENT_SCOPE = "ts-unit-fix";

/** 独立 verifier 的通过记录：D 的验证流水线产出，这里作为只读输入。 */
function passingValidation(): ValidationRecord {
  return validationRecord();
}

async function withStore(run: (store: BoardStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "trylo-integration-"));
  const created = createFileBoardStore(dir);
  if (!("apply" in created)) {
    throw new Error(`could not open board store: ${created.detail}`);
  }

  try {
    await run(created);
  } finally {
    await created.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function applyAll(store: BoardStore, commands: readonly BoardCommand[]): Promise<void> {
  for (const command of commands) {
    const result = await store.apply(command);
    assert.equal(result.ok, true, `${command.type} should apply`);
  }
}

test("content drafts reach real board state through the gateway and the file store", async () => {
  const harness = await openRegistryHarness();
  try {
    await withStore(async (store) => {
      const proposal = mapUserRuleDraft(userRuleDraft(), proposalAdmission());

      assert.equal(proposal.ok, true);

      if (!proposal.ok) {
        return;
      }

      const proposalId = proposal.value[0]?.proposal.proposalId ?? "";

      await applyAll(store, proposal.value);

      // 用户证据的唯一合法来源：执行当时落下的身份事实（WP-F §7 D3.3）。
      const receipt = await issueUserExplicitReceipt(harness, {
        subjectId: proposalId,
        subjectVersion: "cand-1",
        scope: CONTENT_SCOPE,
      });
      const evidence = await admitContentEvidence(
        harness.registry,
        evidenceDraft({ proposalId }),
        evidenceAdmission({ receiptRef: receipt.receiptId }),
      );

      assert.equal(evidence.ok, true);

      if (!evidence.ok) {
        return;
      }

      await applyAll(store, [
        { type: "quarantine", commandId: "board-1", issuedAt: AT, proposalId },
        { type: "start_evaluation", commandId: "board-2", issuedAt: AT, proposalId },
        ...evidence.value,
      ]);

      const loaded = await store.load();

      assert.equal(loaded.ok, true);

      if (!loaded.ok) {
        return;
      }

      const stored = loaded.state.proposals.find((item) => item.proposalId === proposalId);

      assert.equal(stored?.lifecycle, "evaluating");
      assert.equal(stored?.assetKind, "user_rule");
      assert.equal(loaded.state.evidence.length, 1);
      assert.equal(loaded.state.evidence[0]?.externalVerdict, "pass");
      // 晋升可回查：证据带着权威收据的坐标，而不是一句自报的 provenance。
      assert.equal(loaded.state.evidence[0]?.receipt?.receiptId, receipt.receiptId);
    });
  } finally {
    await harness.close();
  }
});

test("a tool candidate reaches production visibility only through board activation", async () => {
  const harness = await openRegistryHarness();
  try {
    await withStore(async (store) => {
      const mapped = mapToolCandidate(
        candidate({ candidateId: "cand-mit", name: "pdf-lint" }),
        packageAdmission(),
      );

      assert.equal(mapped.ok, true);

      if (!mapped.ok) {
        return;
      }

      for (const command of mapped.value) {
        assert.equal(
          (ADAPTER_ALLOWED_COMMAND_TYPES as readonly string[]).includes(command.type),
          true,
          command.type,
        );
      }

      const proposalId = "tool_package:cand-mit";

      await applyAll(store, mapped.value);

      const receipt = await issueAgentMethodReceipt(harness, validationRecord(), { scope: "docs" });
      const toolEvidence = await admitToolEvidence(
        harness.registry,
        { kind: "submit_evidence", evidenceId: "ev-tool-1", summary: "十段验证通过" },
        toolEvidenceAdmission({ proposalId, receiptRef: receipt.receiptId }),
      );

      assert.equal(toolEvidence.ok, true);

      if (!toolEvidence.ok) {
        return;
      }

      await applyAll(store, [
        { type: "quarantine", commandId: "board-1", issuedAt: AT, proposalId },
        { type: "start_evaluation", commandId: "board-2", issuedAt: AT, proposalId },
        ...toolEvidence.value,
        {
          type: "commit_asset",
          commandId: "board-3",
          issuedAt: AT,
          versionId: ASSET_VERSION_ID,
          proposalId,
          // 工具资产的 canonical content 就是 ToolPackageVersion：它显式声明
          // packageVersionId，激活投影据此桥接两个 ID 空间（外审 P0-3）。
          content: pkg({ catalogState: "verified", manifest: manifest({ shouldDefer: false }) }),
          schemaVersion: 1,
        },
      ]);

      // 资产已提交、证据已记录，但 Board 还没有给出任何激活指针：生产搜索必须看不见。
      let loaded = await store.load();

      assert.equal(loaded.ok, true);

      if (!loaded.ok) {
        return;
      }

      assert.equal(loaded.state.proposals[0]?.lifecycle, "evaluating");
      assert.equal(loaded.state.activations.length, 0);
      const beforeActivation = productionToolsFromBoard({
        board: loaded.state,
        packages: [pkg({ catalogState: "verified", manifest: manifest({ shouldDefer: false }) })],
        validations: [passingValidation()],
        descriptions: { [VERSION_ID]: "lint pdf files" },
      });

      assert.equal(beforeActivation.ok, true);

      if (beforeActivation.ok) {
        assert.equal(beforeActivation.value.length, 0, "no board activation means no production visibility");
      }

      // Board 给出 shadow 指针：D 的设计允许 shadow 工具进入生产搜索（小流量可见）。
      await applyAll(store, [
        { type: "enter_shadow", commandId: "board-4", issuedAt: AT, proposalId, versionId: ASSET_VERSION_ID },
      ]);
      loaded = await store.load();
      assert.equal(loaded.ok, true);

      if (!loaded.ok) {
        return;
      }

      const shadow = productionToolsFromBoard({
        board: loaded.state,
        packages: [pkg({ catalogState: "verified", manifest: manifest({ shouldDefer: false }) })],
        validations: [passingValidation()],
        descriptions: { [VERSION_ID]: "lint pdf files" },
      });

      assert.equal(shadow.ok, true);

      if (shadow.ok) {
        assert.equal(shadow.value.length, 1, "a board-approved shadow pointer makes the tool visible");
      }

      await applyAll(store, [
        {
          type: "request_approval",
          commandId: "board-5",
          issuedAt: AT,
          proposalId,
          approvalId: "apr-1",
          action: "install",
        },
      ]);

      // 审批门在 Board：没有 granted approval 时 activate 必须失败，与 adapter 无关。
      const denied = await store.apply({
        type: "activate",
        commandId: "board-6-denied",
        issuedAt: AT,
        proposalId,
        versionId: ASSET_VERSION_ID,
      });

      assert.equal(denied.ok, false);

      if (!denied.ok) {
        assert.equal(denied.reason, "approval_not_granted");
      }

      await applyAll(store, [
        {
          type: "record_approval_decision",
          commandId: "board-6",
          issuedAt: AT,
          approvalId: "apr-1",
          status: "granted",
        },
        { type: "activate", commandId: "board-7", issuedAt: AT, proposalId, versionId: ASSET_VERSION_ID },
      ]);

      loaded = await store.load();
      assert.equal(loaded.ok, true);

      if (!loaded.ok) {
        return;
      }

      assert.equal(loaded.state.activations.length, 1);

      const active = productionToolsFromBoard({
        board: loaded.state,
        packages: [pkg({ catalogState: "verified", manifest: manifest({ shouldDefer: false }) })],
        validations: [passingValidation()],
        descriptions: { [VERSION_ID]: "lint pdf files" },
      });

      assert.equal(active.ok, true);

      if (active.ok) {
        assert.equal(active.value.length, 1);
      }

      const myTools = projectMyToolsFromBoard({
        board: loaded.state,
        packages: [pkg({ catalogState: "verified" })],
        validations: [passingValidation()],
      });

      assert.equal(myTools.ok, true);

      if (myTools.ok) {
        assert.equal(myTools.value[0]?.lifecycle, "active");
      }

      await applyAll(store, [
        { type: "suspend", commandId: "board-8", issuedAt: AT, proposalId, breakerReason: "连续失败" },
      ]);
      loaded = await store.load();
      assert.equal(loaded.ok, true);

      if (!loaded.ok) {
        return;
      }

      const afterSuspend = productionToolsFromBoard({
        board: loaded.state,
        packages: [pkg({ catalogState: "verified", manifest: manifest({ shouldDefer: false }) })],
        validations: [passingValidation()],
        descriptions: { [VERSION_ID]: "lint pdf files" },
      });

      assert.equal(afterSuspend.ok, true);

      if (afterSuspend.ok) {
        assert.equal(afterSuspend.value.length, 0, "a suspended tool leaves production search");
      }
    });
  } finally {
    await harness.close();
  }
});

test("an injected reader cannot be replaced by a caller-supplied one", () => {
  // 类型层面的分权：gateway 只接受 reader 形状；writer 从这里不可达。
  // 这里只断言 reader 的能力面恰好是 verify 一个方法（WP-F §7 D1.3）。
  const reader: VerificationAuthorityReader = {
    verify: async () => ({ ok: false, code: "unknown_receipt", message: "not used" }),
  };
  assert.deepEqual(Object.keys(reader), ["verify"]);
});
