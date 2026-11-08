import assert from "node:assert/strict";
import test from "node:test";
import type { JsonObject } from "../../protocol/envelope.js";
import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import type { BoardCommand } from "../../learning/control/commands.js";
import { emptyBoardState, type BoardState } from "../../learning/control/state.js";
import { reduce } from "../../learning/control/reducer.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { skillLifecycleDraft } from "../../learning/agent/subsystems/skill/control/lifecycle-facts.js";
import { skillLifecycleProjection } from "../../learning/agent/subsystems/skill/control/lifecycle.js";
import { canonicalObservations, type MethodObservation } from "../../learning/agent/subsystems/method/domain/inference-observations.js";
import type { MethodExperienceFact } from "../../learning/agent/subsystems/method/domain/experience-facts.js";
import { contentDomainFeedbackText, type ContentDomainFeedback } from "../learning-content/sources/domain-feedback-basis.js";
import type { ContentDomainFeedbackChange } from "../learning-content/sources/domain-feedback.js";
import { createNativeFeedbackUnitPublicView } from "./native-feedback-unit-view.js";
import { createRuntimeSourceFrames } from "./runtime-source-frames.js";
import { centralResearchReadSourceSignatures } from "./research-intake-episode-sources.js";
import { buildCentralRuntimeRecord, emptyCentralRuntimeState, initialCentralRuntimeRef } from "../../learning/central/runtime/records.js";
import { centralMaterialFromPage } from "./deliberation-material.js";
import { centralResearchNativeEvidenceIssueRefs, centralResearchReadNativeEvidenceSignatures } from "./research-intake-native-evidence.js";

const scope = "workspace:native-read-unit", issueId = "issue:native-read-unit", at = "2026-11-05T10:00:00.000Z";
const signal = () => new AbortController().signal;
const hash = "a".repeat(64);

function page(frame: ContentDomainFeedback, start = 0, end = contentDomainFeedbackText(frame).length): CentralRuntimeMaterial {
  const body = contentDomainFeedbackText(frame);
  return centralMaterialFromPage({ ref: frame.sourceRef, originalRef: frame.sourceRef, originalScope: scope,
    origin: "model_proposal", owner: "domain_feedback", coordinate: { runId: `domain-feedback-frame-projection:${contentHashOf([scope, frame.sourceRef])}`, sequence: 0 },
    sourceHash: contentHashOf(body), start, end, totalChars: body.length, text: body.slice(start, end) });
}

function legacy(frame: ContentDomainFeedback, prefix: "central-runtime-domain" | "central-runtime-domain-body" = "central-runtime-domain"): CentralRuntimeMaterial {
  const body = contentDomainFeedbackText(frame);
  return { ref: `${prefix}:${encodeURIComponent(issueId)}:${contentHashOf(body)}`, kind: "feedback", text: body, sourceRefs: [frame.sourceRef] };
}

