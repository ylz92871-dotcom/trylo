import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFileBoardStore } from "./file-event-store.js";
import type { BoardCommand } from "../../learning/control/commands.js";

test("collection revoked during asynchronous load prevents the final durable append", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "trylo-routing-write-guard-"));
  let enabled = true;
  const store = createFileBoardStore(root, { commandGuard: () => enabled });

  assert.ok("apply" in store);
  const command: BoardCommand = { type: "submit_proposal", commandId: "guarded-submit", issuedAt: "2026-11-03T00:00:00Z",
    proposal: { proposalId: "guarded", domain: "routing", scope: "repo:test", assetKind: "routing_policy", candidateRef: "candidate",
      hypothesis: "guard contract", observationRefs: [], risk: "low", requiredVerifiers: [], requestedAuthorities: [], source: "inferred" } };

  try {
    const pending = store.apply(command);

    enabled = false;
    const result = await pending;

    assert.equal(result.ok, false);

    if (!result.ok) assert.equal(result.reason, "collect_disabled");

    const read = await store.load();
    assert.ok(read.ok);
    assert.equal(read.state.sequence, 0);
    assert.deepEqual(read.state.proposals, []);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
