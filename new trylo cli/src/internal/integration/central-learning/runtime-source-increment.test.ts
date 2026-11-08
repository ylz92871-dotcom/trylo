import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { emptyBoardState, type BoardState } from "../../learning/control/state.js";
import type { BoardCommand } from "../../learning/control/commands.js";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import type { CentralLearningIntentDraft, CentralRuntimeSourcePort } from "../../learning/central/runtime/contracts.js";
import { createCentralRuntimeSource } from "./runtime-source.js";
import { methodResearchRecord } from "../../learning/agent/subsystems/method/adapters/central-research-records.js";
import { buildCentralRuntimeRecord, emptyCentralRuntimeState, initialCentralRuntimeRef } from "../../learning/central/runtime/records.js";
import { reduce } from "../../learning/control/reducer.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { projectCollaborationCentralFeedback } from "../../learning/agent/subsystems/collaboration/runtime/index.js";
import type { TaskSourcePage } from "../learning-content/task-source-pages.js";
import { centralMaterialFromPage } from "./deliberation-material.js";
import { evolution } from "../../learning/agent/subsystems/tool/index.js";
import { centralResearchRequestRef } from "./research-intake-common.js";
import { projectOrganizationNativeFeedbackChanges } from "./organization-feedback-changes.js";
import { projectOrganizationDomainFeedback } from "./organization-feedback-sources.js";
import { experienceOwnerFingerprint } from "../../learning/agent/subsystems/collaboration/experience/policy.js";
import { createCentralRuntimeStore } from "./runtime-store.js";
import { readCentralOpenPurposeBindings } from "./runtime-purpose-memory.js";
import { nativeChangeReadRef } from "./runtime-source-changes.js";

const scope = "workspace:source-increment", signal = new AbortController().signal;

type Query = NonNullable<Parameters<CentralRuntimeSourcePort["snapshot"]>[2]>;

const subject = { plane: "central", questionRef: "question:original" } as const;
const query: Query = { subjects: [subject], sourceRefs: [], purposes: [
  { subject, sourceRefs: ["source:original-session", "derivation:public-result"] },
] };

async function withNativeSourceBoard(run: (fixture: { readonly boardRoot: string;
  readonly apply: (command: BoardCommand) => Promise<BoardState>; readonly load: () => Promise<BoardState> }) => Promise<void>) {
  const boardRoot = await mkdtemp(join(tmpdir(), "central-source-native-"));
  const load = async () => {
    const loaded = await createBoardReader(boardRoot).load();
    assert.ok(loaded.ok);
    return loaded.state;
  };
  const apply = async (command: BoardCommand) => {
    const result = await withBoardWriter(boardRoot, store => store.apply(command));
    assert.ok(result.ok, JSON.stringify(result));
    return result.state;
  };

  try { await run({ boardRoot, apply, load }); }
  finally {
    assert.equal(dirname(resolve(boardRoot)), resolve(tmpdir()));
    assert.ok(boardRoot.includes("central-source-native-"));
    await rm(boardRoot, { recursive: true, force: true });
  }
}

test("source increment forwards purpose associations and advances only consumed original peer notices", async () => {
  let sequence = 1, seen: Query | undefined;
  const notices = ["turn-notice:first", "turn-notice:second", "turn-notice:third"];
  const peer: CentralRuntimeSourcePort = {
    async snapshot(_scope, _signal, input) {
      seen = input;
      const remaining = notices.filter(ref => !input?.sourceRefs.includes(ref));
      const ref = remaining[0];

      return { boardSequence: sequence, opportunities: [],
        materials: ref === undefined ? [] : [{ ref, kind: "source", text: `Actual original notice ${ref}`, sourceRefs: [ref] }],
        sourceRefs: ref === undefined ? [] : [ref], hasMore: remaining.length > 1,
        reconsider: ref === undefined ? [] : [{ subject, sourceRefs: [ref], reason: "New human input in the original linked session" }] };
    },

    async read() { throw new Error("Snapshot does not read original journal bodies here"); },
  };
  const source = createCentralRuntimeSource({ scope, boardRoot: "unused", enabled: () => true, ports: [],
    board: { async load() { return { ok: true, state: { ...emptyBoardState(), sequence }, generation: 1 }; } }, peerSources: [peer] });
  const first = await source.snapshot(scope, signal, query);

  assert.deepEqual(seen, query);
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.sourceRefs, [notices[0]]);
  assert.deepEqual(first.reconsider?.[0]?.subject, subject);
  sequence = 500;
  assert.deepEqual((await source.snapshot(scope, signal, query)).sourceRefs, first.sourceRefs);
  const nextQuery = { ...query, sourceRefs: [...first.sourceRefs] };
  const second = await source.snapshot(scope, signal, nextQuery);

  assert.equal(second.hasMore, true);
  assert.deepEqual(second.sourceRefs, [notices[1]]);
  const third = await source.snapshot(scope, signal, { ...query, sourceRefs: [...first.sourceRefs, ...second.sourceRefs] });

  assert.equal(third.hasMore, false);
  assert.deepEqual(third.sourceRefs, [notices[2]]);
  const exhausted = await source.snapshot(scope, signal, { ...query, sourceRefs: notices });

  assert.equal(exhausted.hasMore, false);
  assert.deepEqual(exhausted.sourceRefs, []);
});