test("native read freshness keeps original roles/revisions, ignores unread new rows and rejects projection-only or forged bodies", async () => {
  let board = emptyBoardState(), serial = 0;
  const act = (command: BoardCommand) => {
    const next = reduce(board, command);
    assert.ok(next.ok);
    board = next.state;
  };
  const coordinate = (action: Extract<BoardCommand, { type: "coordinate_learning" }>["action"]) =>
    act({ type: "coordinate_learning", commandId: `native-owner:${++serial}`, issuedAt: at, action });

  coordinate({ kind: "open_budget", expectedSequence: 0, budget: { schemaVersion: 1, budgetId: "root:native", scope,
    unit: "total_model_tokens", limits: { tokens: 1000, calls: 2, steps: 2 }, authorizationRef: "authorization:original" } });
  coordinate({ kind: "report", scope, issueId, problemKey: "native:read-unit", report: { reportId: "report:native",
    source: { kind: "research_request", domain: "skill", requestRef: "request:native", intentRef: "intent:native" },
    facts: ["The original native owner supplied this source."], evidenceRefs: ["source:native"] } });
  coordinate({ kind: "decide", issueId, expectedRevision: board.learningIssues![0]!.revision,
    decision: "focused_learning", reason: "Original research owner.", sourceRefs: ["source:native"] });
  coordinate({ kind: "fund", issueId, expectedRevision: board.learningIssues![0]!.revision, grantId: "grant:native", domain: "skill",
    allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 1000, maxCalls: 2, maxSteps: 2, maxPromptChars: 2000 },
    budgetId: "root:native", authorizationRef: "authorization:original", planRef: "plan:native", expectedSequence: board.sequence });
  const jobId = board.learningIssues![0]!.jobId!;

  coordinate({ kind: "claim", jobId, expectedAttempt: 0, claimId: "claim:native", ownerId: "owner:native", expiresAt: "2026-11-05T10:01:00.000Z" });
  coordinate({ kind: "finish", jobId, claimId: "claim:native", result: { kind: "completed", resultRefs: ["hermes-pending:skills:pending:native"] } });
  const binding = { issueId, grantId: "grant:native", jobId, pendingRef: "hermes-pending:skills:pending:native" };
  const approval = skillLifecycleDraft(scope, { ...binding, schemaVersion: 1, kind: "native_approved", at,
    payloadHash: `sha256:${hash}`, action: "create", name: "native-skill", instructionHash: hash });
  assert.ok(approval);
  act({ type: "record_reward_v2_fact", commandId: "native:approved-source", issuedAt: at, expectedSequence: board.sequence, fact: approval });
  const readOwnerFeedback = async () => skillLifecycleProjection(board, scope, issueId);
  const initial = (await readOwnerFeedback())!;
  const read = async (materials: readonly CentralRuntimeMaterial[]) => centralResearchReadNativeEvidenceSignatures({ board, scope, issueId, materials, readOwnerFeedback }, signal());
  const approvalRead = page(initial), baseline = await read([approvalRead]);
  assert.equal(baseline.length, 1);
  const midpoint = Math.floor(contentDomainFeedbackText(initial).length / 2);

  assert.deepEqual(await read([page(initial, 0, midpoint), page(initial, midpoint)]), baseline,
    "contiguous actual pages can retain a whole row across the original page boundary");
  assert.deepEqual(await read([legacy(initial)]), baseline, "legacy and canonical paging refer to the same original approval unit");
  assert.deepEqual(await read([legacy(initial, "central-runtime-domain-body")]), baseline, "the native whole-frame body alias preserves the original unit");
  const load = skillLifecycleDraft(scope, { ...binding, schemaVersion: 1, kind: "instruction_loaded", at: "2026-11-05T10:00:01.000Z",
    name: "native-skill", instructionHash: hash, renderedContentHash: hash, approvalRef: approval.id,
    sessionId: "session:actual-use", turnId: "turn:actual-use", toolCallId: "call:actual-use", transcriptSequence: 2, journalSequence: 3 });
  assert.ok(load);
  act({ type: "record_reward_v2_fact", commandId: "native:load-source", issuedAt: at, expectedSequence: board.sequence, fact: load });
  assert.deepEqual(await read([approvalRead]), baseline, "a new current owner row that was not read must not refresh the program");
  const current = (await readOwnerFeedback())!, all = await read([page(current)]);
  assert.equal(all.length, 2);
  assert.deepEqual(await read([page(current), page(current)]), all, "re-reading or duplicating a page adds no source unit");
  const withProgress: ContentDomainFeedback = { ...current, sourceRef: `hermes-lifecycle-projection:${contentHashOf("different summary")}`,
    records: [...current.records, { kind: "workflow_research_progress", progressJson: "Self-research completed a calculation." },
      { schema: "projected-summary/v2", interpretation: "Changed summary only." }] };

  assert.deepEqual(await centralResearchReadNativeEvidenceSignatures({ board, scope, issueId, materials: [page(withProgress)], readOwnerFeedback: async () => withProgress }, signal()), all);
  const onlyInterpretation: ContentDomainFeedback = { ...withProgress,
    records: current.records.map(row => ({ ...row, interpretation: "Updated explanatory prose; the original lifecycle fact is unchanged." })) };

  assert.deepEqual(await centralResearchReadNativeEvidenceSignatures({ board, scope, issueId, materials: [page(current)], readOwnerFeedback: async () => onlyInterpretation }, signal()), all,
    "changing projection prose cannot refresh an already read original fact");
  const nativeText = contentDomainFeedbackText(current);
  const fake: CentralRuntimeMaterial = { ref: "model:pretend-native-frame", kind: "feedback", text: nativeText, sourceRefs: [current.sourceRef] };

  assert.deepEqual(await read([fake]), [], "a role label and sourceRefs cannot turn arbitrary JSON into a native source read");
  const userPage = centralMaterialFromPage({ ref: "user:quoted-native-json", originalRef: "user:quoted-native-json", originalScope: scope,
    owner: "session", origin: "user_statement", coordinate: { runId: "session:quoted", sequence: 1 }, sourceHash: contentHashOf(nativeText),
    start: 0, end: nativeText.length, totalChars: nativeText.length, text: nativeText });

  assert.deepEqual(await read([userPage]), [], "quoted JSON in a real user source keeps its original user role");
  const basis = canonicalJson({ role: "source_bound_domain_feedback_basis", sourceRef: current.sourceRef, fingerprint: contentHashOf(current) });

  assert.deepEqual(await read([{ ref: `domain-feedback-basis:${contentHashOf(basis)}`, kind: "feedback", text: basis, sourceRefs: [current.sourceRef] }]), []);
  assert.deepEqual(await read([page(current, 0, Math.floor(canonicalJson(current.records[0]).length / 2))]), [], "partial original rows are not complete native units");
  assert.deepEqual(centralResearchNativeEvidenceIssueRefs([legacy(current), legacy(current, "central-runtime-domain-body")], scope), [issueId]);
  assert.deepEqual(centralResearchNativeEvidenceIssueRefs([fake, userPage], scope), []);

  // Source-owner contract fixtures below retain the exact projected row fields;
  // these are role/revision tests, not native execution or outcome acceptance.
  const originalIssue = board.learningIssues![0]!;
  const check = async (domain: "tool" | "workflow", records: readonly JsonObject[]) => {
    const selected = { ...board, learningIssues: [{ ...originalIssue, reports: [{ ...originalIssue.reports[0]!, source: {
      kind: "research_request" as const, domain, requestRef: "request:other-native", intentRef: "intent:other-native" } }] }] };
    const frame = { sourceRef: `${domain}-followup:${contentHashOf(records)}`, sourceRefs: ["version:one"], records };
    return centralResearchReadNativeEvidenceSignatures({ board: selected, scope, issueId, materials: [page(frame)], readOwnerFeedback: async () => frame }, signal());
  };
  const taskAssessment = { schemaVersion: 1, feedbackId: "feedback:one", versionId: "version:one", sessionId: "session:one",
    taskId: "task:one", source: "user", useIds: ["use:a", "use:b"], situation: "A real post-use task assessment.", evidenceRefs: ["receipt:a", "receipt:b"],
    outcome: "partial", attribution: "mixed", summary: "The exact task assessment covers both original calls.", recommendation: "revise" };
  const tool = await check("tool", [{ kind: "tool_task_assessment", unit: "tool_task_assessment", factRef: "tool-feedback:one",
    revisionRef: `tool-history:${contentHashOf(taskAssessment)}`, payloadJson: canonicalJson(taskAssessment) }]);

  assert.equal(tool.length, 1, "one task assessment covering two calls remains one original assessment revision");
  const toolBodies: readonly JsonObject[] = [
    { kind: "tool_invocation", factRef: "use:a", revisionRef: "tool-history:old-use", payloadJson: canonicalJson({ useId: "use:a", versionId: "version:one" }) },
    { kind: "tool_task_assessment", factRef: "tool-feedback:one", revisionRef: "tool-history:old-assessment", payloadJson: canonicalJson(taskAssessment) },
    { kind: "tool_contract_review", factRef: "proposal:one", revisionRef: "tool-history:old-contract",
      payloadJson: canonicalJson({ revisionId: "revision:one", approved: true, proposal: { parentVersionId: "version:one" } }) },
    { kind: "tool_approval", factRef: "approval:one", revisionRef: "tool-history:old-approval",
      payloadJson: canonicalJson({ approvalId: "approval:one", status: "approved" }) },
  ];
  const toolLocators = ["use:a", "tool-feedback:one", "revision:one", "approval:one:approved"];

  assert.deepEqual(await check("tool", toolBodies.map((row, index) => ({ ...row, revisionRef: toolLocators[index]! }))),
    await check("tool", toolBodies), "transparent wrapper locator changes do not revise an unchanged original tool unit");

  let archiveBoard: BoardState = { ...board, learningIssues: [{ ...originalIssue, reports: [{ ...originalIssue.reports[0]!, source: {
    kind: "research_request", domain: "tool", requestRef: "request:unit-view", intentRef: "intent:unit-view" } }] }] };
  const archiveOptions = { boardRoot: "unused:injected-original-board", scope, enabled: () => true, board: {
    read: async () => ({ revision: archiveBoard.sequence, facts: archiveBoard.rewardV2Facts ?? [] }),

    append: async (expectedSequence, fact) => {
      const next = reduce(archiveBoard, { type: "record_reward_v2_fact", commandId: `archive:${fact.id}`, issuedAt: at, expectedSequence, fact });
      assert.ok(next.ok);
      archiveBoard = next.state;
      return { status: "written" as const, revision: next.state.sequence, idempotent: false };
    },
  } } satisfies Parameters<typeof createRuntimeSourceFrames>[0];
  const archive = createRuntimeSourceFrames(archiveOptions);
  const change: ContentDomainFeedbackChange = { domain: "tool", issueId, kind: "quality", factRef: "tool-feedback:one",
    unitRef: "tool-assessment:feedback:one", revisionRef: "tool-feedback:one", sourceRefs: ["tool-feedback:one"] };
  const freezeView = async (selected: ContentDomainFeedbackChange, recordKind: string, original: JsonObject) => {
    return archive.unit(archiveBoard.learningIssues![0]!, selected, { kind: "found", recordKind, payload: original,
      sourceRefs: [selected.factRef, selected.unitRef, selected.revisionRef] }, signal());
  };
  let currentUnitFrame: ContentDomainFeedback = { sourceRef: `tool-followup:${contentHashOf(taskAssessment)}`, sourceRefs: ["version:one"],
    records: [{ ...change, kind: "tool_task_assessment", payloadJson: canonicalJson(taskAssessment) }] };
  const readViews = (materials: readonly CentralRuntimeMaterial[]) => centralResearchReadNativeEvidenceSignatures({ board: archiveBoard,
    scope, issueId, materials, readOwnerFeedback: async () => currentUnitFrame }, signal());
  const unitMaterial = await freezeView(change, "tool_task_assessment", taskAssessment);

  assert.deepEqual(centralResearchNativeEvidenceIssueRefs([unitMaterial], scope, archiveBoard), [issueId], "official opaque archive origin supplies only the actual issue navigation");
  assert.deepEqual(await readViews([unitMaterial]), tool, "the archived new unit view and old typed whole frame identify the same original assessment");
  currentUnitFrame = { ...currentUnitFrame, records: [{ ...currentUnitFrame.records[0]!, revisionRef: "other:revision",
    payloadJson: canonicalJson({ ...taskAssessment, summary: "This other native revision must not be borrowed." }) }, ...currentUnitFrame.records] };
  assert.deepEqual(await readViews([unitMaterial]), tool, "a different revision with the same fact reference cannot replace the exact native tuple");
  const unitPage = (start: number, end: number) => {
    const body = { originalRef: unitMaterial.ref, start, end, totalChars: unitMaterial.text.length, text: unitMaterial.text.slice(start, end),
      nextRef: end < unitMaterial.text.length ? `central-runtime-page:${end}:${encodeURIComponent(unitMaterial.ref)}` : null };
    return { ref: `central-runtime-fragment:${contentHashOf([body.originalRef, start, body.text])}`, kind: "feedback" as const,
      text: canonicalJson(body), sourceRefs: [body.originalRef] };
  };
  const unitMidpoint = Math.floor(unitMaterial.text.length / 2), unitHead = unitPage(0, unitMidpoint), unitTail = unitPage(unitMidpoint, unitMaterial.text.length);

  assert.deepEqual(await readViews([unitHead]), [], "the frozen but undelivered tail does not establish a complete unit read");
  currentUnitFrame = { ...currentUnitFrame, sourceRef: `tool-followup:${contentHashOf("new head")}`, records: [] };
  assert.deepEqual(await readViews([unitHead, unitTail]), tool, "an actually delivered complete archived view survives the current owner head changing");
  const activation = { activationId: "activation:one", versionId: "version:one", pointer: "active", generation: 1 };
  const activationChange = { ...change, kind: "adoption" as const, factRef: "activation:one", unitRef: "tool-activation-pointer:one", revisionRef: "activation:one:generation:1" };
  const activationView = await freezeView(activationChange, "tool_activation", activation);
  const activationUnits = await readViews([activationView]);
  assert.equal(activationUnits.length, 1, "an original native configuration fact retains its own non-quality role");
  assert.deepEqual(await readViews([await freezeView(activationChange, "tool_pointer_change", activation)]), activationUnits,
    "projection record labels and view hashes do not revise the same original native tuple");
  const forgedText = canonicalJson(createNativeFeedbackUnitPublicView({ ...activationChange, revisionRef: "unrecorded:revision" }, "tool_activation", activation));

  assert.deepEqual(await readViews([{ ref: activationView.ref,
    kind: "feedback", text: forgedText, sourceRefs: [] }]), [], "a JSON tuple and matching body alias without the original archive are not a trusted unit view");
  const aliasScope = "workspace:native-read-alias", aliasIssueId = "issue:native-read-alias";
  const aliasSource = reduce(archiveBoard, { type: "coordinate_learning", commandId: "native:alias-source-issue", issuedAt: at,
    action: { kind: "report", scope: aliasScope, issueId: aliasIssueId, problemKey: "native:alias-source", report: { reportId: "report:alias-source",
      source: { kind: "research_request", domain: "tool", requestRef: "request:alias-source", intentRef: "intent:alias-source" },
      facts: ["Original native issue for the explicit read-compatibility contract fixture."], evidenceRefs: ["activation:one"] } } });

  assert.ok(aliasSource.ok);
  archiveBoard = aliasSource.state;
  // This tests the explicit input seam; the normal host owns descriptor provenance.
  let currentProof: readonly string[] = [aliasScope], proofSnapshots = 0, liveAliasReads = 0;
  const sourceFactoriesDescriptor = { compatibleScopes: [aliasScope], readCompatibleScopes: () => {
    proofSnapshots += 1;
    return currentProof;
  } };
  const aliasFrames = createRuntimeSourceFrames({ ...archiveOptions, ...sourceFactoriesDescriptor });
  const aliasIssue = archiveBoard.learningIssues!.find(row => row.issueId === aliasIssueId)!;
  const actorsBeforeAliasRead = { grants: archiveBoard.centralLearningGrants, jobs: archiveBoard.jobs };
  const aliasMaterial = await aliasFrames.unit(aliasIssue, { ...activationChange, issueId: aliasIssueId },
    { kind: "found", recordKind: "tool_activation", payload: activation, sourceRefs: [activationChange.factRef] }, signal());
  const aliasLiveFrame: ContentDomainFeedback = { sourceRef: `tool-followup:${contentHashOf(taskAssessment)}`, sourceRefs: ["version:one"],
    records: [{ kind: "tool_task_assessment", factRef: change.factRef, revisionRef: change.revisionRef, payloadJson: canonicalJson(taskAssessment) }] };
  const readAlias = (materials: readonly CentralRuntimeMaterial[]) => centralResearchReadNativeEvidenceSignatures({ board: archiveBoard,
    scope, issueId: aliasIssueId, materials, ...sourceFactoriesDescriptor,

    readOwnerFeedback: async () => {
      liveAliasReads += 1;
      return aliasLiveFrame;
    } }, signal());
  const aliasPage = centralMaterialFromPage({ ref: aliasMaterial.ref, originalRef: aliasMaterial.ref, originalScope: aliasScope,
    owner: "domain_feedback", origin: "model_proposal", coordinate: { runId: aliasMaterial.ref, sequence: 0 }, sourceHash: contentHashOf(aliasMaterial.text),
    start: 0, end: aliasMaterial.text.length, totalChars: aliasMaterial.text.length, text: aliasMaterial.text });

  currentProof = [];
  const beforeSnapshot = proofSnapshots;

  assert.deepEqual(await readAlias([aliasPage]), activationUnits, "authenticated primary history survives alias proof withdrawal without a fresh owner read");
  assert.equal(proofSnapshots - beforeSnapshot, 1);
  assert.equal(liveAliasReads, 0);
  assert.deepEqual(centralResearchNativeEvidenceIssueRefs([aliasPage], scope, archiveBoard), [aliasIssueId]);
  assert.deepEqual(centralResearchReadSourceSignatures([aliasPage, page(current)], scope, { board: archiveBoard }), [],
    "one canonical parse accepts an authenticated historical alias and the primary page without promoting a frame to raw evidence");
  const aliasLiveText = contentDomainFeedbackText(aliasLiveFrame);
  const aliasLiveMaterial: CentralRuntimeMaterial = { ref: `central-runtime-domain:${encodeURIComponent(aliasIssueId)}:${contentHashOf(aliasLiveText)}`,
    kind: "feedback", text: aliasLiveText, sourceRefs: [aliasLiveFrame.sourceRef] };

  assert.deepEqual(await readAlias([aliasLiveMaterial]), [], "an empty current callback takes precedence over the base alias list for fresh owner reads");
  assert.equal(liveAliasReads, 0);
  currentProof = [aliasScope];
  assert.deepEqual(await readAlias([aliasLiveMaterial]), tool);
  assert.equal(liveAliasReads, 1);
  const aliasUserText = "The original task correction changes its declared schema.";
  const aliasUserPage = centralMaterialFromPage({ ref: "user:alias-correction", originalRef: "user:alias-correction", originalScope: aliasScope,
    owner: "session", origin: "user_statement", coordinate: { runId: "session:alias-correction", sequence: 1 }, sourceHash: contentHashOf(aliasUserText),
    start: 0, end: aliasUserText.length, totalChars: aliasUserText.length, text: aliasUserText });

  assert.deepEqual(centralResearchReadSourceSignatures([aliasUserPage], scope, { acceptedScopes: currentProof }),
    centralResearchReadSourceSignatures([aliasUserPage], aliasScope), "a permitted raw alias keeps its original source scope identity");
  const aliasBoardPage = centralMaterialFromPage({ ref: "board:alias-execution", originalRef: "board:alias-execution", originalScope: aliasScope,
    owner: "board", origin: "execution_result", coordinate: { runId: "board:alias-execution-run", sequence: 2 }, sourceHash: contentHashOf(aliasUserText),
    start: 0, end: aliasUserText.length, totalChars: aliasUserText.length, text: aliasUserText });
  const deliveredAliasPages = [aliasUserPage, aliasBoardPage];
  const deliveredAliasSignatures = centralResearchReadSourceSignatures(deliveredAliasPages, scope, { acceptedScopes: currentProof });

  await archiveOptions.board.append(archiveBoard.sequence, buildCentralRuntimeRecord({ previousRef: initialCentralRuntimeRef(scope),
    state: { ...emptyCentralRuntimeState(scope), materials: deliveredAliasPages }, reason: "Retain previously delivered original alias source pages in the primary runtime.",
    sourceRefs: deliveredAliasPages.map(material => material.ref) }));
  currentProof = [];
  assert.deepEqual(await readAlias([aliasMaterial]), activationUnits);
  assert.equal(liveAliasReads, 1);
  assert.deepEqual(centralResearchReadSourceSignatures(deliveredAliasPages, scope, { board: archiveBoard }), deliveredAliasSignatures,
    "exact delivered session and board pages retained in the primary runtime survive later alias proof withdrawal");
  const uncommittedAliasPage = centralMaterialFromPage({ ref: "user:uncommitted-alias", originalRef: "user:uncommitted-alias", originalScope: aliasScope,
    owner: "session", origin: "user_statement", coordinate: { runId: "session:uncommitted-alias", sequence: 1 }, sourceHash: contentHashOf(aliasUserText),
    start: 0, end: aliasUserText.length, totalChars: aliasUserText.length, text: aliasUserText });

  assert.throws(() => centralResearchReadSourceSignatures([uncommittedAliasPage], scope, { board: archiveBoard }), /central_research_source_page_invalid/);
  assert.deepEqual({ grants: archiveBoard.centralLearningGrants, jobs: archiveBoard.jobs }, actorsBeforeAliasRead,
    "compatible source reads do not create an alias actor or a new grant");
  assert.equal(archiveBoard.learningIssues?.find(row => row.issueId === aliasIssueId)?.jobId, undefined);
  const dependency = { schemaVersion: 1 as const, dependencyId: "dependency:original", issueId, grantId: "grant:native", jobId,
    owner: "tool" as const, correlationRef: "correlation:original", revision: 1, observedAt: at,
    state: { kind: "ready" as const, resultRef: "result:original", resultVersion: "version:original", evidenceRefs: ["check:original"] } };

  archiveBoard = { ...archiveBoard, learningIssues: board.learningIssues ?? [], learningDependencies: [dependency] };
  const dependencyMaterial = async (value: typeof dependency | (Omit<typeof dependency, "state"> & { readonly state: { readonly kind: "waiting"; readonly reason: string } })) => {
    const text = canonicalJson({ role: "original_native_dependency_fact_not_verification", value });
    return archive.dependency(archiveBoard.learningIssues![0]!, { ref: `central-runtime-native-dependency:${contentHashOf(text)}`,
      kind: "feedback", text, sourceRefs: [value.dependencyId, value.grantId, value.jobId] }, signal());
  };
  const readDependencies = (materials: readonly CentralRuntimeMaterial[]) => centralResearchReadNativeEvidenceSignatures({ board: archiveBoard,
    scope, issueId, materials, readOwnerFeedback: async () => skillLifecycleProjection(archiveBoard, scope, issueId) }, signal());
  const readyDependency = await dependencyMaterial(dependency), dependencyUnits = await readDependencies([readyDependency]);

  assert.equal(dependencyUnits.length, 1, "the actually read native dependency state has its own non-execution source role");
  archiveBoard = { ...archiveBoard, learningDependencies: [{ ...dependency, revision: 2, state: { kind: "failed", reason: "The later original dependency failed." } }] };
  assert.deepEqual(await readDependencies([readyDependency]), dependencyUnits, "a later original dependency revision does not invalidate an actually read archived revision");
  assert.deepEqual(await readDependencies([await dependencyMaterial({ ...dependency, grantId: "grant:foreign" })]), [], "a cached dependency cannot borrow another grant binding");
  const waitingDependency = { ...dependency, revision: 3, state: { kind: "waiting" as const, reason: "Original authority is still unavailable." } };

  archiveBoard = { ...archiveBoard, learningDependencies: [waitingDependency] };
  assert.deepEqual(await readDependencies([await dependencyMaterial(waitingDependency)]), [], "an unadvertised waiting state is not new native evidence");
  const feedback = { kind: "workflow_feedback", recordRef: "workflow-record:initial", useId: "use:one", versionId: "version:one", feedbackId: "feedback:one",
    executionId: "execution:one", exposure: "reported_used", quality: "unknown", evidenceRefs: ["receipt:one"], followedStepIds: [],
    processEvidence: { kind: "unverified" }, explanation: "Original report with unknown gain." };
  const beforeCorrection = await check("workflow", [feedback]);
  const correction = await check("workflow", [{ ...feedback, recordRef: "workflow-record:corrected", userAssessment: { judgment: "harmed", evidenceRef: "user:exact-correction" } }]);

  assert.equal(beforeCorrection.length, 1);
  assert.equal(correction.length, 1);
  assert.notDeepEqual(correction, beforeCorrection);

  const originalObservation: MethodObservation = { observationId: "observation:original", versionId: "method:one", taskId: "task:one", opportunityId: "opportunity:one",
    scopeId: "condition:one", sequence: 1, revision: 1, source: "external", adoption: "adopted", outcome: "unknown", features: {} };
  const correctedObservation: MethodObservation = { ...originalObservation, observationId: "observation:corrected", revision: 2, outcome: "unhelpful" };
  let methodBoard = { ...board, learningIssues: [{ ...originalIssue, reports: [{ ...originalIssue.reports[0]!, source: {
    kind: "research_request" as const, domain: "prompt" as const, requestRef: "request:method", intentRef: "intent:method" } }] }],
  feedbacks: [{ versionId: "method:one", turnId: "turn:one", helped: false, recordedAt: at, exposureId: "exposure:one", observation: originalObservation }] };
  let actualMethodLocators = false;
  const methodReader = async (): Promise<ContentDomainFeedback> => {
    const observations = canonicalObservations(methodBoard.feedbacks.map(item => item.observation));
    const rows = observations.map(observation => ({ kind: "method_assessment", unit: "method_task_assessment", factRef: observation.observationId,
      revisionRef: actualMethodLocators ? `${observation.observationId}:revision:${observation.revision}` : `method-observation:${contentHashOf(observation)}`, revision: observation.revision,
      exposureId: "exposure:one", source: observation.source, adoption: observation.adoption, outcome: observation.outcome,
      economicComparison: "unregistered", payloadJson: canonicalJson(observation) }));
    return { sourceRef: `method-central-feedback:${contentHashOf(rows)}`, sourceRefs: observations.map(item => item.observationId), records: rows };
  };
  const methodInitialFrame = await methodReader(), methodOriginal = page(methodInitialFrame);
  const methodRead = (materials: readonly CentralRuntimeMaterial[]) => centralResearchReadNativeEvidenceSignatures({ board: methodBoard, scope, issueId,
    materials, readOwnerFeedback: methodReader }, signal());
  const originalAssessment = await methodRead([methodOriginal]);
  assert.equal(originalAssessment.length, 1);
  actualMethodLocators = true;
  assert.deepEqual(await methodRead([page(await methodReader())]), originalAssessment,
    "a real locator replacing a projection hash does not revise the same original method assessment");
  assert.deepEqual(await methodRead([methodOriginal]), originalAssessment, "already read historical aliases retain the same original method unit");
  const originalRowText = canonicalJson(methodInitialFrame.records[0]!), originalRowStart = contentDomainFeedbackText(methodInitialFrame).indexOf(originalRowText);

  assert.ok(originalRowStart >= 0);
  assert.deepEqual(await methodRead([page(methodInitialFrame, originalRowStart, originalRowStart + originalRowText.length)]), originalAssessment,
    "an authenticated old page containing the complete row preserves the original unit after a transparent locator change");
  const originalRowMidpoint = originalRowStart + Math.floor(originalRowText.length / 2);

  assert.deepEqual(await methodRead([page(methodInitialFrame, originalRowStart, originalRowMidpoint),
    page(methodInitialFrame, originalRowMidpoint + 1, originalRowStart + originalRowText.length)]), [], "a gap does not establish a complete original row");
  const readMethodRows = async (records: readonly JsonObject[], sourceBoard: BoardState = methodBoard) => {
    const frame = { sourceRef: `method-central-feedback:${contentHashOf(records)}`, sourceRefs: ["method:one"], records };
    return centralResearchReadNativeEvidenceSignatures({ board: sourceBoard, scope, issueId, materials: [page(frame)], readOwnerFeedback: async () => frame }, signal());
  };
  const noExposureAlias = (await methodReader()).records.map(({ exposureId: _projectionExposure, ...row }) => row);

  assert.deepEqual(await readMethodRows(noExposureAlias), originalAssessment, "the original writer relation preserves exposure when its wrapper omits the alias");
  const facts: readonly MethodExperienceFact[] = [
    { kind: "execution", factId: "execution:one", versionId: "method:one", sequence: 1,
      trace: { exposureId: "exposure:one", taskId: "task:one", opportunityId: "opportunity:one", scopeId: "condition:one",
        beat: 1, succeededTools: ["schema_check"], failures: [], omitted: 0 } },
    { kind: "decision", factId: "decision:one", versionId: "method:one", sequence: 2,
      context: { taskId: "task:one", opportunityId: "opportunity:one", situation: "Inspect the actual schema.", features: {} },
      decision: { action: "adopt", versionId: "method:one", scopeId: "condition:one", reason: "The task declared this schema." } },
    { kind: "restriction", factId: "restriction:one", versionId: "method:one", sequence: 3, scopeId: "condition:one",
      predicate: { all: [{ feature: "schema", value: "declared" }], exclude: [] }, reason: "The schema must be declared." },
    { kind: "scope_retired", factId: "retirement:one", versionId: "method:one", sequence: 4, scopeId: "condition:one", reason: "The original task condition was withdrawn." },
    { kind: "compilation_exit", factId: "compilation-exit:one", versionId: "method:one", sequence: 5,
      scopeId: "condition:one", compilationId: "compilation:one", reason: "The original compilation was withdrawn." },
    { kind: "exit", factId: "exit:one", versionId: "method:one", sequence: 6, mode: "archive", reason: "The original card was archived." },
  ];
  const fielding = { exposureId: "exposure:one", versionId: "method:one", proposalId: "proposal:method", turnId: "turn:one",
    beat: 1, requestId: "request:one", scope: "condition:one", recordedAt: at };
  const businessBoard = { ...methodBoard, fieldings: [fielding], methodExperienceFacts: facts };
  const businessRows = [{ kind: "method_delivery", factRef: fielding.exposureId, revisionRef: "method-fielding:old-alias", payloadJson: canonicalJson(fielding) },
    ...facts.map(fact => ({ kind: `method_${fact.kind}`, factRef: fact.factId, revisionRef: `method-fact:old-alias:${fact.factId}`, payloadJson: canonicalJson(fact) }))];
  const execution = businessRows[1]!;

  assert.deepEqual(await readMethodRows([{ ...execution, revisionRef: "execution:one" }], businessBoard), await readMethodRows([execution], businessBoard),
    "a wrapper locator does not revise the original associated execution");
  const businessUnits = await readMethodRows(businessRows, businessBoard);

  assert.equal(businessUnits.length, 7, "actual delivery, PA decision and native restrictions/withdrawals retain their own source roles without becoming quality or new trials");
  assert.deepEqual(await readMethodRows(businessRows.map(row => ({ ...row, revisionRef: row.factRef })), businessBoard), businessUnits,
    "original immutable method fact identities survive transparent projection aliases");
  const forgedRows = [{ ...businessRows[0]!, payloadJson: canonicalJson({ ...fielding, turnId: "turn:unrecorded" }) },
    ...facts.map(fact => ({ kind: `method_${fact.kind}`, factRef: fact.factId, revisionRef: fact.factId, payloadJson: canonicalJson({ ...fact, sequence: 999 }) }))];

  assert.deepEqual(await readMethodRows(forgedRows, businessBoard), [], "unrecorded payloads cannot become original method source units");
  methodBoard = { ...methodBoard, feedbacks: [...methodBoard.feedbacks, { ...methodBoard.feedbacks[0]!, observation: correctedObservation }] };
  assert.deepEqual(await methodRead([methodOriginal]), originalAssessment, "an unread replacement head must not change the original read signature");
  const revisedAssessment = await methodRead([page(await methodReader())]);
  assert.equal(revisedAssessment.length, 1);
  assert.notDeepEqual(revisedAssessment, originalAssessment, "an actually read original correction is a new revision of the same assessment, never another trial");
});
