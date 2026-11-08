import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { BoardCommand } from "../../learning/control/commands.js";
import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { experienceOwnerFingerprint } from "../../learning/agent/subsystems/collaboration/experience/policy.js";
import { projectOrganizationNativeFeedbackChanges } from "./organization-feedback-changes.js";
import { projectOrganizationDomainFeedback, readOrganizationNativeFeedbackUnit } from "./organization-feedback-sources.js";
import { createCentralRuntimeSource } from "./runtime-source.js";
import { createCentralRuntimeStore } from "./runtime-store.js";
import { emptyCentralRuntimeState } from "../../learning/central/runtime/records.js";
import { nativeChangeReadRef } from "./runtime-source-changes.js";
import { createCentralPublicSourceFrames } from "./public-source-frames.js";
import { createNativeFeedbackUnitPublicView, isNativeFeedbackUnitPublicView } from "./native-feedback-unit-view.js";
import { projectCollaborationCentralFeedback } from "../../learning/agent/subsystems/collaboration/runtime/index.js";
import { readRuntimePublicSourceFrame } from "./runtime-source-frames.js";
import type { CentralLearningExecutionPort } from "./contracts.js";
import type { CoordinationAction } from "../../learning/control/coordination-contract.js";

test("actual public source tails survive new native feedback and dependency revision after a cold restart", async () => {
  const boardRoot = await mkdtemp(join(tmpdir(), "central-source-tail-")), scope = join(boardRoot, "workspace");
  const signal = new AbortController().signal, at = "2026-11-05T00:00:00.000Z", issueId = "issue:tail", questionRef = "question:tail";
  const load = async () => {
    const loaded = await createBoardReader(boardRoot).load();
    assert.ok(loaded.ok);
    return loaded.state;
  };
  const apply = async (command: BoardCommand) => {
    const saved = await withBoardWriter(boardRoot, board => board.apply(command));
    assert.ok(saved.ok, JSON.stringify(saved));
    return saved.state;
  };

  try {
    await mkdir(scope);
    await writeFile(join(scope, "result.txt"), "Controlled source evidence; no provider call.\n");
    await apply({ type: "coordinate_learning", commandId: "tail:report", issuedAt: at, action: { kind: "report", scope,
      issueId, problemKey: "research:tail", report: { reportId: "report:tail", source: {
        kind: "research_request", domain: "collaboration", requestRef: "request:tail", intentRef: questionRef },
      facts: ["Requested research, not a new observed business failure"], evidenceRefs: ["source:original"] } } });
    await apply({ type: "coordinate_learning", commandId: "tail:focus", issuedAt: at, action: { kind: "decide",
      issueId, expectedRevision: 1, decision: "focused_learning", reason: "Bounded original source", sourceRefs: ["report:tail"] } });
    const funded = await apply({ type: "coordinate_learning", commandId: "tail:fund", issuedAt: at, action: { kind: "fund",
      issueId, expectedRevision: 2, grantId: "grant:tail", domain: "collaboration", allowance: {
        schemaVersion: 2, unit: "total_model_tokens", maxTokens: 5000, maxCalls: 1, maxSteps: 1, maxPromptChars: 4000 } } });
    const jobId = funded.learningIssues!.find(row => row.issueId === issueId)!.jobId!;
    const owner = { kind: "personal_agent", experienceKey: "owner:tail" } as const;
    const content = { schema: "collaboration-experience/v1", status: "trial", issueId, focusRevision: 2, owner,
      familyId: "tail-boundary", situation: "Keep the original artifact identity", responsibilities: ["Preserve the original reference"],
      practice: "Read the original artifact before handoff", sourceRefs: ["report:tail"], conditions: {} };

    await apply({ type: "submit_proposal", commandId: "tail:propose", issuedAt: at, proposal: { proposalId: "proposal:tail",
      domain: "collaboration", scope, assetKind: "workflow", candidateRef: "experience:tail", hypothesis: "Owner-bound trial",
      observationRefs: ["report:tail"], risk: "low", requiredVerifiers: [], requestedAuthorities: [], source: "inferred" } });
    await apply({ type: "commit_asset", commandId: "tail:commit", issuedAt: at, proposalId: "proposal:tail",
      versionId: "experience:tail", schemaVersion: 1, content });
    const dispatch = (id: string) => apply({ type: "record_collaboration_runtime", commandId: `collaboration-runtime:${id}`, issuedAt: at,
      receipt: { schemaVersion: 1, receiptId: id, phase: "dispatched", scope, owner, ownerFingerprint: experienceOwnerFingerprint(owner),
        versionIds: ["experience:tail"], recordedAt: at, boundary: { executionId: `execution:${id}`, taskId: "task:ordinary",
          round: 1, role: "personal_agent", requestId: `provider-request:${id}`, configurationRef: `configuration:${id}` } } });

    await dispatch("dispatch:first");
    await apply({ type: "record_collaboration_runtime", commandId: "collaboration-runtime:feedback:first", issuedAt: at,
      receipt: { schemaVersion: 1, receiptId: "feedback:first", phase: "use_feedback", scope, owner, versionIds: ["experience:tail"],
        usageReceiptId: "dispatch:first", outcome: "uncertain", summary: `Original workspace result ${join(scope, "result.txt")}; benefit remains unknown`,
        sourceRefs: Array.from({ length: 32 }, (_, index) => `business:evidence:${index}:${"x".repeat(138)}🙂${"x".repeat(140)}`), recordedAt: at } });
    await apply({ type: "coordinate_learning", commandId: "tail:claim", issuedAt: at, action: { kind: "claim", jobId,
      expectedAttempt: 0, claimId: "claim:tail", ownerId: "worker:tail", expiresAt: "2026-11-05T00:05:00.000Z" } });
    await apply({ type: "coordinate_learning", commandId: "tail:wait", issuedAt: at, action: { kind: "finish", jobId,
      claimId: "claim:tail", result: { kind: "waiting_dependency", dependencies: [{ dependencyId: "dependency:tail", owner: "tool",
        requestId: "request:approval", correlationRef: "correlation:tail", state: { kind: "waiting", reason: "Await external approval" } }] } } });
    await apply({ type: "coordinate_learning", commandId: "tail:authorized", issuedAt: at, action: { kind: "dependency",
      dependencyId: "dependency:tail", expectedRevision: 1, state: { kind: "authorized", authorizationRef: "approval:original" } } });
    const options = { boardRoot, scope, enabled: () => true, ports: [],
      nativeFeedbackChanges: (board: Awaited<ReturnType<typeof load>>) => projectOrganizationNativeFeedbackChanges(board, { scope, workspaceId: scope }),
      domainFeedback: async (board: Awaited<ReturnType<typeof load>>, selected: string) => projectOrganizationDomainFeedback(board, {
        scope, workspaceId: scope, issueId: selected, nativeChanges: projectOrganizationNativeFeedbackChanges(board, { scope, workspaceId: scope }) }) };
    const source = createCentralRuntimeSource(options), boardBefore = await load();
    const changes = options.nativeFeedbackChanges(boardBefore), quality = changes.find(row => row.factRef === "feedback:first")!;
    const dependency = changes.find(row => row.factRef === "dependency:tail")!;
    assert.ok(quality);
    assert.ok(dependency);
    const raw = await options.domainFeedback(boardBefore, issueId), selected = readOrganizationNativeFeedbackUnit(raw, quality);

    assert.equal(selected.kind, "found");
    if (selected.kind !== "found") return;

    const rawUnitText = canonicalJson(createNativeFeedbackUnitPublicView(quality, selected.recordKind, selected.payload));
    const snapshot = await source.snapshot(scope, signal, { subjects: [{ plane: "central", questionRef }], sourceRefs: [] });
    const wholeCatalog = snapshot.materials.find(row => row.ref.startsWith("central-runtime-domain-catalog:"));
    assert.ok(wholeCatalog);
    const wholeReadRef = JSON.parse(wholeCatalog.text).readRef as string;
    const firstUnit = (await source.read(scope, [nativeChangeReadRef(quality)], 3072, signal))[0]!;
    const firstWhole = (await source.read(scope, [wholeReadRef], 3072, signal))[0]!;
    const firstDependency = (await source.read(scope, [nativeChangeReadRef(dependency)], 600, signal))[0]!;
    const sourceArchive = createCentralPublicSourceFrames(options), unitPage = JSON.parse(firstUnit.text), wholePage = JSON.parse(firstWhole.text), depPage = JSON.parse(firstDependency.text);

    assert.ok(unitPage.nextRef);
    assert.ok(wholePage.nextRef);
    assert.ok(depPage.nextRef);
    const frozenUnit = await sourceArchive.read(unitPage.originalRef, signal), frozenWhole = await sourceArchive.read(wholePage.originalRef, signal);
    const frozenDependency = await sourceArchive.read(depPage.originalRef, signal);
    assert.ok(frozenUnit);
    assert.ok(frozenWhole);
    assert.ok(frozenDependency);

    for (const [first, ref, capacity] of [[firstUnit, unitPage.originalRef, 3072], [firstWhole, wholePage.originalRef, 3072], [firstDependency, depPage.originalRef, 600]] as const) {
      assert.equal(canonicalJson((await source.read(scope, [ref], capacity, signal))[0]), canonicalJson(first), "entry locator cannot alter fragment identity");
    }

    assert.ok(frozenUnit.text.length > 8192);
    assert.ok(frozenWhole.text.length > 8192);
    assert.equal(frozenUnit.origin.originalSourceHash, contentHashOf(rawUnitText));
    assert.notEqual(frozenUnit.origin.originalSourceHash, frozenUnit.publicTextHash);
    assert.notEqual(rawUnitText.length, frozenUnit.text.length);
    assert.ok(frozenUnit.text.includes("<workspace>"));
    assert.ok(!frozenUnit.text.includes(JSON.stringify(scope).slice(1, -1)));
    assert.equal(frozenUnit.publicTextHash, contentHashOf(frozenUnit.text));
    assert.notDeepEqual(frozenUnit.origin.originalCoordinate, frozenUnit.origin.publicCoordinate);
    const runtime = createCentralRuntimeStore(options), beforeDelivery = await runtime.read(scope);

    assert.deepEqual(beforeDelivery.state.materials, []);
    assert.deepEqual(beforeDelivery.state.consumedSourceRefs, []);
    const saved = await runtime.append({ previousRef: beforeDelivery.stateRef, expectedRevision: beforeDelivery.revision,
      state: { ...emptyCentralRuntimeState(scope), materials: [firstUnit, firstWhole, firstDependency] },
      reason: "Controlled delivery of the first fragments only", sourceRefs: ["delivery:first-fragments"] });
    assert.equal(saved.status, "written");
    assert.ok(!(await runtime.read(scope)).state.materials.some(row => row.ref === frozenUnit.ref || row.ref === frozenWhole.ref || row.ref === frozenDependency.ref));
    await dispatch("dispatch:second");
    await apply({ type: "record_collaboration_runtime", commandId: "collaboration-runtime:feedback:second", issuedAt: at,
      receipt: { schemaVersion: 1, receiptId: "feedback:second", phase: "use_feedback", scope, owner, versionIds: ["experience:tail"],
        usageReceiptId: "dispatch:second", outcome: "uncertain", summary: "A second original observation; benefit remains unknown",
        sourceRefs: ["business:second"], recordedAt: at } });
    await apply({ type: "coordinate_learning", commandId: "tail:ready", issuedAt: at, action: { kind: "dependency",
      dependencyId: "dependency:tail", expectedRevision: 2, state: { kind: "ready", resultRef: "tool-result:ready",
        resultVersion: "tool-version:ready", evidenceRefs: ["business:ready"] } } });
    const cold = createCentralRuntimeSource(options);
    const finish = async (first: CentralRuntimeMaterial, capacity: number) => {
      let page = JSON.parse(first.text), text = page.text as string, count = 0;
      const originalRef = page.originalRef as string;

      while (page.nextRef !== null) {
        const next = (await cold.read(scope, [page.nextRef], capacity, signal))[0]!;
        page = JSON.parse(next.text);
        assert.ok([...page.text as string].every(character => {
          const point = character.codePointAt(0)!;
          return point < 0xd800 || point > 0xdfff;
        }));
        assert.equal(page.originalRef, originalRef);
        assert.equal(page.start, text.length);
        text += page.text;
        assert.ok(++count < 64);
      }

      assert.equal(text.length, page.totalChars);
      return text;
    };
    const unitTail = await finish(firstUnit, 3072), wholeTail = await finish(firstWhole, 3072), dependencyTail = await finish(firstDependency, 600);

    assert.equal(unitTail, frozenUnit.text);
    assert.equal(wholeTail, frozenWhole.text);
    assert.equal(dependencyTail, frozenDependency.text);
    assert.equal(contentHashOf(unitTail), frozenUnit.publicTextHash);
    assert.equal(contentHashOf(wholeTail), frozenWhole.publicTextHash);
    const unit = JSON.parse(unitTail);
    assert.ok(isNativeFeedbackUnitPublicView(unit));
    assert.equal(unit.factRef, "feedback:first");
    assert.ok(!unitTail.includes("feedback:second"));
    const oldDependency = JSON.parse(dependencyTail);
    assert.ok(isNativeFeedbackUnitPublicView(oldDependency));
    assert.ok(dependencyTail.includes('"authorizationRef":"approval:original"'));
    assert.ok(!dependencyTail.includes("tool-result:ready"));
    const after = await cold.snapshot(scope, signal, { subjects: [{ plane: "central", questionRef }], sourceRefs: snapshot.sourceRefs });

    assert.ok(after.sourceRefs.includes("feedback:second"));
    assert.ok(after.sourceRefs.includes("dependency:tail:revision:3"));
    assert.ok(!after.sourceRefs.some(ref => ref.startsWith("central-public-source") || ref.startsWith("central-runtime-public-body:")));
    assert.deepEqual((await runtime.read(scope)).state.consumedSourceRefs, []);

    // Actual owner legacy mode advertises current native metadata, but supplies
    // no tuple rows. Only a separately authenticated dependency may bridge it.
    const currentBoard = await load(), currentChanges = options.nativeFeedbackChanges(currentBoard);
    const currentDependency = currentChanges.find(row => row.factRef === "dependency:tail")!;
    const legacyFrame = projectCollaborationCentralFeedback(currentBoard, { scope, issueId });

    assert.equal(readOrganizationNativeFeedbackUnit(legacyFrame, currentDependency).kind, "missing");
    const legacySource = createCentralRuntimeSource({ ...options, domainFeedback: async (board, selectedIssue) =>
      projectCollaborationCentralFeedback(board, { scope: board.learningIssues!.find(row => row.issueId === selectedIssue)!.scope, issueId: selectedIssue }) });
    const dependencyBody = (await legacySource.read(scope, [nativeChangeReadRef(currentDependency)], 12000, signal))[0]!;

    assert.equal(JSON.parse(dependencyBody.text).value.state.kind, "ready");
    await assert.rejects(legacySource.read(scope, [nativeChangeReadRef(quality)], 12000, signal), /central_runtime_source_missing/);

    const aliasScope = scope.includes("\\") ? scope.replaceAll("\\", "/") : `${scope}/.`;

    assert.notEqual(aliasScope, scope);
    assert.equal(await realpath(aliasScope), await realpath(scope));
    const coordinate = (key: string, action: CoordinationAction) => apply({ type: "coordinate_learning", commandId: key, issuedAt: at, action });
    const aliasIssue = "issue:alias-history", aliasBusiness = "issue:alias-business", primaryBusiness = "issue:primary-business";

    await coordinate("alias:report", { kind: "report", scope: aliasScope, issueId: aliasIssue, problemKey: "alias:history", report: {
      reportId: "report:alias", source: { kind: "research_request", domain: "collaboration", intentRef: questionRef, requestRef: "request:old-alias" },
      facts: ["Original alias source <workspace>/result.txt"], evidenceRefs: ["source:alias"] } });
    await coordinate("alias:focus", { kind: "decide", issueId: aliasIssue, expectedRevision: 1, decision: "focused_learning", reason: "Historical focus", sourceRefs: ["report:alias"] });
    const aliasFunded = await coordinate("alias:fund", { kind: "fund", issueId: aliasIssue, expectedRevision: 2, grantId: "grant:alias", domain: "collaboration",
      allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 5000, maxCalls: 1, maxSteps: 1, maxPromptChars: 4000 } });
    const aliasJob = aliasFunded.learningIssues!.find(row => row.issueId === aliasIssue)!.jobId!;

    await coordinate("alias:claim", { kind: "claim", jobId: aliasJob, expectedAttempt: 0, claimId: "claim:alias", ownerId: "worker:old-alias", expiresAt: "2026-11-05T00:05:00.000Z" });
    await coordinate("alias:wait", { kind: "finish", jobId: aliasJob, claimId: "claim:alias", result: { kind: "waiting_dependency", dependencies: [{
      dependencyId: "dependency:alias", owner: "tool", requestId: "request:alias-approval", correlationRef: "correlation:alias", state: { kind: "waiting", reason: "Original wait" } }] } });
    await coordinate("alias:authorize", { kind: "dependency", dependencyId: "dependency:alias", expectedRevision: 1,
      state: { kind: "authorized", authorizationRef: `${aliasScope}/approval.json` } });

    for (const [id, originalScope] of [[aliasBusiness, aliasScope], [primaryBusiness, scope]] as const) await coordinate(`business:${id}`, {
      kind: "report", scope: originalScope, issueId: id, problemKey: id, report: { reportId: `report:${id}`,
        source: { teamRunId: `team:${id}`, taskId: `task:${id}`, memberId: "personal_agent" }, facts: ["Original business observation"], evidenceRefs: [] } });

    let aliases: readonly string[] = [], sampled = 0, nominated = 0;
    const port: CentralLearningExecutionPort = { domain: "collaboration", async nominate() {
      nominated += 1;
      return [aliasBusiness, primaryBusiness];
    },

      async prepare() { throw new Error("read-only alias cannot prepare"); }, async dispatch() { throw new Error("read-only alias cannot dispatch"); },
      async observe() { throw new Error("read-only alias cannot observe worker"); } };
    const aliasMetadata = (board: Awaited<ReturnType<typeof load>>) => [scope, ...aliases]
      .flatMap(originalScope => projectOrganizationNativeFeedbackChanges(board, { scope: originalScope, workspaceId: originalScope }));
    const aliasOptions = { ...options, ports: [port], readCompatibleScopes: () => {
      sampled += 1;
      return aliases;
    }, nativeFeedbackChanges: aliasMetadata,

      domainFeedback: async (board: Awaited<ReturnType<typeof load>>, selectedIssue: string) => {
        const actual = board.learningIssues!.find(row => row.issueId === selectedIssue)!;
        return projectOrganizationDomainFeedback(board, { scope: actual.scope, workspaceId: actual.scope, issueId: selectedIssue, nativeChanges: aliasMetadata(board) });
      } };
    const aliasSource = createCentralRuntimeSource(aliasOptions);
    aliases = [aliasScope];
    const beforeSamples = sampled;
    const aliasOriginal = await aliasSource.read(scope, [aliasIssue, primaryBusiness], 16000, signal);

    assert.equal(sampled, beforeSamples + 1);
    assert.equal(JSON.parse(aliasOriginal[0]!.text).scope, aliasScope);
    const independent = await aliasSource.snapshot(scope, signal, { subjects: [{ plane: "central", questionRef }], sourceRefs: [],
      purposes: [{ subject: { plane: "central", questionRef }, sourceRefs: [] }] });

    assert.deepEqual(independent.opportunities.map(row => row.subject.plane === "agent" && row.subject.issueId), [primaryBusiness]);
    assert.ok(!independent.reconsider?.some(row => row.sourceRefs.includes("dependency:alias:revision:2")), "same-name alias purpose cannot subscribe itself");
    const aliasActor = await aliasSource.snapshot(scope, signal, { subjects: [{ plane: "agent", domain: "collaboration", issueId: aliasIssue }], sourceRefs: [],
      purposes: [{ subject: { plane: "agent", domain: "collaboration", issueId: aliasIssue }, sourceRefs: [aliasIssue] }] });

    assert.ok(!aliasActor.reconsider?.some(row => row.sourceRefs.includes("dependency:alias:revision:2")));
    const primaryPurpose = { plane: "central", questionRef: "question:new-primary-reader" } as const;
    const linked = await aliasSource.snapshot(scope, signal, { subjects: [primaryPurpose], sourceRefs: [], purposes: [{ subject: primaryPurpose, sourceRefs: [aliasIssue] }] });

    assert.ok(linked.reconsider?.some(row => row.sourceRefs.includes("dependency:alias:revision:2") && row.subject.plane === "central" && row.subject.questionRef === primaryPurpose.questionRef));
    const aliasChange = aliasMetadata(await load()).find(row => row.issueId === aliasIssue)!;
    const aliasFirst = (await aliasSource.read(scope, [nativeChangeReadRef(aliasChange)], 600, signal))[0]!, aliasPage = JSON.parse(aliasFirst.text);
    const aliasFrame = readRuntimePublicSourceFrame(await load(), { scope, ref: aliasPage.originalRef });
    assert.ok(aliasFrame);
    assert.equal(aliasFrame.origin.originalIssueScope, aliasScope);
    assert.ok(aliasFrame.text.includes("<workspace>/approval.json"));
    assert.equal(canonicalJson((await aliasSource.read(scope, [aliasFrame.ref], 600, signal))[0]), canonicalJson(aliasFirst));
    const fragmentHead = await runtime.read(scope);

    assert.equal((await runtime.append({ previousRef: fragmentHead.stateRef, expectedRevision: fragmentHead.revision,
      state: { ...fragmentHead.state, materials: [...fragmentHead.state.materials, aliasFirst] }, reason: "Controlled alias first-fragment delivery", sourceRefs: [aliasFirst.ref] })).status, "written");

    for (const ref of [aliasFrame.ref, aliasFirst.ref]) {
      const subscribed = await aliasSource.snapshot(scope, signal, { subjects: [primaryPurpose], sourceRefs: [], purposes: [{ subject: primaryPurpose, sourceRefs: [ref] }] });
      assert.ok(subscribed.reconsider?.some(row => row.sourceRefs.includes("dependency:alias:revision:2")), "canonical body/fragment origin binds the alias read only");
    }

    aliases = [];
    const historical = createCentralRuntimeSource(aliasOptions);

    assert.equal(canonicalJson((await historical.read(scope, [aliasPage.nextRef], 600, signal))[0]),
      canonicalJson((await aliasSource.read(scope, [aliasPage.nextRef], 600, signal))[0]));
    assert.ok(readRuntimePublicSourceFrame(await load(), { scope, ref: aliasFrame.ref }), "hint removal does not revoke committed history");
    await assert.rejects(historical.read(scope, [aliasIssue], 12000, signal), /central_runtime_source_missing|central_runtime_source_scope|central_runtime_source_forbidden/);
    assert.ok(nominated > 0);
    assert.equal((await load()).centralLearningGrants!.find(row => row.grantId === "grant:alias")!.scope, aliasScope);
    assert.deepEqual((await runtime.read(scope)).state.consumedSourceRefs, []);
  } finally {
    assert.equal(dirname(resolve(boardRoot)), resolve(tmpdir()));
    assert.ok(boardRoot.includes("central-source-tail-"));
    await rm(boardRoot, { recursive: true, force: true });
  }
});
