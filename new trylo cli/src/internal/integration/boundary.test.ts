import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { BoardCommand } from "../learning/control/commands.js";
import type { EvidenceBundle } from "../learning/control/contracts.js";
import { reduceAll } from "../learning/control/reducer.js";
import { emptyBoardState } from "../learning/control/state.js";
import { createRecordingBoardPort } from "../learning/agent/subsystems/tool/domain/board-adapter.js";
import { submitBindingDraft } from "../learning/agent/subsystems/tool/domain/curator.js";
import { buildPackageVersion } from "../learning/agent/subsystems/tool/assets/builder/design.js";
import { executeContribution } from "../learning/agent/subsystems/tool/assets/contribution/bundle.js";
import { acquireToQuarantine } from "../learning/agent/subsystems/tool/adapters/quarantine/acquire.js";
import { createSideEffectGuard } from "../tooling/side-effects.js";
import { archive, design, manifest, provenance } from "../tooling/testing/fixtures.js";
import { validationRecord } from "./testing/fixtures.js";
import type { ToolBindingDraft } from "../tooling/contract/types.js";

/**
 * 边界证据：**信任边界实际落在哪一层**、未接线时副作用是否真为零、
 * 以及 Board 可追溯性门**做不到什么**。
 *
 * 与 `adversarial.test.ts` 的分工（外审 R3 §3 P3-3 的文件长度纪律）：那边管映射/准入
 * 语义，这边管边界与副作用。两者都从 `adversarial.test.ts` 拆出来，没有减少任何断言。
 */

const VERSION_ID = "pkg:pdf-lint:1.0.0";
const NOW = "2026-09-12T00:00:00Z";
const PROPOSAL_ID = "tool_package:cand-mit";
const ASSET_VERSION_ID = "asset:tool-package:cand-mit:1";
const AT = "2026-09-13T00:00:00.000Z";

const bindingDraft: ToolBindingDraft = {
  draftId: "bind-1",
  scope: "docs",
  taskFamily: "docs",
  packageVersionId: VERSION_ID,
  candidateId: "cand-mit",
};

test("no production module keeps a module-level ledger, issuer, or reset hook", () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const srcRoot = path.join(here, "..", "..", "..", "src", "internal");
  const selfSource = path.basename(fileURLToPath(import.meta.url)).replace(/\.js$/, ".ts");
  const forbidden = ["resetApprovalReplayLog", "issueApprovalToken", "defaultLedger", "consumeApprovalToken", "ApprovalConsumptionToken"];
  const pending = [srcRoot];
  const hits: string[] = [];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);

      if (entry.isDirectory()) {
        pending.push(full);
        continue;
      }

      if (!entry.name.endsWith(".ts")) {
        continue;
      }

      if (entry.name === selfSource) {
        continue;
      }

      const text = readFileSync(full, "utf8");

      for (const marker of forbidden) {
        if (text.includes(marker)) {
          hits.push(`${path.relative(srcRoot, full)}: ${marker}`);
        }
      }
    }
  }

  assert.deepEqual(hits, []);
});

