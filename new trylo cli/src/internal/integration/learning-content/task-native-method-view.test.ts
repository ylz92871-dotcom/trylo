import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { createNormalTaskContentRuntime } from "./task-runtime.js";
import type { ProviderPort } from "../../ports/provider.js";
import { experienceSourceOf } from "../../learning/agent/subsystems/method/domain/experience-source.js";
import { snapshotOf, scopesOf } from "../../learning/agent/subsystems/method/domain/experience-state.js";

test("original native method facts in a Windows workspace reach a normal task and provider as public source views without changing their facts", async () => {
  const root = await mkdtemp(join(tmpdir(), "trylo-native-method-view-")), boardRoot = join(root, "board");
  const session = createNdjsonSessionStore({ path: join(root, "session.ndjson") });
  const scope = "D:\\CC\\trylo", versionId = "method:native-source", proposalId = "proposal:native-method";
  const at = "2026-11-04T21:00:00Z", signal = new AbortController().signal, action = "Confirm the source owner before narrowing the search.";

  try {
    const seeded = await withBoardWriter(boardRoot, async store => {
      for (const command of [
        { type: "submit_proposal" as const, commandId: "method-view:submit", issuedAt: at,
          proposal: { proposalId, scope, domain: "prompt" as const, assetKind: "prompt_patch" as const, candidateRef: versionId,
            hypothesis: "Preserve original source ownership", observationRefs: [], risk: "low" as const,
            requiredVerifiers: [], requestedAuthorities: [], source: "inferred" as const } },
        { type: "commit_asset" as const, commandId: "method-view:asset", issuedAt: at, proposalId, versionId, schemaVersion: 1,
          content: { hint: action, appliesWhen: { tools: ["Read"] } } },
      ]) {
        const result = await store.apply(command);
        if (!result.ok) return result;
      }

      let current = await store.load();
      if (!current.ok) return current;

      const registered = await store.apply({ type: "record_method_experience", commandId: "method-view:scope", issuedAt: at,
        fact: { factId: "method-scope:source", versionId, sequence: current.state.sequence + 1, kind: "scope", description: "Repository source investigation",
          hypothesis: { id: "hypothesis:native-source", versionId, scopeId: scope, proposedSequence: current.state.sequence,
            predicate: { all: [{ feature: "task", value: "source" }], exclude: [] } } } });
      if (!registered.ok) return registered;

      current = await store.load();
      if (!current.ok) return current;

      const original = experienceSourceOf(current.state), hypothesis = scopesOf(original, versionId)[0]!.hypothesis;
      const snapshot = snapshotOf(original, hypothesis);
      const reviewed = await store.apply({ type: "record_method_experience", commandId: "method-view:review", issuedAt: at,
        fact: { factId: "method-review:source", versionId, sequence: current.state.sequence + 1, kind: "review", scopeId: scope,
          snapshotId: snapshot.snapshotId, evidenceRevisions: snapshot.revisions,
          review: { decision: "defer", score: .2, reason: "Retain the source proposal for investigation; efficacy remains unverified.",
            compact: { when: "Repository source investigation", action, exceptions: "Changed ownership or snapshot" }, sources: [versionId] } } });
      if (!reviewed.ok) return reviewed;

      return store.apply({ type: "record_method_fielding", commandId: "method-view:fielding", issuedAt: at,
        exposureId: "fielding:native-source", versionId, proposalId, turnId: "old-task", beat: 1,
        requestId: "old-source-attempt", scope });
    });
    assert.ok(seeded.ok, JSON.stringify(seeded));
    const before = await createBoardReader(boardRoot).load();
    assert.ok(before.ok);
    assert.equal(before.state.activations.length, 0);
    assert.equal(before.state.methodExperienceFacts?.length, 2);
    assert.ok((await session.start({ sessionId: "native-method-session", createdAt: at, fingerprint: {
      schemaVersion: "1", providerId: "local-contract", model: "local-contract", toolCatalogHash: "catalog", workspaceId: scope } })).ok);
    assert.ok((await session.append({ type: "transcript_item", sessionId: "native-method-session", turnId: "next-task", at,
      payload: { kind: "user", sequence: 0, text: "Investigate the original source owner before narrowing the search." } })).ok);
    const runtime = createNormalTaskContentRuntime({ boardRoot, scope, domain: "prompt", session, sessionId: "native-method-session",
      turnId: "next-task", enabled: () => true, now: () => Date.parse(at) });
    const prepared = await runtime.prepare({}, signal);
    assert.ok(prepared.ok, JSON.stringify(prepared));
    assert.ok(prepared.value.coverage.references.candidates.some(row => row.kind === "native_method"));
    const native = prepared.value.packet.records.find(row => row.text.includes("native_method_source_not_active_rule_or_learning_gain"));
    assert.ok(native);
    assert.ok(native.ref.startsWith("content-source-view:"));
    assert.ok(native.text.includes("<workspace>"));
    assert.ok(!native.text.includes(scope));
    assert.ok(prepared.value.packet.materials.some(row => row.id === native.ref && row.recordRefs.includes(native.ref)));
    assert.ok(native.text.includes("fielding:native-source"));
    assert.ok(native.text.includes("method-review:source"));
    const logicalRef = prepared.value.coverage.references.candidates.find(row => row.kind === "native_method")!.id;
    const page = await runtime.readMaterial({ packet: prepared.value.packet, evidenceRef: logicalRef, start: 0, maximumChars: 8192 }, signal);

    assert.ok(page.ok);
    assert.equal(page.value.owner, "board");
    assert.equal(page.value.originalRef, native.ref);
    assert.equal(page.value.coordinate.runId, native.ref);
    assert.equal(page.value.text, native.text);
    const byView = await runtime.readMaterial({ packet: prepared.value.packet, evidenceRef: native.ref, start: 0, maximumChars: 8192 }, signal);

    assert.ok(byView.ok);
    assert.equal(byView.value.sourceHash, page.value.sourceHash);
    assert.equal(byView.value.text, native.text);
    const reference = await runtime.referenceForTask(20000, signal);
    assert.ok(reference.ok);
    assert.ok(reference.value);
    assert.ok(reference.value.text.includes(action));
    assert.ok(reference.value.text.includes("not a verified active rule"));
    let sent = "";
    const provider: ProviderPort = { async *stream(request) {
      sent = request.messages.filter(message => message.role === "system").map(message => message.content).join("\n");
      yield { type: "stream_start", providerId: "local-contract", model: "local-contract", warnings: [] };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    } };

    for await (const _event of runtime.withAutomaticReferences(provider, 20000).stream({ attemptId: "native-method-reference",
      model: "local-contract", messages: [{ role: "user", content: "Investigate the original source owner." }], tools: [] }, signal)) { /* Actual decorated send. */ }

    assert.ok(sent.includes(action));
    assert.ok(sent.includes("native_method_source_not_active_rule_or_learning_gain"));
    assert.ok(sent.includes("not a verified active rule"));
    const after = await createBoardReader(boardRoot).load();
    assert.ok(after.ok);
    assert.deepEqual(after.state.methodExperienceFacts, before.state.methodExperienceFacts);
    assert.deepEqual(after.state.fieldings, before.state.fieldings);
    assert.deepEqual(after.state.activations, []);
  } finally {
    await session.release();
    await rm(root, { recursive: true, force: true });
  }
});
