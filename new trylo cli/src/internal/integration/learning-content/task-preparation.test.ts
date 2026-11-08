import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import type { ProviderPort } from "../../ports/provider.js";
import { createNormalTaskContentRuntime } from "./task-runtime.js";
import { createStagedContentSession } from "./staged.js";

test("a preparation with no derived answer is saved, retrieved and delivered as a proposed next step", async () => {
  const root = await mkdtemp(join(tmpdir(), "trylo-content-preparation-"));
  const session = createNdjsonSessionStore({ path: join(root, "session.ndjson") });
  const at = "2026-11-04T14:20:00Z", signal = new AbortController().signal;

  try {
    assert.ok((await session.start({ sessionId: "preparation-session", createdAt: at, fingerprint: {
      schemaVersion: "1", providerId: "local-contract", model: "local-contract", toolCatalogHash: "catalog", workspaceId: "workspace:preparation" } })).ok);
    assert.ok((await session.append({ type: "transcript_item", sessionId: "preparation-session", turnId: "first", at,
      payload: { kind: "user", sequence: 0, text: "Before deriving the threshold, obtain the missing calibration source." } })).ok);
    const options = { boardRoot: join(root, "board"), scope: "repo:preparation", domain: "tool" as const,
      session, sessionId: "preparation-session", turnId: "first", enabled: () => true, now: () => Date.parse(at) };
    const stages = createStagedContentSession({ runtime: createNormalTaskContentRuntime(options), enabled: options.enabled });
    const begun = await stages.begin({ maximumPromptChars: 100000 }, signal);

    assert.equal(begun.status, "apply_known");
    if (begun.status !== "apply_known") throw new Error("begin_failed");

    const applied = await stages.applyKnown({ stageRef: begun.stageRef, inputHash: begun.request.inputHash,
      applicationJson: JSON.stringify({ schemaVersion: 1, knowledge: [], applications: [], relations: [],
        preparations: [{ description: "Retrieve the calibration source before claiming a threshold.", sourceRefs: [] }] }) }, signal);

    assert.equal(applied.status, "residual_review");
    if (applied.status !== "residual_review") throw new Error("apply_failed");

    const saved = await stages.review({ stageRef: applied.stageRef, inputHash: applied.request.inputHash,
      reviewJson: JSON.stringify({ schemaVersion: 1, assessments: [], comparisons: [], selectedRelationId: null,
        recommendation: { kind: "continue", reason: "Source preparation remains necessary; no threshold answer has been obtained.", citations: [] } }) }, signal);

    assert.equal(saved.status, "published");
    assert.ok((await session.append({ type: "transcript_item", sessionId: "preparation-session", turnId: "second", at,
      payload: { kind: "user", sequence: 0, text: "Continue the calibration investigation." } })).ok);
    const next = createNormalTaskContentRuntime({ ...options, turnId: "second" });
    const reference = await next.referenceForTask(20000, signal);

    assert.ok(reference.ok);
    assert.ok(reference.value, "Preparation-only products must reach the next task even without an answer.");
    assert.equal(reference.value.contentFactIds.length, 1);
    assert.ok(reference.value.text.includes("Retrieve the calibration source"));
    assert.ok(reference.value.text.includes("no threshold answer has been obtained"));
    let received = "";
    const provider: ProviderPort = { async *stream(request) {
      received = request.messages.map(message => message.content).join("\n");
      yield { type: "stream_start", providerId: "local-contract", model: "local-contract", warnings: [] };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    } };

    for await (const _event of next.withAutomaticReferences(provider, 20000).stream({ attemptId: "next-calibration",
      model: "local-contract", messages: [{ role: "user", content: "Continue the calibration investigation." }], tools: [] }, signal)) { /* Actual decorated send. */ }

    assert.ok(received.includes("Retrieve the calibration source"));
    const journal = await session.readRecords();
    assert.ok(journal.ok);
    assert.ok(journal.view.records.some(record => record.type === "execution_extension" && record.payload.owner === "learning-content"));
  } finally {
    await session.release();
    await rm(root, { recursive: true, force: true });
  }
});