test("source increment keeps capacity-omitted notices pending until their actual material is exposed", async () => {
  const notices = ["opaque-notice:one", "opaque-notice:two"];
  const peer: CentralRuntimeSourcePort = {
    async snapshot(_scope, _signal, input) {
      const remaining = notices.filter(ref => !input?.sourceRefs.includes(ref));
      return { boardSequence: 1, opportunities: [], materials: remaining.map(ref => ({ ref, kind: "source", text: ref.repeat(85), sourceRefs: [ref] })),
        sourceRefs: remaining, hasMore: false,
        reconsider: remaining.map(ref => ({ subject, sourceRefs: [ref], reason: "Actual original notice" })) };
    }, async read() { return []; },
  };
  const source = createCentralRuntimeSource({ scope, boardRoot: "unused", enabled: () => true, ports: [], maximumSnapshotChars: 2048,
    board: { async load() { return { ok: true, state: emptyBoardState(), generation: 1 }; } }, peerSources: [peer] });
  const first = await source.snapshot(scope, signal, query);

  assert.deepEqual(first.sourceRefs, [notices[0]]);
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.reconsider?.map(item => item.sourceRefs[0]), [notices[0]]);
  const second = await source.snapshot(scope, signal, { ...query, sourceRefs: first.sourceRefs });

  assert.deepEqual(second.sourceRefs, [notices[1]]);
  assert.equal(second.hasMore, false);
});

test("source increment reads exact native method findings and candidates with their original conditions and privacy boundary", async () => {
  const intent: CentralLearningIntentDraft = { intentId: "intent:method-reading", subject: { plane: "central", questionRef: "intent:method-reading" },
    goal: "Understand a reusable prerequisite", rationale: "Original business source supports comparison", conditions: ["Declared schema"],
    knowledge: [], residual: ["Transfer to implicit schemas"], commitment: { purpose: "Compare the prerequisite", assumptions: [], reconsiderWhen: [] },
    revisionReason: "Initial research", sourceRefs: ["source:business"], continuation: { kind: "ready", operation: {
      kind: "think", operationId: "operation:method-reading", purpose: "Compare source conditions", expectedChange: "Bounded finding", sourceRefs: ["source:business"] } } };
  const request = methodResearchRecord(scope, { type: "method_research_request", schemaVersion: 1, requestRef: "request:method-reading",
    intentRef: intent.intentId, intent, sourceRefs: ["source:business"],
    materials: [{ ref: "source:business", kind: "source", text: "A schema was inspected before editing", sourceRefs: [] }] });
  const finding = methodResearchRecord(scope, { type: "method_research_step", schemaVersion: 1, requestRef: "request:method-reading",
    previousRef: request.id, reservationId: "reservation:one", contextRef: "context:original",
    finding: { kind: "finding", statement: "Schema inspection depends on an actual declaration", conditions: "Explicit schema declaration",
      sourceRefs: ["source:business"], residual: ["Implicit-schema transfer remains unknown"] } });
  const candidate = methodResearchRecord(scope, { type: "method_research_step", schemaVersion: 1, requestRef: "request:method-reading",
    previousRef: finding.id, reservationId: "reservation:two", contextRef: "context:second",
    finding: { kind: "candidate", statement: "Inspect the declared schema before structured editing", conditions: "Declared JSON schema",
      sourceRefs: ["source:business"], residual: ["Implicit-schema transfer remains unknown"], candidate: {
        hint: "Inspect the declared schema before editing", scope: { description: "Declared JSON schemas",
          predicate: { all: [{ feature: "format", value: "json" }], exclude: [] } } } } });
  const state = { ...emptyBoardState(), sequence: 3,
    rewardV2Facts: [{ ...request, sequence: 1 }, { ...finding, sequence: 2 }, { ...candidate, sequence: 3 }] };
  const source = createCentralRuntimeSource({ scope, boardRoot: "unused", enabled: () => true, ports: [],
    board: { async load() { return { ok: true, state, generation: 1 }; } } });

  assert.ok(!(await source.snapshot(scope, signal)).materials.some(material => material.text.includes("Declared JSON schema")));
  const materials = await source.read(scope, [finding.id, candidate.id], 12000, signal);

  assert.deepEqual(materials.map(material => material.kind), ["work_result", "work_result"]);
  const readFinding = JSON.parse(materials[0]!.text), readCandidate = JSON.parse(materials[1]!.text);

  assert.equal(readFinding.value.finding.conditions, "Explicit schema declaration");
  assert.equal(readCandidate.value.finding.candidate.scope.predicate.all[0].value, "json");
  assert.ok(readCandidate.interpretation.includes("not_independent_evidence_or_adopted_method"));
  assert.ok(materials[1]!.sourceRefs.includes("source:business"));
  const privateReader = createCentralRuntimeSource({ scope, boardRoot: "unused", enabled: () => true, ports: [],
    secrets: ["Implicit-schema transfer remains unknown"], board: { async load() { return { ok: true, state, generation: 1 }; } } });

  await assert.rejects(privateReader.read(scope, [candidate.id], 12000, signal), /central_runtime_source_sensitive/);
});

