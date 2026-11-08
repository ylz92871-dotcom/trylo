import assert from "node:assert/strict";
import test from "node:test";
import type {
  ActivationRecord,
  LearningAssetVersion,
  LearningProposal,
} from "../../learning/control/contracts.js";
import { emptyBoardState, type BoardState } from "../../learning/control/state.js";
import { manifest, pkg } from "../../tooling/testing/fixtures.js";
import type { ValidationRecord } from "../../tooling/contract/types.js";
import { tamper, validationRecord } from "../testing/fixtures.js";
import { projectMyToolsFromBoard, productionToolsFromBoard } from "./read-model.js";
import { projectToolActivationView } from "./view.js";

const ASSET_VERSION_ID = "asset:tool-package:7";
const PACKAGE_VERSION_ID = "pkg:pdf-lint:1.0.0";

function activation(overrides: Partial<ActivationRecord> = {}): ActivationRecord {
  return {
    activationId: "act:docs:tool_package",
    scope: "docs",
    assetKind: "tool_package",
    pointer: "active",
    versionId: ASSET_VERSION_ID,
    boardSequence: 7,
    generation: 1,
    approvalRef: "apr-1",
    ...overrides,
  };
}

function proposal(overrides: Partial<LearningProposal> = {}): LearningProposal {
  return {
    proposalId: "tool_package:cand-mit",
    domain: "tool",
    scope: "docs",
    assetKind: "tool_package",
    candidateRef: "tool_package:cand-mit:abc123",
    hypothesis: "h",
    observationRefs: ["obs-1"],
    risk: "low",
    requiredVerifiers: ["tool_validation_pipeline"],
    requestedAuthorities: ["fs.read"],
    source: "inferred",
    lifecycle: "active",
    ...overrides,
  };
}

/** 外审 P0-3：canonical 资产显式声明它对应的 Tooling packageVersionId。 */
function asset(overrides: Partial<LearningAssetVersion> = {}): LearningAssetVersion {
  return {
    versionId: ASSET_VERSION_ID,
    kind: "tool_package",
    schemaVersion: 1,
    content: pkg(),
    contentHash: "hash-asset",
    source: "inferred",
    scope: "docs",
    createdAt: "2026-09-13T00:00:00.000Z",
    createdFromProposalId: "tool_package:cand-mit",
    ...overrides,
  };
}

function boardWith(records: readonly ActivationRecord[]): BoardState {
  return {
    ...emptyBoardState(),
    assets: [asset()],
    proposals: [proposal()],
    activations: [...records],
  };
}

function passingValidation(): ValidationRecord {
  return validationRecord();
}

test("only tool assets are projected, the packageVersionId comes from the canonical asset, and duplicates fail closed", () => {
  const result = projectToolActivationView({
    records: [
      activation(),
      activation({ assetKind: "user_rule", activationId: "act:docs:user_rule", versionId: "ur-1" }),
    ],
    assets: [asset()],
    proposals: [proposal()],
  });

  assert.equal(result.ok, true);

  if (result.ok) {
    assert.equal(result.value.length, 1);
    // canonical 资产版本 id ≠ tooling 包版本 id：视图里的 id 来自资产 content。
    assert.equal(result.value[0]?.packageVersionId, PACKAGE_VERSION_ID);
    assert.notEqual(result.value[0]?.packageVersionId, ASSET_VERSION_ID);
    assert.equal(result.value[0]?.state, "active");
    assert.equal(result.value[0]?.boardSequence, 7);
  }

  // 同一 (scope, assetKind) 出现两条记录 → duplicate_activation_key。
  const duplicate = projectToolActivationView({
    records: [activation(), activation({ activationId: "other", versionId: "asset:tool-package:8" })],
    assets: [asset(), asset({ versionId: "asset:tool-package:8" })],
    proposals: [proposal()],
  });

  assert.equal(duplicate.ok, false);

  if (!duplicate.ok) {
    assert.equal(duplicate.reason, "duplicate_activation_key");
  }

  // 不同 canonical 资产但声明了同一个 tooling packageVersionId → ID 冲突。
  const idConflict = projectToolActivationView({
    records: [
      activation(),
      activation({
        assetKind: "tool_binding",
        activationId: "act:docs:tool_binding",
        versionId: "asset:tool-binding:1",
      }),
    ],
    assets: [
      asset(),
      asset({
        versionId: "asset:tool-binding:1",
        kind: "tool_binding",
        createdFromProposalId: "tool_binding:b1",
        content: pkg(),
      }),
    ],
    proposals: [proposal(), proposal({ proposalId: "tool_binding:b1", assetKind: "tool_binding" })],
  });

  assert.equal(idConflict.ok, false);

  if (!idConflict.ok) {
    assert.equal(idConflict.reason, "duplicate_activation_key");
  }
});

