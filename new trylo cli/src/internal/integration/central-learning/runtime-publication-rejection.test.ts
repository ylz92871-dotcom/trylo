import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import type { ProviderPort, ProviderRequest } from "../../ports/provider.js";
import type { OrganizationDecision, OrganizationKnowledge } from "../../learning/central/organization/contracts.js";
import type { CentralDeliberationRequest, CentralLearningIntentDraft, CentralRuntimeMaterial,
  CentralRuntimeOrganizationPort, CentralRuntimeSourcePort } from "../../learning/central/runtime/contracts.js";
import { createCentralAccountingFundingAtRoot } from "../learning-content/central-accounting-funding.js";
import { ensureCentralLearningBudget } from "./budget.js";
import { createCentralModelDeliberation } from "./deliberation.js";
import { createCentralDeliberationReceiptsAtRoot } from "./deliberation-receipts.js";
import { createCentralOrganizationService } from "./organization-service.js";
import { createOrganizationFeedbackMaterial } from "./organization-feedback-material.js";
import { readOrganizationPublicationCondition } from "./organization-publication-material.js";
import { createCentralLearningDriver } from "./runtime-driver.js";
import { createCentralRuntimeOrganization } from "./runtime-organization.js";
import { createCentralRuntimeSource } from "./runtime-source.js";
import { createCentralRuntimeStore } from "./runtime-store.js";
import { OrganizationCasBusyError } from "./organization-cas.js";
import { emptyCentralRuntimeState } from "../../learning/central/runtime/records.js";
import { isCentralUnreadNavigationMaterial } from "../../learning/central/runtime/material-role.js";
import { createOrganizationKnowledgeView, readOrganizationKnowledgeView } from "./organization-publication-view.js";
import { publicationCorrectionFor } from "./runtime-publication-correction.js";
import { createOrganizationPublicationResults } from "./organization-publication-results.js";
import { readOrganizationPublicationRejection } from "./organization-publication-detail.js";
import type { CentralLearningChange } from "./change-contract.js";
import { readLearningChangeWire, learningChangeBody, learningChangeEvents, learningChangeFeedback,
  learningChangeIntent, learningChangeKnowledge, learningChangeRead } from "./change-test-support.js";

const scope = "workspace:publication-rejection", now = () => "2026-11-05T08:00:00.000Z";
const allowance = { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 300000, maxCalls: 8, maxSteps: 8, maxPromptChars: 100000 } as const;
const subject = { plane: "agent", domain: "prompt", issueId: "issue:premise" } as const;

