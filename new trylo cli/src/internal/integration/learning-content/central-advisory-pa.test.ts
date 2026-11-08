import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { createSubagentCheckpointJournal } from "../../adapters/subagent-checkpoints/journal.js";
import { createFakePermission, emptyProfileLoader } from "../../loop/fakes.js";
import { runTurn } from "../../loop/runner.js";
import type { CentralCompletedOperation, CentralDeliberationOutput, CentralDeliberationRequest,
  CentralLearningIntentDraft } from "../../learning/central/runtime/contracts.js";
import { buildCentralRuntimeRecord, emptyCentralRuntimeState, initialCentralRuntimeRef } from "../../learning/central/runtime/records.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { ProviderPort, ProviderRequest } from "../../ports/provider.js";
import type { SessionPort } from "../../ports/session.js";
import type { JsonObject } from "../../protocol/envelope.js";
import { parseEnvelope } from "../../protocol/validate.js";
import { centralLearningTools } from "../../surface/cli/central-learning-tools.js";
import { createSubagentJournalSink } from "../../surface/cli/subagent-sink.js";
import { createTurnRecorder } from "../../surface/cli/turn-recorder.js";
import { createRewardV2BoardPort } from "../reward/v2-board-port.js";
import { createCentralDeliberationReceiptsAtRoot } from "../central-learning/deliberation-receipts.js";
import { createCentralOrganizationService } from "../central-learning/organization-service.js";
import { createCentralRuntimeOrganization } from "../central-learning/runtime-organization.js";
import { createCentralRuntimeSource } from "../central-learning/runtime-source.js";
import { createRuntimeCentralAdvisoryPublisher } from "../central-learning/runtime-central-advisory-publication.js";
import { lookupCentralAdvisories, readCentralAdvisory } from "../central-learning/central-advisory-records.js";
import { createNormalTaskContentRuntime } from "./task-runtime.js";
import type { ContentTaskRecallPort } from "./sources/board-contract.js";
import { isContentDeliveryConfiguration } from "./sources/adoption-receipt.js";
import { isAdvisoryUseReport } from "./sources/advisory-contract.js";
import { findAdvisoryReadEvidence } from "./sources/advisory-read-evidence.js";
import { readSessionContent, sessionContentAddress, sessionContentRecordRef } from "./sources/session.js";

const scope = "project:central-advisory-pa", budgetId = "budget:central-advisory-pa";
const at = "2026-11-06T01:00:00.000Z", now = () => Date.parse(at);
const sourceSessionId = "business-source", consumerSessionId = "ordinary-pa";
const signal = new AbortController().signal;
const object = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

type Runtime = ReturnType<typeof createNormalTaskContentRuntime>;

type Knowledge = CentralLearningIntentDraft["knowledge"][number];

function purpose(knowledge: Knowledge, revision: string, intentId = "intent:receiver"): CentralLearningIntentDraft {
  return { intentId, subject: { plane: "central", questionRef: intentId }, goal: "Understand when receiver declarations matter",
    rationale: "Retain an original conditional comparison", conditions: [knowledge.conditions], knowledge: [knowledge],
    residual: ["Benefit on future tasks is unknown"], commitment: { purpose: "Make the original condition available for comparison",
      assumptions: [], reconsiderWhen: ["A later original changes this condition"] }, revisionReason: revision,
    sourceRefs: knowledge.sourceRefs, continuation: { kind: "ended", goalState: "open", reason: "No further research is currently selected" } };
}

/** The publication fixture follows the original applied-decision tests: an
 * immutable native receipt, its actual applied runtime checkpoint, the normal
 * organization decision, then the source-owned publisher. No publication fact
 * is manufactured by this test. Central sender access is distinct from PA access. */