test("source increment returns the exact archived delivered material before an owning live peer", async () => {
  const delivered = { ref: "central-source-page:original-hash", kind: "source" as const,
    text: '{"role":"original_source_fragment","text":"Original actually delivered text"}', sourceRefs: ["session:original", "notice:actual"] };
  const first = buildCentralRuntimeRecord({ previousRef: initialCentralRuntimeRef(scope),
    state: { ...emptyCentralRuntimeState(scope), materials: [delivered] }, reason: "Trusted delivered public request material",
    sourceRefs: ["delivery:original"] });
  let liveReads = 0, claims = 0;
  const peer = { async owns() {
    claims += 1;
    return true;
  },

    async snapshot() { return { boardSequence: 1, opportunities: [], materials: [], sourceRefs: [] }; },

    async read() {
      liveReads += 1;
      throw new Error("Live peer cannot reconstruct an old content hash");
    } };
  const source = createCentralRuntimeSource({ scope, boardRoot: "unused", enabled: () => true, ports: [], peerSources: [peer],
    board: { async load() { return { ok: true, state: { ...emptyBoardState(), sequence: 1, rewardV2Facts: [{ ...first, sequence: 1 }] }, generation: 1 }; } } });

  assert.deepEqual(await source.read(scope, [delivered.ref], 4096, signal), [delivered]);
  assert.equal(liveReads, 0);
  assert.equal(claims, 0);
});

test("source increment supplies purpose navigation as context from original memory and reads its exact body", async () => {
  const ended: CentralLearningIntentDraft = { intentId: "intent:open-archived", subject,
    goal: "Learn when declared schemas are prerequisites", rationale: "Keep the original learning purpose", conditions: ["Declared schemas"],
    knowledge: [], residual: ["Unresolved premise"], commitment: { purpose: "Resolve the premise", assumptions: [], reconsiderWhen: ["Related original source arrives"] },
    revisionReason: "Current expenditure ended", sourceRefs: ["source:original-business"], continuation: { kind: "ended", goalState: "open", reason: "Original source missing" } };
  const first = buildCentralRuntimeRecord({ previousRef: initialCentralRuntimeRef(scope), state: { ...emptyCentralRuntimeState(scope), intents: [ended] },
    reason: "Original open learning purpose", sourceRefs: ["source:original-business"] });
  const compact = buildCentralRuntimeRecord({ previousRef: first.id, state: emptyCentralRuntimeState(scope),
    reason: "Archive terminal expenditure", sourceRefs: [first.id] });
  const peer: CentralRuntimeSourcePort = { async snapshot() { return { boardSequence: 2, opportunities: [], sourceRefs: ["notice:business-later"], materials: [
    { ref: "source:business-later", kind: "source", text: "A related declared-schema task was completed", sourceRefs: ["source:original-business", "notice:business-later"] },
  ] }; }, async read() { return []; } };
  const source = createCentralRuntimeSource({ scope, boardRoot: "unused", enabled: () => true, ports: [], peerSources: [peer],
    board: { async load() { return { ok: true, state: { ...emptyBoardState(), sequence: 2, rewardV2Facts: [
      { ...first, sequence: 1 }, { ...compact, sequence: 2 },
    ] }, generation: 1 }; } } });
  const snapshot = await source.snapshot(scope, signal, { subjects: [], sourceRefs: [], purposes: [] });
  const navigation = snapshot.materials.find(material => material.ref.startsWith("central-runtime-purpose-navigation:"));
  assert.ok(navigation);
  const row = JSON.parse(navigation.text).entries[0] as { intentId: string; readRef: string; goalState: string };

  assert.equal(row.intentId, ended.intentId);
  assert.equal(row.goalState, "open");
  assert.deepEqual(snapshot.sourceRefs, ["notice:business-later"]);
  const body = await source.read(scope, [row.readRef], 12000, signal);

  assert.equal(JSON.parse(body[0]!.text).value.goal, ended.goal);
  assert.equal(JSON.parse(body[0]!.text).value.continuation.goalState, "open");
});