test("a definite publication refusal preserves partial facts and the delivered agenda across restart and permits only one informed correction per condition", { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "trylo-publication-rejection-"));
  const options = { boardRoot: root, scope, enabled: () => true }, signal = new AbortController().signal;
  const drivers: ReturnType<typeof createCentralLearningDriver>[] = [];

  try {
    const report = async (id: string, fact = "Check the duration premise before procedure comparison.", reportIssueId: string = subject.issueId) => {
      const result = await withBoardWriter(root, board => board.apply({ type: "coordinate_learning", commandId: id, issuedAt: now(), action: {
        kind: "report", scope, issueId: reportIssueId, problemKey: reportIssueId === subject.issueId ? "duration-premise" : "unrelated-layout", report: { reportId: id,
          source: { subsystem: "method", taskId: "task:premise", versionId: "method:original" },
          facts: [fact], evidenceRefs: [id] } } }));
      assert.ok(result.ok);
    };

    await report("report:original");
    await report("report:unrelated", "An unrelated layout question awaits real use.", "issue:unrelated");
    const service = createCentralOrganizationService(options);
    const publicationReader = createCentralRuntimeOrganization({ ...options, service });
    const readOrganization = async () => { const view = await service.read();
    assert.equal(view.status, "ready");
      if (view.status !== "ready") throw new Error("original organization unavailable");
    return view; };
    const prior: OrganizationDecision = { kind: "decision", decisionRef: "decision:original", purposeRef: "intent:premise",
      context: { purpose: "Check the duration premise", conditionKeys: ["domain:prompt"], known: [], residual: ["Unknown premise"] },
      program: { programRef: "program:original", depth: "Read the original premise", timing: "now" },
      expectation: { change: "Identify the actual duration boundary", uncertainties: ["Actual downstream benefit"] },
      alternatives: ["Compare without a premise"], issueRefs: [subject.issueId], stageRefs: [], sourceRefs: ["report:original"], experienceUse: null };

    assert.equal((await service.freezeDecision(prior, (await readOrganization()).revision)).status, "saved");
    const feedback: CentralRuntimeMaterial[] = [], support: string[] = [];

    for (let index = 0; index < 3; index += 1) {
      const value = { kind: "feedback" as const, decisionRef: prior.decisionRef, unitRef: `observation:${index}`, supersedes: null,
        sourceRefs: ["report:original"], result: { kind: "progress" as const, summary: `Original duration observation ${index}`,
          remaining: ["Actual business effect remains unknown"], resultRefs: [`result:${index}`] } };
      const saved = await service.observe(value, (await readOrganization()).revision);
      assert.equal(saved.status, "saved");
      if (saved.status !== "saved") throw new Error("seed observation not saved");
      support.push(saved.factId);
      feedback.push(createOrganizationFeedbackMaterial(scope, saved.factId, value));
    }

    const knowledge: OrganizationKnowledge = { kind: "knowledge", knowledgeId: "duration-check-premise-first", supersedes: null,
      statement: "Check the duration premise before procedure comparison", conditions: "Unknown duration premise", conditionKeys: ["domain:prompt"],
      exceptions: "The original premise is already verified", exceptionKeys: [], implication: "Read the actual prerequisite first",
      supportFactIds: support, counterexampleFactIds: [], state: "proposed" };
    const originalKnowledge = await service.reviseKnowledge(knowledge, (await readOrganization()).revision);
    assert.equal(originalKnowledge.status, "saved");

    if (originalKnowledge.status !== "saved") throw new Error("seed knowledge not saved");

    const originalHead = (await readOrganization()).projection.knowledge.find(row => row.factId === originalKnowledge.factId);
    assert.ok(originalHead);
    const originalHeadMaterial = createOrganizationKnowledgeView(scope, originalHead);
    let competingHead = { factId: originalKnowledge.factId, value: knowledge };
    const advanceHead = async (value: OrganizationKnowledge, factId: string, statement: string) => {
      const next = { ...value, supersedes: factId, statement, state: "revised" as const };
      const saved = await service.reviseKnowledge(next, (await readOrganization()).revision);
      assert.equal(saved.status, "saved");
      if (saved.status !== "saved") throw new Error("concurrent original head was not saved");
      return { factId: saved.factId, value: next };
    };
    const budget = await ensureCentralLearningBudget({ ...options, allowance, authorizationRef: "authorization:explicit", now });
    assert.ok(budget.ok);
    const configuration = { schemaVersion: 1, configurationRef: "configuration:explicit", authorizationRef: "authorization:explicit",
      allowance, rootRef: budget.rootRef } as const;
    const funding = createCentralAccountingFundingAtRoot({ ...options, budgetId: budget.projection.budget.budgetId, now,
      owner: { kind: "central_deliberation", ownerId: "central:publication-rejection" } });
    const receipts = createCentralDeliberationReceiptsAtRoot({ ...options, budgetId: budget.projection.budget.budgetId });
    const store = createCentralRuntimeStore(options), inputs: CentralDeliberationRequest[] = [], wires: ProviderRequest[] = [], sourceReads: string[] = [];
    const models: ReturnType<typeof createCentralModelDeliberation>[] = [];
    let current: CentralDeliberationRequest | undefined, calls = 0, aggregateKnowledge: OrganizationKnowledge | undefined;
    let aggregateFactId: string | undefined, acceptedKnowledgeId: string | undefined;
    let fixtureFailure: unknown;
    const waiting: CentralLearningIntentDraft = { intentId: "intent:premise", subject, goal: "Check the duration premise before procedure comparison",
      rationale: "The original report identifies an unknown prerequisite", conditions: ["Unknown duration premise"], knowledge: [], residual: ["Actual use effect"],
      commitment: { purpose: "Preserve the original research question", assumptions: [], reconsiderWhen: ["Real later use arrives"] },
      revisionReason: "Preserve the original goal while waiting for business evidence", sourceRefs: ["report:original"],
      continuation: { kind: "waiting", wait: { kind: "use_feedback", reason: "Await real later use", sourceRefs: ["report:original"] } } };
    const unrelated: CentralLearningIntentDraft = { ...waiting, intentId: "intent:unrelated", subject: { ...subject, issueId: "issue:unrelated" },
      goal: "Study the unrelated layout question", sourceRefs: ["report:unrelated"],
      continuation: { kind: "waiting", wait: { kind: "facts", reason: "Await original layout evidence", sourceRefs: ["report:unrelated"] } } };
    const originalRuntime = await store.read(scope);

    assert.equal((await store.append({ expectedRevision: originalRuntime.revision, previousRef: originalRuntime.stateRef,
      state: { ...originalRuntime.state, intents: [waiting, unrelated] }, reason: "test_original_business_waits", sourceRefs: ["report:original", "report:unrelated"] })).status, "written");
    const provider: ProviderPort = { async *stream() { throw new Error("the business provider must not be reused"); }, fork: () => ({
      async *stream(request) {
        try {
          assert.ok(current);
          calls += 1;
          wires.push(request);
          assert.ok(calls <= 4, "the same publication conflict cannot buy an unlimited repair loop");
          const view = readLearningChangeWire(request);
          const purpose = learningChangeIntent(view, waiting.goal);
          const body = learningChangeBody(view, current.materials.find(material => material.ref === "report:original")!.text).handle;
          const evidence = (refs: readonly string[]) => refs.map(ref => learningChangeFeedback(view, ref));
          let output: CentralLearningChange;

          if (calls <= 2) {
            if (calls === 1) {
              // The model may revise only the advertised old head. A genuine
              // concurrent writer advances it before publication, preserving the
              // original conflict without letting the model choose knowledge IDs.
              competingHead = await advanceHead(knowledge, originalKnowledge.factId, "Concurrent original duration premise head");
            }

            if (calls === 2) {
              const conditions = [...current.materials, ...current.organization].filter(material => readOrganizationPublicationCondition(material, scope) !== undefined);
              assert.equal(conditions.length, 1);
              assert.match(JSON.stringify(request.messages), /organization_knowledge_publication_condition_not_published/);
              assert.match(JSON.stringify(request.messages), /organization_knowledge_candidate_rejected_not_published/);
              assert.match(JSON.stringify(request.messages), new RegExp(competingHead.factId));
              await advanceHead(aggregateKnowledge!, aggregateFactId!, "Concurrent aggregate planning-cost head");
            }

            const condition = [...current.materials, ...current.organization].find(material => readOrganizationPublicationCondition(material, scope) !== undefined);

            output = { checkpoint: view.checkpoint, changes: calls === 1 ? [] : [{ kind: "revise", target: purpose,
              why: "Read the advertised original head before choosing an explicit revision", set: { next: { kind: "read",
                purpose: "Inspect the original knowledge head", expectedChange: "Compare its actual statement and source conditions",
                sources: [body],
                refs: [learningChangeRead(view, (JSON.parse(condition!.text) as { readRef: string }).readRef)], maximumChars: 20000 } } }],
              explanation: "Preserve the legitimate business wait; publish only accepted hypotheses", sources: [body], organizationKnowledge: [
                ...(calls === 1 ? [{ kind: "propose" as const, key: "accepted-before-refusal", statement: knowledge.statement,
                  conditions: knowledge.conditions, conditionKeys: knowledge.conditionKeys, exceptions: knowledge.exceptions,
                  exceptionKeys: knowledge.exceptionKeys, implication: knowledge.implication, support: evidence(support) }] : []),
                ...(calls === 2 ? [{ kind: "revise" as const, target: learningChangeKnowledge(view, aggregateFactId!),
                  why: "Check attribution of aggregate planning cost", set: { statement: "A reworded hypothesis supported only by aggregate agenda cost",
                    support: evidence(aggregateKnowledge!.supportFactIds) } }] : []),
                { kind: "revise", target: learningChangeKnowledge(view, originalKnowledge.factId), why: "Compare the original duration hypothesis",
                  set: { statement: calls === 1 ? "A shorter duration premise proposal" : "A reworded duration premise proposal",
                    support: evidence(calls === 1 ? support.slice(0, 2) : support.slice(0, 2).reverse()) } },
              ] };
          } else if (calls === 3) {
            const head = current.materials.map(material => readOrganizationKnowledgeView(material, scope)).find(value => value?.factId === competingHead.factId);

            assert.ok(head, "the selected read must return the real original head through the production read route");
            output = { checkpoint: view.checkpoint, changes: [{ kind: "revise", target: purpose, why: waiting.revisionReason,
              set: { next: { kind: "wait", for: "use_feedback", reason: "Await real later use", sources: [body] } } }],
              explanation: "The original head supports an explicit source-bound revision", sources: [body],
              organizationKnowledge: [{ kind: "revise", target: learningChangeKnowledge(view, head.factId), why: "Bind the explicit source revision",
                set: { statement: "A source-bound explicit revision", support: evidence(support) } }] };
          } else {
            assert.ok(current.materials.some(material => material.ref === "report:later-real-use"));
            const accepted = (await readOrganization()).projection.knowledge.find(row => row.value.knowledgeId === acceptedKnowledgeId);
            assert.ok(accepted);
            await advanceHead(accepted.value, accepted.factId, "Concurrent accepted-head revision");
            output = { checkpoint: view.checkpoint, changes: [{ kind: "end", target: purpose, goalState: "withdrawn", why: "User withdrawal is final for this purpose" }],
              explanation: "Explicitly revise the original knowledge and respect withdrawal",
              sources: [learningChangeBody(view, current.materials.find(material => material.ref === "report:later-real-use")!.text).handle],
              organizationKnowledge: [{ kind: "revise", target: learningChangeKnowledge(view, accepted.factId), why: "Check the now-stale accepted head",
                set: { statement: "A final refused revision while withdrawn", support: evidence(support) } }] };
          }

          yield* learningChangeEvents(output);
        } catch (error) {
          fixtureFailure = error;
          throw error;
        }
      },
    }) };
    const source: CentralRuntimeSourcePort = { async snapshot() {
      const loaded = await createBoardReader(root).load();
      assert.ok(loaded.ok);
      const issues = loaded.state.learningIssues ?? [];
      assert.ok(issues.some(row => row.issueId === subject.issueId));
      const reports = issues.flatMap(issue => issue.reports.map(row => ({ ref: row.reportId, kind: "source" as const, text: row.facts.join("\n"), sourceRefs: [row.reportId] })));

      return { boardSequence: loaded.state.sequence, opportunities: [{ subject, sourceRef: "report:original", description: waiting.goal, constraints: [] },
        { subject: unrelated.subject, sourceRef: "report:unrelated", description: unrelated.goal, constraints: [] }],
        materials: [...reports, ...feedback, originalHeadMaterial, ...(await readOrganization()).projection.knowledge
          .filter(row => row.value.knowledgeId === aggregateKnowledge?.knowledgeId || row.value.knowledgeId === acceptedKnowledgeId)
          .map(row => createOrganizationKnowledgeView(scope, row))], sourceRefs: reports.map(row => row.ref) };
    }, async read(_scope, refs, maximumChars, requestSignal) {
      sourceReads.push(...refs);
      return createCentralRuntimeSource({ ...options, ports: [] }).read(scope, refs, maximumChars, requestSignal);
    } };
    const make = (input: { crashAfterRecord?: boolean; navigationOnly?: boolean; recallBusy?: () => boolean;
      publicationBusy?: () => boolean; busyRevision?: () => number | undefined } = {}) => {
      const model = createCentralModelDeliberation({ provider, model: "scripted-local", funding, receipts, maxOutputTokens: 4096 });

      models.push(model);
      const original = createCentralRuntimeOrganization({ ...options, service });
      let crash = input.crashAfterRecord === true;
      const organization: CentralRuntimeOrganizationPort = { ...original, async recall(request) {
        if (input.recallBusy?.()) throw new OrganizationCasBusyError("recall", input.busyRevision?.());
        return original.recall(request);
      }, async recordDecision(request, requestSignal) {
        if (input.publicationBusy?.()) throw new OrganizationCasBusyError("publication");

        const result = await original.recordDecision!(request, requestSignal);

        if (crash && request.role === "deliberation") {
          const recorded = await original.readPublicationCorrection!({ scope, state: { ...request.request.state, intents: request.output.intents },
            consumedSourceRefs: request.request.state.consumedSourceRefs }, requestSignal);
          assert.ok(recorded.some(material => readOrganizationPublicationCondition(material, scope) !== undefined),
            "simulate exit only after the original publication-result receipt is actually readable");
          crash = false;
          throw new Error("simulated_scope_exit_after_delivery_and_publication_result");
        }

        return result;
      } };
      const driver = createCentralLearningDriver({ ...options, now, source, organization,
        execution: { async consult() { throw new Error("not consulted"); }, async prepare() { throw new Error("not dispatched"); },
          async execute() { throw new Error("not executed"); }, async recover() { return null; } },
        deliberation: { ...model, async deliberate(request, requestSignal) {
          inputs.push(request);
          current = request;
          const result = await model.deliberate(request, requestSignal);
          if (calls === 1) {
            acceptedKnowledgeId = result.organizationKnowledge?.[0]?.knowledgeId;
            assert.ok(acceptedKnowledgeId);
          }
          return result;
        },

          ...(input.navigationOnly === true ? { async prepareDelivery(request: CentralDeliberationRequest, requestSignal: AbortSignal) {
            const prepared = await model.prepareDelivery!(request, requestSignal);
            const replace = (material: CentralRuntimeMaterial) => readOrganizationPublicationCondition(material, scope) === undefined ? material : {
              ref: `navigation:${material.ref}`, kind: material.kind, text: JSON.stringify({ role: "central_source_body_not_delivered", readRef: material.ref }), sourceRefs: [material.ref] };
            return { ...prepared, materials: prepared.materials.map(replace), organization: prepared.organization.map(replace) };
          } } : {}),
        } });
      drivers.push(driver);
      return driver;
    };
    const driveInput = { scope, configuration, signal, wake: { reason: "original-source", sourceRefs: [] }, publish() {} };
    let recallContended = true, observedRevision = (await readOrganization()).revision;
    const first = make({ crashAfterRecord: true, recallBusy: () => recallContended, busyRevision: () => observedRevision });

    assert.equal((await first.drive(driveInput)).wakeAt, Date.parse(now()) + 2500);
    assert.equal(calls, 0);
    assert.equal((await first.drive(driveInput)).wakeAt, undefined, "no new physical revision cannot perpetually arm mechanical retries");
    assert.equal((await service.freezeDecision({ ...prior, decisionRef: "decision:physical-writer", purposeRef: "purpose:unrelated-writer", issueRefs: [] }, observedRevision)).status, "saved");
    observedRevision = (await readOrganization()).revision;
    assert.equal((await first.drive(driveInput)).wakeAt, Date.parse(now()) + 2500, "a verified later physical prefix permits one further mechanical backoff");
    assert.equal(calls, 0, "physical writer activity creates no paid learning call");
    recallContended = false;
    await assert.rejects(first.drive(driveInput), /simulated_scope_exit_after_delivery_and_publication_result/);
    assert.equal(calls, 1);
    const partial = await readOrganization();
    assert.ok(partial.projection.knowledge.some(row => row.value.knowledgeId === acceptedKnowledgeId));
    assert.equal(partial.projection.knowledge.find(row => row.value.knowledgeId === knowledge.knowledgeId)?.factId, competingHead.factId);
    const decisionsBeforeRestart = partial.projection.decisions.map(row => row.factId);

    await first.close?.();
    const aggregateDecision = partial.projection.decisions.find(row => row.value.purposeRef === inputs[0]!.operation.operationId);
    assert.ok(aggregateDecision);
    assert.ok(aggregateDecision.value.issueRefs.includes(subject.issueId) && aggregateDecision.value.issueRefs.includes("issue:unrelated"));
    const originalReceipt = await receipts.read(inputs[0]!.operation.operationId, signal);
    assert.ok(originalReceipt);
    const aggregateFeedback = { kind: "feedback" as const, decisionRef: aggregateDecision.value.decisionRef, unitRef: "aggregate:actual-planning-cost", supersedes: null,
      sourceRefs: [originalReceipt.deliveryRef], result: { kind: "cost" as const, usage: { kind: "reported" as const, tokens: 160, calls: 1, steps: 1 } } };
    const aggregateObserved = await service.observe(aggregateFeedback, (await readOrganization()).revision);
    assert.equal(aggregateObserved.status, "saved");

    if (aggregateObserved.status !== "saved") throw new Error("original aggregate feedback not saved");

    feedback.push(createOrganizationFeedbackMaterial(scope, aggregateObserved.factId, aggregateFeedback));
    aggregateKnowledge = { ...knowledge, knowledgeId: "knowledge:aggregate-cost", statement: "A scope-level planning-cost hypothesis",
      supportFactIds: [aggregateObserved.factId] };
    const aggregateSaved = await service.reviseKnowledge(aggregateKnowledge, (await readOrganization()).revision);
    assert.equal(aggregateSaved.status, "saved");

    if (aggregateSaved.status !== "saved") throw new Error("aggregate knowledge not saved");
    aggregateFactId = aggregateSaved.factId;
    let publicationContended = true;
    const capacity = make({ navigationOnly: true, publicationBusy: () => publicationContended });
    const busy = await capacity.drive(driveInput);
    assert.equal(busy.reason, "central_organization_busy_publication");
    assert.ok(busy.wakeAt);
    assert.equal(calls, 1);
    publicationContended = false;
    const blocked = await capacity.drive(driveInput);

    assert.equal(blocked.state, "waiting");
    assert.match(blocked.reason, /context_capacity/);
    assert.equal(calls, 1);
    const recovered = await store.read(scope);
    assert.deepEqual(recovered.state.intents, [waiting, unrelated]);
    assert.deepEqual((await readOrganization()).projection.decisions.map(row => row.factId), decisionsBeforeRestart);
    const correctionMaterials = await publicationReader.readPublicationCorrection!({ scope, state: recovered.state,
      consumedSourceRefs: recovered.history.consumedSourceRefs }, signal);
    const condition = correctionMaterials.find(material => readOrganizationPublicationCondition(material, scope) !== undefined);
    assert.ok(condition);
    assert.ok(!recovered.state.materials.some(material => material.ref.startsWith("organization-publication-")),
      "the original result receipt preserves refusal details without requiring space in the legal agenda checkpoint");
    assert.ok(isCentralUnreadNavigationMaterial(condition));

    for (const material of correctionMaterials.filter(row => row.ref.startsWith("organization-publication-rejection:") || row.ref.startsWith("organization-candidate-view:"))) {
      assert.ok(isCentralUnreadNavigationMaterial(material), "a refusal or unpublished proposal is not original business grounding");
    }

    assert.ok(!recovered.history.consumedSourceRefs.includes(condition.ref), "an opaque navigation does not consume the informed repair opportunity");
    const accountingAfterRecovery = await funding.inspect();
    assert.ok(accountingAfterRecovery.ok);

    if (accountingAfterRecovery.ok) assert.equal(accountingAfterRecovery.projection.occupied.calls, 1);

    const conditionBody = JSON.parse(condition.text) as { readRef: string };
    const head = await source.read(scope, [conditionBody.readRef], 100000, signal);

    assert.ok(head.some(material => material.text.includes(competingHead.factId)));
    assert.ok(head.every(material => !isCentralUnreadNavigationMaterial(material)), "the complete original head remains an actual organizing hypothesis body");
    await capacity.close?.();
    const beforeCompaction = await store.read(scope);

    assert.equal((await store.append({ expectedRevision: beforeCompaction.revision, previousRef: beforeCompaction.stateRef,
      state: { ...beforeCompaction.state, materials: [] }, reason: "test_original_bodies_leave_working_set", sourceRefs: [] })).status, "written");
    const resumed = make();
    await resumed.drive(driveInput);
    assert.equal(calls, 2);
    const afterRepair = await store.read(scope);
    assert.ok(afterRepair.history.consumedSourceRefs.includes(condition.ref));
    const repairDelivery = await receipts.read(inputs[1]!.operation.operationId, signal);
    assert.ok(repairDelivery);
    const repairResult = await createOrganizationPublicationResults(options).read(inputs[1]!.operation.operationId,
      budget.projection.budget.budgetId, repairDelivery.deliveryRef, signal);
    assert.ok(repairResult);
    assert.ok(repairResult.value.entries.some(entry => entry.candidateIndex === 0), "the aggregate proposal must have its own actual publication refusal");
    const aggregateReturn = await source.read(scope, [`organization-publication-return:${repairResult.factId.slice("organization-publication-result:".length)}:0`], 100000, signal);
    const aggregateRefusal = aggregateReturn.map(material => readOrganizationPublicationRejection(material, scope)).find(value => value !== undefined);

    assert.equal(aggregateRefusal?.bindings.state, "unbound", "a real agenda's A/B issue collection cannot attribute aggregate planning cost to either purpose");
    assert.deepEqual((await readOrganization()).projection.knowledge.find(row => row.value.knowledgeId === knowledge.knowledgeId)?.value, competingHead.value);
    await resumed.drive(driveInput);
    assert.equal(calls, 2);
    assert.ok(sourceReads.includes(conditionBody.readRef));
    await resumed.drive(driveInput);
    assert.equal(calls, 3, "the actual committed read has one original interpretation");

    if (fixtureFailure !== undefined) throw fixtureFailure;

    assert.ok(await receipts.read(inputs[2]!.operation.operationId, signal), JSON.stringify(models.flatMap(model => model.receipts())
      .map(receipt => ({ response: receipt.response, reason: receipt.reason }))));

    for (let index = 0; index < 2; index += 1) await resumed.drive(driveInput);

    assert.equal(calls, 3, "same conflict with changed wording and support order does not create another repair loop");
    await report("report:later-real-use", "A real later task found the original duration premise before comparison; downstream benefit remains unknown.");
    await resumed.drive(driveInput);
    assert.equal(calls, 4);
    const final = await readOrganization();
    const revised = final.projection.knowledge.find(row => row.value.knowledgeId === knowledge.knowledgeId);
    assert.ok(revised);
    assert.equal(revised.value.supersedes, competingHead.factId);
    assert.equal(revised.value.state, "revised");

    for (let index = 0; index < 2; index += 1) await resumed.drive(driveInput);

    assert.equal(calls, 4, "an unrelated active purpose cannot revive the withdrawn purpose's refusal");
    const finalCursor = await store.read(scope);
    const finalMaterials = await publicationReader.readPublicationCorrection!({ scope, state: finalCursor.state,
      consumedSourceRefs: finalCursor.history.consumedSourceRefs }, signal);

    assert.equal(publicationCorrectionFor(finalCursor.state, finalMaterials, finalCursor.history.consumedSourceRefs), undefined);
    const activeAgain = { ...finalCursor.state, intents: [waiting, unrelated] };
    const relatedMaterials = await publicationReader.readPublicationCorrection!({ scope, state: activeAgain,
      consumedSourceRefs: finalCursor.history.consumedSourceRefs }, signal);
    const relatedAfterUnbound = publicationCorrectionFor(activeAgain, relatedMaterials, finalCursor.history.consumedSourceRefs);

    assert.equal(readOrganizationPublicationCondition(relatedAfterUnbound!.materials[0]!, scope)?.knowledgeId, acceptedKnowledgeId,
      "an earlier unbound aggregate condition cannot hide the later precisely owned condition");
    assert.deepEqual(relatedAfterUnbound!.purposes.map(purpose => purpose.intentId), [waiting.intentId]);
    const finalFunding = await funding.inspect();
    assert.ok(finalFunding.ok);

    if (finalFunding.ok) {
      assert.equal(finalFunding.projection.occupied.calls, 4);
      assert.equal(finalFunding.projection.occupied.tokens, 640);
    }

    assert.equal(wires.length, 4);
    assert.equal(inputs.length, 4);
    assert.ok((await store.read(scope)).history.materials.some(row => row.ref.startsWith("organization-publication-rejection:")));
  } finally {
    await Promise.all(drivers.map(driver => driver.close?.()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^trylo-publication-rejection-/);
    await rm(root, { recursive: true, force: true });
  }
});