function publicationFixture(boardRoot: string, sourceText: string) {
  const board = createRewardV2BoardPort(boardRoot, () => true);
  const receipts = createCentralDeliberationReceiptsAtRoot({ boardRoot, scope, budgetId, enabled: () => true });
  const organization = createCentralRuntimeOrganization({ boardRoot, scope, enabled: () => true });
  const publisher = createRuntimeCentralAdvisoryPublisher({ boardRoot, scope, enabled: () => true, access: async () => ({ ok: true }) });
  let state = emptyCentralRuntimeState(scope), stateRef = initialCentralRuntimeRef(scope), serial = 0;

  async function apply(intent: CentralLearningIntentDraft, actions: NonNullable<CentralDeliberationOutput["knowledgeHandoffs"]>) {
    const prefix = await board.read(), sourceRefs = intent.sourceRefs;
    const request: CentralDeliberationRequest = { schemaVersion: 1, scope, budgetId, boardSequence: prefix.revision,
      configuration: { schemaVersion: 1, configurationRef: "configuration:advisory-pa", authorizationRef: "authorization:advisory-pa",
        allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 100000, maxCalls: 8, maxSteps: 8, maxPromptChars: 100000 } },
      resources: { boardSequence: prefix.revision, budgetId, limits: { tokens: 100000, calls: 8, steps: 8 },
        occupied: { tokens: 0, calls: 0, steps: 0 }, available: { tokens: 100000, calls: 8, steps: 8 }, status: "available", holdReason: null },
      stateRef, state, opportunities: [], organization: [], materials: sourceRefs.map(ref => ({ ref, kind: "source" as const, text: sourceText, sourceRefs: [] })),
      operation: { kind: "think", operationId: `operation:advisory-pa:${++serial}`, purpose: "Choose an explicit public handoff",
        expectedChange: "Preserve original conditions and uncertainty", sourceRefs } };
    const output: CentralDeliberationOutput = { schemaVersion: 1, intents: [intent], sourceRefs,
      publicExplanation: "This conditional understanding is proposed for later comparison, without claiming benefit.", knowledgeHandoffs: actions };
    const delivery = await receipts.save({ request, output }, signal);
    const resultRef = `central-deliberation-result:${contentHashOf(output)}`;
    const completed: CentralCompletedOperation = { intentId: "central:agenda", operation: request.operation, outcome: "returned",
      resultRefs: [resultRef], publicResult: output.publicExplanation };

    state = { ...state, intents: output.intents, completed: [...state.completed, completed] };
    const applied = buildCentralRuntimeRecord({ previousRef: stateRef, state, reason: "central_deliberation_returned", sourceRefs,
      opportunityConsideration: { operationId: request.operation.operationId, deliveryRef: delivery.deliveryRef, resultRef, sourceRefs: [] } });
    const current = await board.read();
    assert.equal((await board.append(current.revision, applied, signal)).status, "written");
    stateRef = applied.id;
    await organization.recordDecision!({ request, output, decisionRef: request.operation.operationId, role: "deliberation", deliveryRef: delivery.deliveryRef }, signal);
    const saved = await publisher.recordDecision({ scope, appliedStateRef: applied.id }, signal);

    assert.equal(saved.status, "recorded");
    return saved;
  }

  async function loaded() {
    const result = await createBoardReader(boardRoot).load();
    assert.ok(result.ok);
    return result.state;
  }

  return { loaded, async publish(intent: CentralLearningIntentDraft) {
    const knowledge = intent.knowledge[0]!;
    const saved = await apply(intent, [{ kind: "publish", intentId: intent.intentId, knowledgeHash: contentHashOf(knowledge),
      whenRelevant: "An ordinary task compares the declared receiver", uncertainty: "Future use and benefit have not been independently validated" }]);
    assert.equal(saved.results[0]!.status, "published");
    const version = saved.results[0]!.publicationRef!, view = lookupCentralAdvisories(await loaded(), scope).find(row => row.version === version);
    assert.ok(view);
    return view;
  }, async compactEnded() {
    assert.ok(state.intents.every(intent => intent.continuation.kind === "ended"));
    state = { ...state, intents: [] };
    const compacted = buildCentralRuntimeRecord({ previousRef: stateRef, state, reason: "compact_confirmed_ended_working_set", sourceRefs: [] });
    const current = await board.read();
    assert.equal((await board.append(current.revision, compacted, signal)).status, "written");
    stateRef = compacted.id;
  }, async withdraw(intent: CentralLearningIntentDraft, publicationRef: string) {
    const saved = await apply(intent, [{ kind: "withdraw", publicationRef, why: "The original author withdraws this public handoff" }]);
    assert.equal(saved.results[0]!.status, "withdrawn");
  } };
}

async function appendUser(session: SessionPort, sessionId: string, turnId: string, text: string) {
  const appended = await session.append({ type: "transcript_item", sessionId, turnId, at, payload: { kind: "user", sequence: 0, text } });
  assert.ok(appended.ok);
  return appended.sequence;
}

/** Production tools/schema and the normal runner own tool_use/result and
 * issueEffect. This small host only delegates its advisory commands to the
 * actual normal-task runtime and its actual organization observer. */