test("a forged activation record with no canonical asset behind it fails closed (P0-3)", () => {
  const result = projectToolActivationView({
    records: [activation({ versionId: "pkg:pdf-lint:1.0.0" })],
    assets: [],
    proposals: [],
  });

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.reason, "missing_asset_link");
  }
});

test("an asset whose kind or scope disagrees with the activation fails closed", () => {
  const kindMismatch = projectToolActivationView({
    records: [activation()],
    assets: [asset({ kind: "tool_binding" })],
    proposals: [proposal()],
  });

  assert.equal(kindMismatch.ok, false);

  if (!kindMismatch.ok) {
    assert.equal(kindMismatch.reason, "invalid_activation");
  }

  const scopeMismatch = projectToolActivationView({
    records: [activation({ scope: "shell" })],
    assets: [asset()],
    proposals: [proposal()],
  });

  assert.equal(scopeMismatch.ok, false);

  if (!scopeMismatch.ok) {
    assert.equal(scopeMismatch.reason, "invalid_activation");
  }
});

test("an asset that does not trace back to a canonical proposal fails closed", () => {
  const orphan = projectToolActivationView({
    records: [activation()],
    assets: [asset({ createdFromProposalId: "tool_package:ghost" })],
    proposals: [proposal()],
  });

  assert.equal(orphan.ok, false);

  if (!orphan.ok) {
    assert.equal(orphan.reason, "missing_asset_link");
  }

  const kindDrift = projectToolActivationView({
    records: [activation()],
    assets: [asset()],
    proposals: [proposal({ assetKind: "user_rule" })],
  });

  assert.equal(kindDrift.ok, false);

  if (!kindDrift.ok) {
    assert.equal(kindDrift.reason, "invalid_activation");
  }
});

test("a tool asset whose content does not declare the tooling packageVersionId fails closed", () => {
  const result = projectToolActivationView({
    records: [activation()],
    assets: [asset({ content: { identity: "pdf-lint" } })],
    proposals: [proposal()],
  });

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.reason, "missing_package_version");
  }
});

test("a stale projection cannot overwrite newer board state", () => {
  const result = projectToolActivationView({
    records: [activation({ boardSequence: 7 })],
    assets: [asset()],
    proposals: [proposal()],
    minSequence: 7,
  });

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.reason, "stale_sequence");
  }
});

test("a projection without a version id fails closed", () => {
  const result = projectToolActivationView({
    records: [tamper(activation(), { versionId: "" })],
    assets: [asset()],
    proposals: [proposal()],
  });

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.reason, "missing_package_version");
  }
});

test("my tools shows the board lifecycle, not a catalog guess", () => {
  const board = boardWith([activation({ pointer: "suspended" })]);
  const result = projectMyToolsFromBoard({
    board,
    packages: [pkg({ catalogState: "verified" })],
    validations: [passingValidation()],
  });

  assert.equal(result.ok, true);

  if (result.ok) {
    assert.equal(result.value.length, 1);
    assert.equal(result.value[0]?.lifecycle, "suspended");
    assert.equal(result.value[0]?.scopeBinding, "docs");
  }
});

test("production search only sees verified, independently validated, active tools", () => {
  const verified = pkg({
    catalogState: "verified",
    manifest: manifest({ capabilities: ["pdf", "lint"] }),
  });
  const visible = productionToolsFromBoard({
    board: boardWith([activation()]),
    packages: [verified],
    validations: [passingValidation()],
    descriptions: { [PACKAGE_VERSION_ID]: "lint pdf files" },
  });

  assert.equal(visible.ok, true);

  if (visible.ok) {
    assert.equal(visible.value.length, 1);
    assert.equal(visible.value[0]?.name, "pdf-lint");
  }

  const suspended = productionToolsFromBoard({
    board: boardWith([activation({ pointer: "suspended" })]),
    packages: [verified],
    validations: [passingValidation()],
    descriptions: {},
  });

  assert.equal(suspended.ok, true);

  if (suspended.ok) {
    assert.equal(suspended.value.length, 0);
  }

  const unverified = productionToolsFromBoard({
    board: boardWith([activation()]),
    packages: [pkg({ catalogState: "verified" })],
    validations: [],
    descriptions: {},
  });

  assert.equal(unverified.ok, true);

  if (unverified.ok) {
    assert.equal(unverified.value.length, 0);
  }
});

test("a corrupted board projection is reported instead of silently hidden", () => {
  const board: BoardState = {
    ...boardWith([activation()]),
    assets: [
      asset(),
      asset({ versionId: "asset:tool-package:8" }),
    ],
    activations: [activation(), activation({ activationId: "other", versionId: "asset:tool-package:8" })],
  };
  const result = productionToolsFromBoard({
    board,
    packages: [],
    validations: [],
    descriptions: {},
  });

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.reason, "duplicate_activation_key");
  }
});