test("definitely unwritten async result feedback waits without losing completion or dispatching the worker again", { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "trylo-publication-busy-"));
  const options = { boardRoot: root, scope, enabled: () => true }, store = createCentralRuntimeStore(options);
  let driver: ReturnType<typeof createCentralLearningDriver> | undefined;
  let releaseWorker = () => {};

  try {
    const initial = await store.read(scope), operation = { kind: "dispatch", operationId: "operation:worker", purpose: "Read the original premise",
      expectedChange: "Identify the original prerequisite", sourceRefs: ["report:worker"], allowance } as const;
    const intent: CentralLearningIntentDraft = { intentId: "intent:worker", subject, goal: operation.purpose, rationale: "Original condition",
      conditions: [], knowledge: [], residual: ["Original prerequisite"], commitment: { purpose: operation.purpose, assumptions: [], reconsiderWhen: [] },
      revisionReason: "Original committed work", sourceRefs: operation.sourceRefs, continuation: { kind: "ready", operation } };

    assert.equal((await store.append({ previousRef: initial.stateRef, expectedRevision: initial.revision,
      state: { ...emptyCentralRuntimeState(scope), intents: [intent] }, reason: "test_original_committed_worker", sourceRefs: operation.sourceRefs })).status, "written");
    let complete!: () => void, published!: () => void;
    const resultReady = new Promise<void>(resolve => {
      complete = resolve;
      releaseWorker = resolve;
    }), busyPublished = new Promise<void>(resolve => { published = resolve; });
    let executions = 0, interpretations = 0, repaired = false;
    const feedback: CentralRuntimeMaterial = { ref: "feedback:original-worker", kind: "organization", text: "The original completion was recovered; business benefit is unknown.", sourceRefs: [operation.operationId] };

    driver = createCentralLearningDriver({ ...options, now,
      source: { async snapshot() { return { boardSequence: 0, opportunities: [], materials: [], sourceRefs: [] }; }, async read() { return []; } },
      organization: { async recall() { return []; }, async recordResult() { throw new OrganizationCasBusyError("result"); },

        async recoverResults() {
          const current = await store.read(scope);
          if (!current.state.completed.some(row => row.operation.operationId === operation.operationId)) return [];
          repaired = true;
          return current.history.materials.some(row => row.ref === feedback.ref) ? [] : [feedback];
        } },
      execution: { async consult() { throw new Error("not consulted"); }, async prepare(input) {
        return { intentId: input.intent.intentId, operation: input.operation, workRef: "work:original", frame: { original: "receipt:worker" } };
      }, async execute() {
        executions += 1;
        await resultReady;
        return { outcome: "returned", publicResult: "Original worker result", resultRefs: ["receipt:worker"] };
      },

      async recover() { throw new Error("the completed worker must never be recovered or dispatched again"); } },
      deliberation: { async deliberate(request) {
        interpretations += 1;
        assert.ok(repaired);
        assert.ok(request.materials.some(material => material.ref === feedback.ref));
        return { schemaVersion: 1, intents: [{ ...intent, revisionReason: "The original worker completed; wait for real use",
          continuation: { kind: "waiting", wait: { kind: "use_feedback", reason: "Actual use remains unknown", sourceRefs: operation.sourceRefs } } }],
          publicExplanation: "Keep completion distinct from effect", sourceRefs: operation.sourceRefs };
      } } });
    const input = { scope, configuration: { schemaVersion: 1, configurationRef: "configuration:worker", authorizationRef: "authorization:worker", allowance } as const,
      signal: new AbortController().signal, wake: { reason: "original-work", sourceRefs: operation.sourceRefs }, publish(value: { reason: string; wakeAt?: number }) {
        assert.equal(value.reason, "central_organization_busy_result");
        assert.ok(value.wakeAt);
        published();
      } };

    await driver.drive(input);
    complete();
    await busyPublished;
    const completed = await store.read(scope);
    assert.equal(completed.state.running.length, 0);
    assert.equal(completed.state.completed.find(row => row.operation.operationId === operation.operationId)?.outcome, "returned");
    assert.equal(executions, 1);
    assert.equal(interpretations, 0);
    await driver.drive(input);
    assert.equal(executions, 1);
    assert.equal(interpretations, 1);
    await driver.drive(input);
    assert.equal(executions, 1);
    assert.equal(interpretations, 1);
  } finally {
    releaseWorker();
    await driver?.close?.();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^trylo-publication-busy-/);
    await rm(root, { recursive: true, force: true });
  }
});