async function runTask(session: SessionPort, runtime: Runtime, turnId: string, provider: ProviderPort, maximumChars: number) {
  const host: Parameters<typeof centralLearningTools>[0] = {
    focus: async () => ({ ok: false, reason: "not_selected_in_this_task" }), resume: async () => ({ ok: false, reason: "not_selected_in_this_task" }),
    beforeInspect: async () => {}, beforeTask: async original => runtime.withAutomaticReferences(original, maximumChars),
    afterTask: async cancellation => { await runtime.refreshAdvisoryFeedback(cancellation); }, close: async () => {},

    async command(args, cancellation, toolCallId) {
      if (args.operation === "read_advisory" && typeof args.ref === "string" && typeof args.version === "string") {
        return runtime.readAdvisory({ ref: args.ref, version: args.version, start: 0, maximumChars: 8192 }, cancellation);
      }

      if (args.operation === "report_advisory_use" && typeof args.ref === "string" && typeof args.version === "string"
        && typeof args.change === "string" && typeof args.reason === "string" && toolCallId !== undefined) {
        const report = await runtime.reportAdvisory({ toolCallId, ref: args.ref, version: args.version, change: args.change, reason: args.reason }, cancellation);
        return report.status === "recorded" ? { ...report, feedback: await runtime.refreshAdvisoryFeedback(cancellation) } : report;
      }

      throw new Error("unexpected_advisory_command");
    },
  };
  const tools = centralLearningTools(host, { independent: true }).tools;
  const definition = tools.snapshot().find(row => row.name === "central_learning");
  assert.ok(definition);
  assert.ok(canonicalJson(definition.parameters).includes("read_advisory"));
  assert.ok(canonicalJson(definition.parameters).includes("report_advisory_use"));
  const recorder = createTurnRecorder({ session, sessionId: consumerSessionId, turnId, now });
  assert.ok(recorder);
  await recorder.start({ startedAt: now(), toolCatalogHash: contentHashOf(tools.snapshot()) });
  const result = await runTurn({ provider: runtime.withAutomaticReferences(provider, maximumChars), tools, progress: recorder.progress,
    permission: createFakePermission("approved"), profile: emptyProfileLoader() }, { sessionId: consumerSessionId, turnId,
    correlationId: `correlation:${turnId}`, text: "Compare the original receiver declaration before making this task's choice.",
    model: "local-advisory-contract", budget: { maxIterations: 5 }, now });

  assert.ok(result.state.terminalReason === "completed");
  await recorder.finish({ status: result.state.terminalReason, finishReason: result.state.finishReason, usage: result.usage });

  return result;
}