test("without an injected port none of the four protected call sites performs an effect", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-noport-"));
  try {
    const quarantineRoot = path.join(root, "quarantine");
    const acquired = await acquireToQuarantine({
      token: { grantId: "grant:unused" },
      now: NOW,
      candidateId: "cand-mit",
      packageVersionId: VERSION_ID,
      scope: "docs",
      quarantineRoot,
      archive: archive(),
      compressedBytes: 32,
      manifest: manifest(),
      provenance: provenance(),
    });

    assert.equal(acquired.ok, false);

    if (!acquired.ok) {
      assert.equal(acquired.code, "no_port");
    }

    assert.equal(existsSync(quarantineRoot), false, "acquire must not create the quarantine root");

    const built = await buildPackageVersion({
      token: { grantId: "grant:unused" },
      now: NOW,
      candidateId: "cand-mit",
      packageVersionId: "pkg:pdf-lint:9.9.9",
      scope: "docs",
      design: design(),
      origin: "self_created",
      noSuitableCandidate: true,
      narrowGap: false,
      taskLocal: false,
      manifest: manifest({ version: "9.9.9", origin: "self_created" }),
      provenance: provenance(),
      contentHash: "hash-9",
    });

    assert.equal(built.ok, false);

    if (!built.ok) {
      assert.equal(built.code, "no_port");
    }

    const board = createRecordingBoardPort();
    const bound = await submitBindingDraft(
      board,
      bindingDraft,
      validationRecord(),
      { token: { grantId: "grant:unused" }, now: NOW },
    );

    assert.equal(bound.ok, false);

    if (!bound.ok) {
      assert.equal(bound.code, "no_port");
    }

    assert.deepEqual(board.snapshot(), []);

    const guard = createSideEffectGuard();
    const contributed = await executeContribution(
      undefined,
      { grantId: "grant:unused" },
      NOW,
      "cand-mit",
      VERSION_ID,
      "docs",
      "push",
      guard,
    );

    assert.equal(contributed.ok, false);

    if (!contributed.ok) {
      assert.equal(contributed.code, "no_port");
    }

    // 外审 P1-10：未授权的调用不得在 guard 上留下任何尝试记录。
    assert.deepEqual(guard.attempts(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Board 证据门的**真实强度**（外审 R3 §3 P2-2 的钉住用例）。
 *
 * 这条用例断言的不是「安全性」，而是**已知威胁模型边界**：`enter_shadow` 的证据门
 * 只做**可追溯性**检查（坐标存在 + `provenance === receipt:<receiptId>`）。Board 是
 * 纯函数、不持有 receipt registry，因此**无法**鉴别坐标真伪。结论是：
 *
 *   - 保证在 **admission 层**（gateway 读回 registry 并核对绑定）；
 *   - **不是** Board 层的保证。绕过 gateway、直接把自洽但从未签发的收据坐标喂给
 *     canonical `record_evidence`，仍可把提案送进 `shadow`。
 *
 * 因此本用例**必须继续断言 `REACHED shadow`**。把这条终态改成「已关闭」有两种做法，
 * 都是错的：(a) 改断言（那是删除证据），(b) 给 Board 注入 registry 端口（那会把
 * 纯函数 Board 变成有 IO 的第二判定者，属架构决定而非本包可顺手扩的合同）。
 * 该边界登记在 `HANDOFF-MANIFEST.md` §OPEN 的 P2-2 行。
 */
test("the board's evidence gate is traceability only: forged receipt coordinates still reach shadow", () => {
  const neverIssued = "receipt:never-issued";
  const forged: EvidenceBundle = {
    evidenceId: "ev-forged-coordinates",
    proposalId: PROPOSAL_ID,
    kinds: ["external_verifier"],
    dataVersion: "v1",
    failureSamples: [],
    // 攻击者自洽地伪造了「看起来像真的」收据坐标：形状完全正确，registry 里没有。
    provenance: `receipt:${neverIssued}`,
    externalVerdict: "pass",
    receipt: { receiptId: neverIssued, checksDigest: "checks:fake", sourceDigest: "source:fake" },
  };
  const commands: BoardCommand[] = [
    {
      type: "submit_proposal",
      commandId: "b-0",
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
    { type: "quarantine", commandId: "b-1", issuedAt: AT, proposalId: PROPOSAL_ID },
    { type: "start_evaluation", commandId: "b-2", issuedAt: AT, proposalId: PROPOSAL_ID },
    { type: "record_evidence", commandId: "b-3", issuedAt: AT, evidence: forged },
    {
      type: "commit_asset",
      commandId: "b-4",
      issuedAt: AT,
      versionId: ASSET_VERSION_ID,
      proposalId: PROPOSAL_ID,
      content: { packageVersionId: VERSION_ID },
      schemaVersion: 1,
    },
    {
      type: "enter_shadow",
      commandId: "b-5",
      issuedAt: AT,
      proposalId: PROPOSAL_ID,
      versionId: ASSET_VERSION_ID,
    },
  ];
  const applied = reduceAll(emptyBoardState(), commands);

  assert.equal(applied.ok, true, "the board accepts the forged coordinates by design");

  if (!applied.ok) {
    return;
  }

  assert.equal(
    applied.state.proposals[0]?.lifecycle,
    "shadow",
    "REACHED shadow: this is the documented boundary (OPEN P2-2), not a closed gap",
  );
  // 与 gateway 正向路径的差别只在 provenance 的权威性；Board 侧看到的形状两者相同。
  assert.equal(applied.state.evidence[0]?.provenance, `receipt:${neverIssued}`);
});