test("source increment keeps its original native handoff quiet and routes later native feedback to the same central purpose", async () => withNativeSourceBoard(async ({ boardRoot, apply, load }) => {
  const at = "2026-11-05T00:00:00.000Z", issueId = "issue:self-request", requestRef = "request:self-request";
  let state = await apply({ type: "coordinate_learning", commandId: "command:research-report", issuedAt: at,
    action: { kind: "report", scope, issueId, problemKey: "research:handoff-boundary", report: {
      reportId: "report:self-request", source: { kind: "research_request", domain: "collaboration", requestRef, intentRef: subject.questionRef },
      facts: ["A requested computation, not an observed business failure"], evidenceRefs: [requestRef, "source:business"] } } });
  const options = { scope, boardRoot, enabled: () => true, ports: [], domainFeedback: async (board: BoardState, selectedIssue: string) =>
    projectOrganizationDomainFeedback(board, { scope, workspaceId: scope, issueId: selectedIssue,
      nativeChanges: projectOrganizationNativeFeedbackChanges(board, { scope, workspaceId: scope }) }) };
  let source = createCentralRuntimeSource(options);
  const handoffQuery: Query = { subjects: [subject], sourceRefs: [], purposes: [{ subject, sourceRefs: ["source:business"] }] };
  const header = projectCollaborationCentralFeedback(state, { scope, issueId });
  assert.ok(header);
  assert.equal(header.records.length, 1);
  assert.deepEqual(header.sourceRefs, []);
  const quiet = await source.snapshot(scope, signal, handoffQuery);

  assert.deepEqual(quiet.opportunities, []);
  assert.deepEqual(quiet.sourceRefs, []);
  assert.deepEqual(quiet.reconsider, []);
  assert.equal(quiet.hasMore, false);
  assert.ok(quiet.materials.some(row => row.text.includes("known_learning_handoff_not_new_business")));
  state = await apply({ type: "submit_proposal", commandId: "command:unrelated-proposal", issuedAt: at, proposal: {
    proposalId: "proposal:unrelated", domain: "tool", scope, assetKind: "tool_package", candidateRef: "candidate:unrelated",
    hypothesis: "Unrelated metadata", observationRefs: [], risk: "low", requiredVerifiers: [], requestedAuthorities: [], source: "inferred" } });
  assert.deepEqual((await source.snapshot(scope, signal, handoffQuery)).sourceRefs, []);

  const originalPurpose: CentralLearningIntentDraft = { intentId: subject.questionRef, subject,
    goal: "Keep the original handoff premise open until ordinary use is observed", rationale: "A computation is not business adoption",
    conditions: ["Original consumer boundary"], knowledge: [], residual: ["Independent behavioral benefit remains unknown"],
    commitment: { purpose: "Observe the original consumer", assumptions: [], reconsiderWhen: ["Actual owner feedback arrives"] },
    revisionReason: "End this expenditure while retaining the unresolved question", sourceRefs: ["source:business"],
    continuation: { kind: "ended", goalState: "open", reason: "Await original owner evidence" } };
  const runtime = createCentralRuntimeStore(options);
  const save = async (snapshot: ReturnType<typeof emptyCentralRuntimeState>, reason: string) => {
    const head = await runtime.read(scope), saved = await runtime.append({ previousRef: head.stateRef, state: snapshot,
      expectedRevision: head.revision, reason, sourceRefs: [] });
    assert.equal(saved.status, "written");
    state = await load();
  };
  const unrelated = Array.from({ length: 34 }, (_, index): CentralLearningIntentDraft => ({ ...originalPurpose,
    intentId: `question:unrelated:${index}`, subject: { plane: "central", questionRef: `question:unrelated:${index}` },
    goal: `Unrelated old font question ${index}`, sourceRefs: [`source:unrelated:${index}`] }));

  await save({ ...emptyCentralRuntimeState(scope), intents: [originalPurpose, ...unrelated] }, "Stop expenditure, retain original open purposes");
  await save(emptyCentralRuntimeState(scope), "Archive ended purposes in original runtime facts");
  assert.ok(!readCentralOpenPurposeBindings({ facts: state.rewardV2Facts ?? [], scope, boardSequence: state.sequence }, 0, 32)
    .entries.some(row => row.intentId === subject.questionRef), "the original purpose is beyond the first metadata page");
  source = createCentralRuntimeSource({ ...options,
    nativeFeedbackChanges: board => projectOrganizationNativeFeedbackChanges(board, { scope, workspaceId: scope }) });
  const noActive: Query = { subjects: [], sourceRefs: [], purposes: [] };
  const archivedQuiet = await source.snapshot(scope, signal, noActive);

  assert.deepEqual(archivedQuiet.opportunities, []);
  assert.deepEqual(archivedQuiet.sourceRefs, []);
  assert.deepEqual(archivedQuiet.reconsider, []);
  assert.equal(archivedQuiet.hasMore, false);

  state = await apply({ type: "coordinate_learning", commandId: "command:focus-original", issuedAt: at, action: {
    kind: "decide", issueId, expectedRevision: 1, decision: "focused_learning", reason: "Original bounded research handoff", sourceRefs: ["report:self-request"] } });
  state = await apply({ type: "coordinate_learning", commandId: "command:fund-original", issuedAt: at, action: {
    kind: "fund", issueId, expectedRevision: 2, grantId: "grant:original", domain: "collaboration",
    allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 5000, maxCalls: 1, maxSteps: 1, maxPromptChars: 4000 } } });
  const jobId = state.learningIssues!.find(row => row.issueId === issueId)!.jobId!;
  const owner = { kind: "personal_agent", experienceKey: "owner:original" } as const;
  const content = { schema: "collaboration-experience/v1", status: "trial", issueId, focusRevision: 2,
    familyId: "handoff-boundary", owner, situation: "A later ordinary task has an artifact dependency",
    responsibilities: ["Keep the actual artifact reference"], practice: "Read the original artifact before handing it off",
    sourceRefs: ["report:self-request"], conditions: {} };

  await apply({ type: "submit_proposal", commandId: "command:experience-proposal", issuedAt: at, proposal: {
    proposalId: "proposal:experience", domain: "collaboration", scope, assetKind: "workflow", candidateRef: "experience:original",
    hypothesis: "Original owner-bound trial", observationRefs: ["report:self-request"], risk: "low",
    requiredVerifiers: [], requestedAuthorities: [], source: "inferred" } });
  state = await apply({ type: "commit_asset", commandId: "command:experience-commit", issuedAt: at,
    proposalId: "proposal:experience", versionId: "experience:original", schemaVersion: 1, content });
  assert.deepEqual((await source.snapshot(scope, signal, noActive)).sourceRefs, [], "publishing research is not native post-use feedback");
  await apply({ type: "record_collaboration_runtime", commandId: "collaboration-runtime:dispatch:later-use", issuedAt: at,
    receipt: { schemaVersion: 1, receiptId: "dispatch:later-use", phase: "dispatched", scope, owner,
      ownerFingerprint: experienceOwnerFingerprint(owner), versionIds: ["experience:original"], recordedAt: at,
      boundary: { executionId: "execution:ordinary", taskId: "task:ordinary", round: 1, role: "personal_agent",
        requestId: "request:ordinary", configurationRef: "configuration:ordinary" } } });
  state = await apply({ type: "record_collaboration_runtime", commandId: "collaboration-runtime:feedback:later-use", issuedAt: at,
    receipt: { schemaVersion: 1, receiptId: "feedback:later-use", phase: "use_feedback", scope, owner,
      versionIds: ["experience:original"], usageReceiptId: "dispatch:later-use", outcome: "uncertain",
      summary: "The ordinary consumer saw this guidance; behavioral benefit is still unknown",
      sourceRefs: ["business:later-consumer"], recordedAt: at } });
  const actual = projectCollaborationCentralFeedback(state, { scope, issueId });
  assert.ok(actual);
  assert.ok(actual.records.some(row => row.kind === "collaboration_use_feedback"));
  state = await apply({ type: "coordinate_learning", commandId: "command:real-feedback-report", issuedAt: at,
    action: { kind: "report", scope, issueId, problemKey: "research:handoff-boundary", report: {
      reportId: "report:real-feedback", source: { teamRunId: "team:actual-consumer", taskId: "task:actual-consumer", memberId: "personal_agent" },
      facts: ["The original consumer receipt is uncertain"], evidenceRefs: ["feedback:later-use"] } } });
  const later = await source.snapshot(scope, signal, noActive);

  assert.deepEqual(later.opportunities, []);
  assert.deepEqual(new Set(later.sourceRefs), new Set(["dispatch:later-use", "feedback:later-use"]));
  assert.ok(later.reconsider?.length);
  assert.ok(later.reconsider.every(row => canonicalJson(row.subject) === canonicalJson(subject)));
  const originalBody = later.materials.find(row => row.ref.startsWith("central-runtime-purpose-record:"));
  assert.ok(originalBody);
  assert.deepEqual(JSON.parse(originalBody.text).value, originalPurpose);
  const feedbackMaterial = later.materials.find(row => row.ref.startsWith("central-runtime-domain-catalog:"));
  assert.ok(feedbackMaterial);
  const feedbackCatalog = JSON.parse(feedbackMaterial.text), bodyReadRef = feedbackCatalog.readRef as string;

  assert.notEqual(feedbackMaterial.ref, bodyReadRef);
  assert.ok(bodyReadRef.startsWith("central-runtime-domain-body:"));
  const legacyRef = bodyReadRef.replace("central-runtime-domain-body:", "central-runtime-domain:");
  const legacyBadCatalog = { ref: legacyRef, kind: "feedback" as const,
    text: canonicalJson({ ...feedbackCatalog, readRef: legacyRef }), sourceRefs: [feedbackCatalog.sourceRef as string, issueId] };

  await save({ ...emptyCentralRuntimeState(scope), materials: [...later.materials, legacyBadCatalog],
    consumedSourceRefs: [...new Set([...later.sourceRefs, ...later.materials.flatMap(material => [material.ref, ...material.sourceRefs])])] },
    "Original delivered host materials, including the historical bad catalog identity");
  assert.deepEqual(await source.read(scope, [legacyRef], 12000, signal), [legacyBadCatalog]);
  assert.ok((await source.read(scope, [bodyReadRef], 12000, signal))[0]!.text.includes("collaboration_use_feedback"));
  const nativeCatalog = later.materials.find(row => row.ref.startsWith("central-runtime-native-catalog:"));
  assert.ok(nativeCatalog);
  const actualReadRef = JSON.parse(nativeCatalog.text).entries.find((row: { kind: string }) => row.kind === "quality").readRef as string;

  assert.ok((await source.read(scope, [actualReadRef], 12000, signal))[0]!.text.includes('"phase":"use_feedback"'));
  const known = { ...noActive, sourceRefs: later.sourceRefs };

  assert.deepEqual((await source.snapshot(scope, signal, known)).reconsider, []);

  state = await apply({ type: "record_collaboration_runtime", commandId: "collaboration-runtime:dispatch:later-use-round2", issuedAt: at,
    receipt: { schemaVersion: 1, receiptId: "dispatch:later-use-round2", phase: "dispatched", scope, owner,
      ownerFingerprint: experienceOwnerFingerprint(owner), versionIds: ["experience:original"], recordedAt: at,
      boundary: { executionId: "execution:ordinary", taskId: "task:ordinary", round: 2, role: "personal_agent",
        requestId: "request:ordinary-round2", configurationRef: "configuration:ordinary" } } });
  const repeated = await source.snapshot(scope, signal, known);

  assert.deepEqual(repeated.sourceRefs, []);
  assert.deepEqual(repeated.reconsider, []);
  assert.equal(repeated.hasMore, false);
  const repeatedChange = projectOrganizationNativeFeedbackChanges(state, { scope, workspaceId: scope })
    .find(row => row.factRef === "dispatch:later-use-round2");
  assert.ok(repeatedChange);
  assert.ok((await source.read(scope, [nativeChangeReadRef(repeatedChange)], 12000, signal))[0]!.text.includes('"receiptId":"dispatch:later-use-round2"'));
  const passive = later.materials.find(row => {
    if (!row.ref.startsWith("central-runtime-native-catalog:")) return false;
    const body = JSON.parse(row.text);
    return body.role === "original_native_feedback_change_catalog_not_read_body" && body.attention === "repeated_pa_phase_navigation";
  });
  assert.ok(passive, "the delivered first notice advertises the exact chain; a quiet ended purpose need not refill passive context");
  assert.ok(!passive.sourceRefs.includes("dispatch:later-use-round2"), "passive navigation does not acknowledge the later receipt");
  const chainRef = JSON.parse(passive.text).entries[0].readRef as string;

  assert.match(chainRef, /^central-runtime-native-catalog:chain:[a-f0-9]{64}:0$/);
  const chain = (await source.read(scope, [chainRef], 12000, signal))[0]!;

  assert.equal(JSON.parse(chain.text).role, "original_native_feedback_change_catalog_not_read_body");
  assert.ok(chain.text.includes("dispatch:later-use-round2"));
  const broadlyKnown = await source.snapshot(scope, signal, { ...known, sourceRefs: [...known.sourceRefs, chainRef] });

  assert.deepEqual(broadlyKnown.sourceRefs, []);
  assert.deepEqual(broadlyKnown.reconsider, []);
  const watch = { plane: "central", questionRef: "question:explicit-phase-watch" } as const;
  const listening = await source.snapshot(scope, signal, { ...known, subjects: [watch], purposes: [{ subject: watch, sourceRefs: [chainRef] }] });

  assert.ok(listening.sourceRefs.includes("dispatch:later-use-round2"));
  assert.ok(listening.reconsider?.some(row => row.sourceRefs.includes("dispatch:later-use-round2")
    && canonicalJson(row.subject) === canonicalJson(watch)), "an explicit current purpose can listen through the exact original issue binding");

  await apply({ type: "coordinate_learning", commandId: "command:claim-original", issuedAt: at, action: {
    kind: "claim", jobId, expectedAttempt: 0, claimId: "claim:original", ownerId: "worker:original", expiresAt: "2026-11-05T00:05:00.000Z" } });
  await apply({ type: "coordinate_learning", commandId: "command:wait-original", issuedAt: at, action: {
    kind: "finish", jobId, claimId: "claim:original", result: { kind: "waiting_dependency", dependencies: [{
      dependencyId: "dependency:original", owner: "tool", requestId: "request:approval", correlationRef: "correlation:original",
      state: { kind: "waiting", reason: "Await an original external approval" } }] } } });
  assert.deepEqual((await source.snapshot(scope, signal, known)).sourceRefs, [], "an initial research wait is not an external feedback event");
  state = await apply({ type: "coordinate_learning", commandId: "command:authorized-original", issuedAt: at, action: {
    kind: "dependency", dependencyId: "dependency:original", expectedRevision: 1,
    state: { kind: "authorized", authorizationRef: "approval:actual" } } });
  const approved = await source.snapshot(scope, signal, known);

  assert.deepEqual(approved.opportunities, []);
  assert.deepEqual(approved.reconsider?.map(row => row.subject), [subject]);
  assert.ok(approved.reconsider?.[0]?.reason.includes("native_dependency"));
  assert.ok(approved.materials.some(row => row.text.includes("approval:actual")));
  assert.ok(approved.materials.some(row => row.text.includes('"attention":"repeated_pa_phase_navigation"')
    && row.text.includes('"receiptCount":2')), "another actual event carries the current bounded chain index");
  const approvalCatalog = approved.materials.find(row => row.ref.startsWith("central-runtime-native-catalog:")
    && JSON.parse(row.text).entries.some((entry: { kind?: string }) => entry.kind === "dependency"));
  assert.ok(approvalCatalog);
  const dependencyReadRef = JSON.parse(approvalCatalog.text).entries[0].readRef as string;

  assert.equal(JSON.parse((await source.read(scope, [dependencyReadRef], 12000, signal))[0]!.text).payload.state.authorizationRef, "approval:actual");

  await apply({ type: "record_collaboration_runtime", commandId: "collaboration-runtime:loaded:later-use-round2", issuedAt: at,
    receipt: { schemaVersion: 1, receiptId: "loaded:later-use-round2", phase: "loaded", scope, owner,
      ownerFingerprint: experienceOwnerFingerprint(owner), versionIds: ["experience:original"], recordedAt: at,
      boundary: { executionId: "execution:ordinary", taskId: "task:ordinary", round: 2, role: "personal_agent",
        requestId: "request:ordinary-loaded-round2", configurationRef: "configuration:ordinary" } } });
  const firstLoaded = await source.snapshot(scope, signal, { ...known, sourceRefs: [...new Set([...known.sourceRefs, ...approved.sourceRefs])] });

  assert.ok(firstLoaded.sourceRefs.includes("loaded:later-use-round2"), "acknowledging dispatch does not suppress the first loaded phase");
  assert.ok(firstLoaded.reconsider?.some(row => row.sourceRefs.includes("loaded:later-use-round2")
    && canonicalJson(row.subject) === canonicalJson(subject)));

  // Parent-purpose citations are evidence, not the destination of this child's
  // work. Match the original receiver's canonical request identity instead.
  const child = { plane: "central", questionRef: "question:child" } as const;
  const toolRequest = centralResearchRequestRef(scope, child.questionRef, "tool");
  const plan: evolution.ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope: "native-tool-workspace",
    capability: "Inspect original parameter prerequisites", createdAt: at,
    trigger: { runId: "run:research", proposalKey: toolRequest, action: "central_research", evidenceRefs: [child.questionRef, subject.questionRef] } };
  const toolJob = evolution.toolLearningJobId(plan);
  const toolReported = reduce(emptyBoardState(), { type: "coordinate_learning", commandId: "command:tool-report", issuedAt: at,
    action: { kind: "report", scope, issueId: "issue:child-tool", problemKey: "research:child-tool", report: {
      reportId: "report:child-tool", source: { subsystem: "tool", taskId: "task:child-tool", versionId: toolJob },
      facts: ["Requested child research"], evidenceRefs: [subject.questionRef, child.questionRef] } } });

  assert.ok(toolReported.ok);
  if (!toolReported.ok) return;

  const toolState = { ...toolReported.state, assets: [{ versionId: evolution.planVersionId(toolJob), kind: "tool_package" as const,
    schemaVersion: 1, content: plan, contentHash: contentHashOf(plan), scope: plan.scope, source: "inferred" as const, createdAt: at }] };
  const toolSource = createCentralRuntimeSource({ scope, boardRoot: "unused", enabled: () => true, ports: [],
    board: { async load() { return { ok: true, state: toolState, generation: 1 }; } },
    domainFeedback: async () => ({ sourceRef: "feedback:tool-result", sourceRefs: ["tool:actual-result"], records: [{ finding: "Original native tool progress" }] }) });
  const toolSnapshot = await toolSource.snapshot(scope, signal, { subjects: [subject, child], sourceRefs: [],
    purposes: [{ subject, sourceRefs: [] }, { subject: child, sourceRefs: [subject.questionRef] }] });

  assert.deepEqual(toolSnapshot.opportunities, []);
  assert.deepEqual(toolSnapshot.reconsider?.map(row => row.subject), [child]);
}));