test("real central publications reach ordinary PA tasks, retain frozen versions through read/report, and return only actual bounded feedback", async t => {
  const root = await mkdtemp(join(tmpdir(), "trylo-central-advisory-pa-")), boardRoot = join(root, "board");
  const business = createNdjsonSessionStore({ path: join(root, "business.ndjson") });
  const consumer = createNdjsonSessionStore({ path: join(root, "consumer.ndjson") });

  try {
    for (const [session, sessionId] of [[business, sourceSessionId], [consumer, consumerSessionId]] as const) {
      assert.ok((await session.start({ sessionId, createdAt: at, fingerprint: { schemaVersion: "1", providerId: "local-advisory-contract",
        model: "local-advisory-contract", toolCatalogHash: "catalog:advisory-pa", workspaceId: "workspace:advisory-pa" } })).ok);
    }

    const originalText = "The solved original task inspected the receiver's declared representation before editing its structured payload.";
    const sourceSequence = await appendUser(business, sourceSessionId, "business-turn", originalText);
    const sourceRef = sessionContentAddress({ sessionId: sourceSessionId, journalSequence: sourceSequence });
    const fixture = publicationFixture(boardRoot, originalText);
    const firstKnowledge = { statement: "V1 conditional receiver comparison. " + "Retain the original declared receiver and compare its actual representation. ".repeat(45),
      conditions: "The receiver explicitly declares its representation",
      // The original public alias deliberately precedes the canonical source
      // address. Access must establish its journal through native addressing
      // before resolving the opaque original; both refs still need a check.
      sourceRefs: [sessionContentRecordRef(sourceSessionId, sourceSequence), sourceRef] };
    const firstPurpose = purpose(firstKnowledge, "Retain the original public receiver comparison"), first = await fixture.publish(firstPurpose);
    const registry = async (id: string) => id === sourceSessionId ? business : id === consumerSessionId ? consumer : undefined;
    const recall: ContentTaskRecallPort = { async recall(request) {
      return request.candidates.filter(row => row.kind === "central_advisory").map(row => row.id);
    } };
    const options = { boardRoot, scope, domain: "collaboration" as const, session: consumer, sessionId: consumerSessionId,
      enabled: () => true, now, lookupSession: registry, recall };
    const exposure = createNormalTaskContentRuntime({ ...options, turnId: "exposure" });
    const exposures: ProviderRequest[] = [];
    const observer: ProviderPort = { async *stream(request) {
      exposures.push(request);
      yield { type: "stream_start", providerId: "local-advisory-contract", model: "local-advisory-contract", warnings: [] };
      yield { type: "text_start", blockId: "exposure-answer" };
      yield { type: "text_delta", blockId: "exposure-answer", text: "Compare the condition before choosing." };
      yield { type: "text_end", blockId: "exposure-answer" };
      yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
    } };

    await runTask(consumer, exposure, "exposure", observer, 20000);
    assert.equal(exposures.length, 1);
    assert.ok(exposures[0]!.messages.some(row => row.content.includes(firstKnowledge.statement)));
    let journal = await consumer.readRecords();
    assert.ok(journal.ok);
    const exposureRecord = journal.view.records.find(row => row.turnId === "exposure" && row.type === "execution_extension"
      && isContentDeliveryConfiguration(row.payload.configuration) && row.payload.configuration.advisoryRefs?.some(ref => ref.ref === first.id && ref.version === first.version));

    assert.ok(exposureRecord, "the actual first stream_start commits exact-version delivery, never adoption");
    assert.ok(!journal.view.records.some(row => isAdvisoryUseReport(row.payload.configuration)));

    // The second task gets a directory, then explicitly reads its complete
    // selected body. A real later publication must not rewrite this running task.
    const reading = createNormalTaskContentRuntime({ ...options, turnId: "reading" }), sent: ProviderRequest[] = [];
    const revisedKnowledge = { ...firstKnowledge, statement: "V2 narrower receiver comparison.", conditions: "Only receivers with an explicit schema and version declaration" };
    const revisedPurpose = purpose(revisedKnowledge, "A later original narrows the applicable receiver condition");
    let revised: Awaited<ReturnType<typeof fixture.publish>> | undefined, calls = 0;
    const reader: ProviderPort = { async *stream(request) {
      sent.push(request);
      calls += 1;
      yield { type: "stream_start", providerId: "local-advisory-contract", model: "local-advisory-contract", warnings: [] };

      if (calls === 1) {
        const context = request.messages.filter(row => row.role === "system").map(row => row.content).join("\n");
        assert.ok(context.includes(first.version));
        assert.ok(context.includes("centralAdvisoryCatalog"));
        assert.ok(!context.includes("\"centralAdvisories\""));
        revised = await fixture.publish(revisedPurpose);
        yield { type: "tool_call", toolCallId: "read:advisory-v1", name: "central_learning",
          arguments: { operation: "read_advisory", ref: first.id, version: first.version, maximumChars: 8192 } };
      } else if (calls === 2) {
        assert.ok(request.messages.some(row => row.role === "tool" && row.content.includes(firstKnowledge.statement)));
        yield { type: "tool_call", toolCallId: "report:advisory-v1", name: "central_learning", arguments: {
          operation: "report_advisory_use", ref: first.id, version: first.version,
          change: "I compared the actual receiver declaration before choosing the edit.",
          reason: "The original task declares its receiver representation; this is my choice, not a verified benefit claim." } };
      } else {
        assert.ok(request.messages.some(row => row.role === "tool" && row.content.includes("\"status\":\"recorded\"")));
        yield { type: "text_start", blockId: "read-answer" };
        yield { type: "text_delta", blockId: "read-answer", text: "The declared comparison was made; its effect remains unverified." };
        yield { type: "text_end", blockId: "read-answer" };
      }

      yield { type: "finish", reason: calls < 3 ? "tool_calls" : "stop", rawReason: calls < 3 ? "tool_calls" : "stop", requiresFollowUp: calls < 3 };
    } };
    const run = await runTask(consumer, reading, "reading", reader, 2200);
    assert.equal(calls, 3);
    assert.ok(revised);
    assert.ok(run.issuedKeys.some(key => key.includes("read:advisory-v1")));
    assert.ok(run.issuedKeys.some(key => key.includes("report:advisory-v1")));
    assert.ok(sent.every(request => !request.messages.filter(row => row.role === "system").some(row => row.content.includes(revisedKnowledge.statement))),
      "tool iterations retain the original frozen reference set after a real Board revision");
    journal = await consumer.readRecords();
    assert.ok(journal.ok);
    assert.ok(!journal.view.records.some(row => row.turnId === "reading" && row.type === "execution_extension"
      && isContentDeliveryConfiguration(row.payload.configuration) && (row.payload.configuration.advisoryRefs?.length ?? 0) > 0),
    "a catalog entry alone is not advisory exposure");
    const reportRecord = journal.view.records.find(row => row.turnId === "reading" && row.type === "execution_extension"
      && isAdvisoryUseReport(row.payload.configuration));
    assert.ok(reportRecord);
    assert.ok(isAdvisoryUseReport(reportRecord.payload.configuration));
    const report = reportRecord.payload.configuration;
    assert.equal(report.advisory.version, first.version);
    assert.ok(report.deliveryRef.startsWith("advisory-read:"));
    const readEvidence = findAdvisoryReadEvidence(journal.view.records, { sessionId: consumerSessionId, turnId: "reading",
      advisory: report.advisory, reportToolCallId: report.toolCallId });
    assert.ok(readEvidence);
    assert.equal(readEvidence.deliveryRef, report.deliveryRef);
    const results = journal.view.records.filter(row => row.turnId === "reading" && row.type === "envelope").map(row => parseEnvelope(row.payload.envelope))
      .flatMap(parsed => parsed.ok ? [parsed.envelope] : []);

    assert.ok(results.some(row => row.producerId === "loop" && row.kind === "tool_result" && row.payload.toolCallId === "read:advisory-v1"
      && row.payload.status === "succeeded" && row.payload.truncated === false));
    const laterUserSequence = await appendUser(consumer, consumerSessionId, "later-original", "A later receiver omitted its version declaration; keep this contrary original separate from any benefit claim.");
    const refreshed = await reading.refreshAdvisoryFeedback(signal);
    assert.equal(refreshed.status, "saved");
    assert.ok(refreshed.status === "saved");
    assert.ok(refreshed.intentRefs.includes(first.intentId));
    const organization = createCentralOrganizationService({ boardRoot, scope, enabled: () => true }), observed = await organization.read();
    assert.ok(observed.status === "ready");
    const adoption = observed.projection.feedback.find(row => row.value.result.kind === "adoption" && row.value.result.state === "used"
      && row.value.sourceRefs.includes(first.version));
    assert.ok(adoption);
    assert.ok(adoption.value.sourceRefs.includes(sessionContentRecordRef(consumerSessionId, reportRecord.sequence)));
    assert.ok(readEvidence.sourceRefs.every(ref => adoption.value.sourceRefs.includes(ref)));
    const outcome = observed.projection.feedback.find(row => row.value.unitRef === adoption.value.unitRef && row.value.result.kind === "outcome");

    assert.ok(outcome);
    assert.ok(outcome.value.result.kind === "outcome");
    assert.equal(outcome.value.result.state, "unknown");
    assert.equal(outcome.value.result.attribution, "unknown");
    assert.ok(outcome.value.sourceRefs.includes(sessionContentRecordRef(consumerSessionId, laterUserSequence)));
    assert.ok(outcome.value.result.summary.includes("explicit_pa_self_report_not_verified_following_or_effectiveness"));
    assert.ok(refreshed.sourceRefs.every(ref => observed.projection.feedbackHistory.some(row => row.factId === ref)));
    assert.deepEqual((await reading.refreshAdvisoryFeedback(signal)).sourceRefs, [], "re-reading the same actual journal creates no new trial");
    await fixture.compactEnded();
    const centralSource = createCentralRuntimeSource({ boardRoot, scope, ports: [], enabled: () => true, maximumSnapshotChars: 24000 });
    const reconsidered = await centralSource.snapshot(scope, signal, { subjects: [], sourceRefs: [], wakeSourceRefs: refreshed.sourceRefs });

    assert.ok(reconsidered.reconsider?.some(row => row.subject.plane === "central" && row.subject.questionRef === first.intentId
      && row.sourceRefs.some(ref => refreshed.sourceRefs.includes(ref))), "actual saved feedback addresses recall the original purpose without caller-supplied subjects");
    assert.ok(reconsidered.materials.some(row => row.text.includes(revisedKnowledge.statement)),
      "the same first source read includes the latest compacted purpose head, not its obsolete publication text");

    await appendUser(consumer, consumerSessionId, "after-revision", "Compare the newly narrowed receiver condition.");
    const current = await createNormalTaskContentRuntime({ ...options, turnId: "after-revision" }).prepare({}, signal);
    assert.ok(current.ok);
    assert.ok(current.value.advisoryCatalog?.some(row => row.version === revised!.version));
    assert.ok(!current.value.advisoryCatalog?.some(row => row.version === first.version));
    assert.equal(readCentralAdvisory(await fixture.loaded(), scope, { ref: first.id, version: first.version })?.status, "source_changed");
    await fixture.withdraw(revisedPurpose, revised.version);
    await appendUser(consumer, consumerSessionId, "after-withdrawal", "Inspect available public advisory references.");
    const withdrawn = await createNormalTaskContentRuntime({ ...options, turnId: "after-withdrawal" }).prepare({}, signal);
    assert.ok(withdrawn.ok);
    assert.equal(withdrawn.value.advisoryCatalog?.length ?? 0, 0);
    const stillFrozen = await reading.readAdvisory({ ref: first.id, version: first.version, maximumChars: 8192 }, signal);
    assert.ok(stillFrozen.ok);
    assert.ok(stillFrozen.advisoryRead.text.includes(firstKnowledge.statement));

    // Use the actual private recovery producer and journal writer. A same-
    // workspace session lookup must not turn its checkpoint bytes into a PA source.
    const privateMarker = "member-private-recovery-only";
    const sink = createSubagentJournalSink({ session: business, sessionId: sourceSessionId, turnId: "business-turn", now });
    const checkpoint = createSubagentCheckpointJournal([], sourceSessionId, async payload => {
      sink.onEvent("observation", payload, "attempt:private-recovery");
      await sink.flush();
    });

    await checkpoint.save({ version: 1, taskId: "task:private-member", agentId: "agent:private-member", round: 1, phase: "interrupted",
      nickname: "internal", instruction: privateMarker, role: "worker", roleBinding: "fixed-worker-profile", allowedTools: [], dependencies: [],
      idleTimeoutMs: 60000, budget: { tokenLimit: 1024, tokensUsed: 0, tokensRemaining: 1024, timeoutMs: 60000, timeRemainingMs: 60000,
        timeoutMode: "wall" }, cursor: 0, transcript: [], forkMessages: [] });
    assert.equal(checkpoint.read("task:private-member").kind, "ready");
    const sourceJournal = await business.readRecords();
    assert.ok(sourceJournal.ok);
    const privateRecord = sourceJournal.view.records.find(row => row.type === "envelope" && object(row.payload.envelope)
      && row.payload.envelope.kind === "observation" && object(row.payload.envelope.payload) && row.payload.envelope.payload.checkpointPart !== undefined);
    assert.ok(privateRecord);
    const privateRef = sessionContentAddress({ sessionId: sourceSessionId, journalSequence: privateRecord.sequence });
    const privateKnowledge = { statement: `The original private checkpoint retains ${privateMarker}.`, conditions: "A private member checkpoint", sourceRefs: [privateRef] };
    const privatePublication = await fixture.publish(purpose(privateKnowledge, "The source holder selects a private-origin comparison", "intent:private-recovery"));

    await appendUser(consumer, consumerSessionId, "private-check", "Compare available receiver advice without accessing another member's private recovery state.");
    const sources = await readSessionContent({ session: consumer, sessionId: consumerSessionId, turnId: "private-check", scope,
      subsystem: "collaboration", enabled: () => true, lookupSession: registry }, signal);
    assert.ok(sources.ok);
    assert.equal((await sources.value.source.readMaterial(privateRef, signal, 0, 512)).ok, false);
    const privateTask = await createNormalTaskContentRuntime({ ...options, turnId: "private-check" }).prepare({}, signal);
    assert.ok(privateTask.ok);
    assert.ok(!privateTask.value.advisoryCatalog?.some(row => row.version === privatePublication.version));
    assert.ok(!canonicalJson(privateTask.value).includes(privateMarker));
    const archive = process.env.TRYLO_ADVISORY_EVIDENCE_DIR;
    if (archive !== undefined) {
      // The verification harness can preserve the same completed real stores;
      // force:false prevents a repeated run from replacing earlier evidence.
      await cp(root, resolve(archive), { recursive: true, force: false, errorOnExist: true });
      t.diagnostic(`actual_local_stores=${resolve(archive)}`);
    }
  } finally {
    await consumer.release();
    await business.release();
    const resolved = resolve(root);
    assert.ok(resolved.startsWith(resolve(tmpdir()) + sep) && resolved.includes("trylo-central-advisory-pa-"));
    await rm(resolved, { recursive: true, force: true });
  }
});
