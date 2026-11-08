import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyBoardState } from "../../learning/control/state.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { MethodFielding } from "../../learning/control/contracts.js";
import { boardArtifactMaterialBatch } from "./sources/artifact.js";
import { isContentDataSafe } from "./content-confidentiality.js";

const scope = "D:\\CC\\trylo", versionId = "method:canonical-fielding", at = "2026-11-05T00:00:00Z";
const fielding: MethodFielding = { exposureId: "exposure:one", versionId, proposalId: "proposal:one", turnId: "task:one",
  beat: 1, requestId: "request:one", scope, recordedAt: at };

function batch(source: MethodFielding) {
  const content = { hint: "Preserve original source ownership." };
  return boardArtifactMaterialBatch({ ...emptyBoardState(), sequence: 10,
    assets: [{ versionId, schemaVersion: 1, kind: "prompt_patch", source: "inferred", scope, createdAt: at,
      content, contentHash: contentHashOf(content) }], fieldings: [source] }, scope,
  { ref: versionId, version: versionId, domain: "prompt", subsystem: "method", issueIds: [], topicIds: [], contentFactIds: [], sourceRefs: [versionId] });
}

test("canonical same-asset fielding scope is check-only metadata while other paths and credentials remain prose", () => {
  const original = batch(fielding), before = canonicalJson(original);

  assert.equal(isContentDataSafe(original, { scope }, []), true);
  assert.equal(canonicalJson(original), before, "Privacy checks must not rewrite the real receipt or its transport identity.");
  assert.equal(isContentDataSafe(batch({ ...fielding, scope: "D:\\private-other-workspace" }), { scope }, []), false);
  assert.equal(isContentDataSafe(batch({ ...fielding, requestId: "Read D:\\private-other-workspace before sending." }), { scope }, []), false);
  assert.equal(isContentDataSafe(batch({ ...fielding, requestId: "known-fielding-credential" }), { scope }, ["known-fielding-credential"]), false);
  assert.equal(isContentDataSafe(batch({ ...fielding, beat: 0 }), { scope }, []), false);
});