test("source increment preserves the source owner's raw page metadata before capacity fragmentation", async () => {
  const page: TaskSourcePage = { ref: "raw:original-page", originalRef: "raw:original-event", originalScope: scope,
    owner: "session", origin: "execution_result", coordinate: { runId: "session:original", sequence: 7 },
    sourceHash: contentHashOf("The actual result before any model summary"), start: 5, end: 18, totalChars: 40, text: "actual result" };
  const next = { ...page, start: 18, end: 31, text: "next original" };
  const source = createCentralRuntimeSource({ scope, boardRoot: "unused", enabled: () => true, ports: [],
    board: { async load() { return { ok: true, state: emptyBoardState(), generation: 1 }; } },
    pageReader: { async read(ref, _signal, start) { assert.equal(ref, page.ref);
    assert.equal(start === page.start || start === next.start, true);
      return { ok: true, value: start === next.start ? next : page }; } } });
  const read = await source.read(scope, [`central-runtime-page:${page.start}:${encodeURIComponent(page.ref)}`], 12000, signal);

  assert.deepEqual(read, [centralMaterialFromPage(page)]);
  const original = JSON.parse(read[0]!.text);

  assert.equal(original.role, "actual_source_fragment_not_full_source");
  assert.equal(original.complete, false);
  assert.deepEqual(original.coordinate, page.coordinate);
  assert.equal(original.sourceHash, page.sourceHash);
  assert.equal(original.owner, "session");
  assert.equal(original.origin, "execution_result");
  assert.equal(original.originalScope, scope);
  assert.equal(original.originalRef, page.originalRef);
  assert.equal(original.start, 5);
  assert.equal(original.end, 18);
  assert.equal(original.text, page.text);
  assert.deepEqual(await source.read(scope, [original.nextRef], 12000, signal), [centralMaterialFromPage(next)]);
});
