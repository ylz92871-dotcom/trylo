import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderPort, ProviderRequest } from "../../ports/provider.js";
import type { BoardCommand } from "../../learning/control/commands.js";
import { passEvidence } from "../../learning/control/fixtures.js";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { createAutomaticBoardContentSource } from "./sources/board.js";
import { createNormalTaskContentRuntime } from "./task-runtime.js";

test("a native active asset with canonical Windows source scope reaches the next normal task's actual provider send", async () => {
  const root = await mkdtemp(join(tmpdir(), "trylo-content-native-scope-"));
  const boardRoot = join(root, "board"), session = createNdjsonSessionStore({ path: join(root, "session.ndjson") });
  const scope = "D:\\CC\\trylo", at = "2026-11-04T20:00:00Z", signal = new AbortController().signal;
  const versionId = "native-method:source-owner-v1", proposalId = "proposal:native-source-owner";
  const statement = "Confirm the source owner before narrowing the evidence search.";

  try {
    // Synthetic pass/approval coordinates only prepare a legal persisted active asset;
    // this transport contract establishes no real checker verdict or learning benefit.
    const commands: readonly BoardCommand[] = [
      { type: "submit_proposal", commandId: "native:submit", issuedAt: at, proposal: { proposalId, domain: "prompt", scope,
        assetKind: "prompt_patch", candidateRef: versionId, hypothesis: statement, observationRefs: ["old-task:source-owner"],
        risk: "low", requiredVerifiers: [], requestedAuthorities: [], source: "inferred" } },
      { type: "quarantine", commandId: "native:quarantine", issuedAt: at, proposalId },
      { type: "start_evaluation", commandId: "native:evaluate", issuedAt: at, proposalId },
      { type: "commit_asset", commandId: "native:commit", issuedAt: at, proposalId, versionId, schemaVersion: 1,
        content: { hint: statement, appliesWhen: { tools: ["Read"] }, exceptions: ["Recheck source ownership when the requested snapshot changes."] } },
      { type: "record_evidence", commandId: "native:evidence", issuedAt: at,
        evidence: passEvidence(proposalId, { evidenceId: "evidence:native-source-owner" }) },
      { type: "enter_shadow", commandId: "native:shadow", issuedAt: at, proposalId, versionId },
      { type: "request_approval", commandId: "native:request-approval", issuedAt: at, proposalId, approvalId: "approval:native-source-owner", action: "activate" },
      { type: "record_approval_decision", commandId: "native:approve", issuedAt: at, approvalId: "approval:native-source-owner", status: "granted" },
      { type: "activate", commandId: "native:activate", issuedAt: at, proposalId, versionId },
    ];
    const written = await withBoardWriter(boardRoot, async store => {
      for (const command of commands) {
        const result = await store.apply(command);
        if (!result.ok) return result;
      }
      return store.load();
    });
    assert.ok(written.ok);
    const loaded = await createBoardReader(boardRoot).load();
    assert.ok(loaded.ok);
    assert.equal(loaded.state.activations[0]?.pointer, "active");
    assert.equal(loaded.state.assets[0]?.scope, scope);
    assert.equal(loaded.state.rewardV2Facts?.length ?? 0, 0, "This route must consume a native asset rather than a content fact.");
    const source = createAutomaticBoardContentSource({ board: createBoardReader(boardRoot), scope, domain: "prompt",
      taskPurpose: "Find original source owner evidence.", enabled: () => true });
    const recalled = await source.readTaskReferences(signal);
    assert.ok(recalled.ok);
    assert.ok(recalled.value.coverage.selectedCandidates.includes(`asset:${versionId}`));
    assert.ok(recalled.value.batch.answers[0]?.conditions[0]?.includes(JSON.stringify(scope)));
    assert.ok(recalled.value.batch.records.some(row => row.text.includes('"activations"') && row.text.includes(JSON.stringify(scope))));
    assert.ok((await session.start({ sessionId: "native-source-session", createdAt: at, fingerprint: {
      schemaVersion: "1", providerId: "local-contract", model: "local-contract", toolCatalogHash: "catalog", workspaceId: scope } })).ok);
    assert.ok((await session.append({ type: "transcript_item", sessionId: "native-source-session", turnId: "next-task", at,
      payload: { kind: "user", sequence: 0, text: "Find original source owner evidence for the current task." } })).ok);
    const runtime = createNormalTaskContentRuntime({ boardRoot, scope, domain: "prompt", session, sessionId: "native-source-session",
      turnId: "next-task", enabled: () => true, now: () => Date.parse(at) });
    const prepared = await runtime.prepare({}, signal);
    assert.ok(prepared.ok, JSON.stringify(prepared));
    assert.ok(prepared.value.packet.answers.some(answer => answer.answer.includes(statement)));
    const reference = await runtime.referenceForTask(20000, signal);
    assert.ok(reference.ok, JSON.stringify(reference));
    assert.ok(reference.value);
    assert.ok(reference.value.artifactRefs.some(ref => ref.ref === versionId && ref.version === versionId));
    let sent: ProviderRequest | undefined;
    const provider: ProviderPort = { async *stream(request) {
      sent = request;
      yield { type: "stream_start", providerId: "local-contract", model: "local-contract", warnings: [] };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    } };

    for await (const _event of runtime.withAutomaticReferences(provider, 20000).stream({ attemptId: "next-native-source",
      model: "local-contract", messages: [{ role: "user", content: "Find original source owner evidence for the current task." }], tools: [] }, signal)) { /* Actual decorated provider send. */ }

    assert.ok(sent);
    assert.ok(sent.messages.some(message => message.role === "system" && message.content.includes(statement)));
    const context = JSON.parse(sent.messages.find(message => message.role === "system")!.content.split("\n").slice(1).join("\n")) as {
      answers: readonly { conditions: readonly string[] }[];
    };
    const conditions = JSON.parse(context.answers[0]!.conditions[0]!) as { originalScope: string; activationState: string };

    assert.equal(conditions.originalScope, scope);
    assert.equal(conditions.activationState, "active");
    const journal = await session.readRecords();
    assert.ok(journal.ok);
    assert.ok(journal.view.records.some(record => record.type === "execution_extension" && record.payload.owner === "learning-content"));
  } finally {
    await session.release();
    await rm(root, { recursive: true, force: true });
  }
});
