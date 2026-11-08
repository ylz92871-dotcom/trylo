import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import type { CentralDeliberationOutput, CentralDeliberationRequest, CentralLearningIntentDraft,
  CentralRuntimeExecutionPort } from "../../learning/central/runtime/contracts.js";
import { createCentralRuntimeSource } from "./runtime-source.js";
import { createCentralLearningDriver } from "./runtime-driver.js";
import { createCentralOrganizationService } from "./organization-service.js";
import { createCentralRuntimeOrganization } from "./runtime-organization.js";
import { createCentralRuntimeStore } from "./runtime-store.js";
import { readOrganizationFeedbackMaterial } from "./organization-feedback-material.js";

const scope = "workspace:runtime-progress-journey", now = () => "2026-11-05T00:00:00.000Z";
const allowance = { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 10000, maxCalls: 16, maxSteps: 16, maxPromptChars: 20000 } as const;
const signal = new AbortController().signal;

test("an actual prerequisite read repairs both publication gaps, supports knowledge and changes the next task program", async () => {
  const root = await mkdtemp(join(tmpdir(), "trylo-runtime-progress-"));
  assert.equal(dirname(root), resolve(tmpdir()));
  const options = { boardRoot: root, scope, enabled: () => true };
  const drivers: ReturnType<typeof createCentralLearningDriver>[] = [];

  try {
    const report = async (id: string, fact: string) => {
      const written = await withBoardWriter(root, store => store.apply({ type: "coordinate_learning", commandId: `report:${id}`, issuedAt: now(),
        action: { kind: "report", scope, issueId: id, problemKey: `declared-schema-prerequisite:${id}`,
          report: { reportId: `report:${id}`, source: { subsystem: "method", taskId: `task:${id}`, versionId: "method:original" },
            facts: [fact], evidenceRefs: [`execution:${id}`] } } }));
      assert.ok(written.ok);
    };

    await report("issue:first", "A declared schema is a prerequisite for comparing document validation procedures.");
    const service = createCentralOrganizationService(options), source = createCentralRuntimeSource({ ...options, ports: [] });
    const execution: CentralRuntimeExecutionPort = {
      async consult() { throw new Error("the learned program must read prerequisites instead of consulting comparisons"); },
      async prepare() { throw new Error("no domain dispatch is needed in this bounded local journey"); },
      async execute() { throw new Error("no worker is launched"); }, async recover() { return null; },
    };
    const configuration = { schemaVersion: 1, configurationRef: "configuration:explicit", authorizationRef: "authorization:explicit", allowance } as const;
    const input = { scope, configuration, signal, wake: { reason: "original-source", sourceRefs: [] }, publish() {} };
    let calls = 0, prior: CentralLearningIntentDraft | undefined;
    const receipts = new Map<string, { request: CentralDeliberationRequest; output: CentralDeliberationOutput }>();
    const model = {
      async deliberate(request: CentralDeliberationRequest): Promise<CentralDeliberationOutput> {
        calls++;
        let output: CentralDeliberationOutput;

        if (calls === 1) {
          const opportunity = request.opportunities.find(row => row.subject.plane === "agent" && row.subject.issueId === "issue:first");
          assert.ok(opportunity);
          prior = { intentId: "intent:first", subject: opportunity.subject, goal: "Identify the missing declared schema prerequisite",
            rationale: "Inspect the original source before comparing procedures", conditions: ["The schema premise is unknown"], knowledge: [],
            residual: ["Which input contract is missing?"], commitment: { purpose: "Read the prerequisite", assumptions: [], reconsiderWhen: ["Original condition changes"] },
            revisionReason: "Start from the actual original report", sourceRefs: [opportunity.sourceRef], continuation: { kind: "ready", operation: {
              kind: "read", operationId: "operation:read-prerequisite", purpose: "Read the unknown declared schema premise",
              expectedChange: "Find the prerequisite before comparing procedures", sourceRefs: [opportunity.sourceRef], refs: [opportunity.sourceRef], maximumChars: 12000 } } };
          output = { schemaVersion: 1, intents: [prior], publicExplanation: "Inspect the original prerequisite", sourceRefs: [opportunity.sourceRef] };
        } else if (calls === 2) {
          assert.ok(prior);
          assert.ok(request.materials.some(row => row.text.includes("A declared schema is a prerequisite")), "the actual persisted report body was read");
          const progress = [...request.materials, ...request.organization].map(material => ({ material,
            feedback: readOrganizationFeedbackMaterial(material, scope) }))
            .find(row => row.feedback?.value.unitRef === "operation:read-prerequisite" && row.feedback.value.result.kind === "progress");

          assert.ok(progress, "a persisted read completion needs actual organization feedback, including after restart");
          assert.ok(progress.feedback);
          assert.match(progress.material.text, /not a new business sample or a quality verdict/);
          prior = { ...prior, revisionReason: "The actual read identified the missing input premise", continuation: { kind: "waiting", wait: {
            kind: "use_feedback", reason: "Await a real later task", sourceRefs: prior.sourceRefs } } };
          output = { schemaVersion: 1, intents: [prior], publicExplanation: "The input premise was found; later business effect is unknown", sourceRefs: prior.sourceRefs,
            organizationKnowledge: [{ kind: "knowledge", knowledgeId: "practice:read-prerequisite-first", supersedes: null,
              statement: "Read a missing declared schema prerequisite before spending on procedure comparisons", conditions: "The task input schema premise is unknown",
              conditionKeys: ["domain:prompt"], exceptions: "When the schema has already been verified", exceptionKeys: [],
              implication: "Choose an original prerequisite read before consultation", supportFactIds: [progress.feedback.factId], counterexampleFactIds: [], state: "proposed" }] };
        } else {
          assert.equal(calls, 3);
          assert.ok(prior);
          const packet = request.organization.find(row => row.ref.startsWith("organization-recall:"));
          assert.ok(packet);
          const entry = (JSON.parse(packet.text) as { entries: { factId: string; knowledge: { knowledgeId: string } }[] }).entries
            .find(row => row.knowledge.knowledgeId === "practice:read-prerequisite-first");
          assert.ok(entry);
          const opportunity = request.opportunities.find(row => row.subject.plane === "agent" && row.subject.issueId === "issue:second");
          assert.ok(opportunity);
          const next: CentralLearningIntentDraft = { ...prior, intentId: "intent:second", subject: opportunity.subject,
            goal: "Read the second task's unknown schema before comparison", sourceRefs: [opportunity.sourceRef], revisionReason: "Apply the actual prerequisite progress under matching conditions",
            continuation: { kind: "ready", operation: { kind: "read", operationId: "operation:second-task-read", purpose: "Read the second actual task prerequisite first",
              expectedChange: "Inspect the input contract before consulting procedure comparisons", sourceRefs: [opportunity.sourceRef], refs: [opportunity.sourceRef], maximumChars: 12000 } } };

          output = { schemaVersion: 1, intents: [prior, next], publicExplanation: "The source-bound organization hypothesis changes this task's program", sourceRefs: [opportunity.sourceRef],
            organizationUse: { recallRef: packet.ref, changes: [{ knowledgeFactId: entry.factId, choice: "program", before: "Consult procedure comparisons first",
              after: "Read the unknown declared schema prerequisite first", reason: "The unknown-premise condition holds; the verified-schema exception does not" }] } };
        }

        receipts.set(request.operation.operationId, { request, output });
        return output;
      },

      async inspect(query: { operationId: string }) {
        const receipt = receipts.get(query.operationId);
        return receipt === undefined ? { status: "not_sent" as const, sourceRefs: [] }
          : { status: "returned" as const, ...receipt, deliveryRef: `scripted-transport-delivery:${query.operationId}`, sourceRefs: [] };
      },
    };
    const make = () => {
      const organization = createCentralRuntimeOrganization({ ...options, service });
      const driver = createCentralLearningDriver({ ...options, now, source, execution, deliberation: model, organization });
      drivers.push(driver);
      return driver;
    };
    const firstDriver = make();

    await firstDriver.drive(input);
    await firstDriver.drive(input);
    assert.equal(calls, 1);
    await firstDriver.close?.();
    let view = await service.read();
    assert.equal(view.status, "ready");
    if (view.status !== "ready") return;

    assert.ok(!view.projection.feedback.some(row => row.value.unitRef === "operation:read-prerequisite"), "simulate exit after the read save, before organization publication");
    const partial = createCentralRuntimeOrganization({ ...options, service });
    const unpublished = await partial.recoverResults!({ scope }, signal);
    const readFeedback = unpublished.find(row => row.text.includes('"unitRef":"operation:read-prerequisite"'));
    assert.ok(readFeedback);
    const afterObserve = createCentralRuntimeOrganization({ ...options, service });
    const redelivered = await afterObserve.recoverResults!({ scope }, signal);

    assert.ok(redelivered.some(row => row.ref === readFeedback.ref), "observe succeeded but its following runtime delivery save was lost");
    view = await service.read();
    assert.equal(view.status, "ready");
    if (view.status !== "ready") return;

    assert.equal(view.projection.feedback.filter(row => row.value.unitRef === "operation:read-prerequisite").length, 1);
    const resumed = make();
    await resumed.drive(input);
    assert.equal(calls, 2);
    const stored = await createCentralRuntimeStore(options).read(scope);

    assert.ok(stored.history.materials.some(row => row.ref === readFeedback.ref));
    assert.ok(!(await afterObserve.recoverResults!({ scope }, signal)).some(row => row.ref === readFeedback.ref),
      "the delivered read unit is not refilled; a newly returned thought may have its own original progress");
    await report("issue:second", "Another document task has an unknown input schema and needs a prerequisite inspection.");
    const changedProgram = await resumed.drive(input);

    assert.equal(changedProgram.state, "ready", JSON.stringify(changedProgram));
    await resumed.drive(input);
    assert.equal(calls, 3);
    view = await service.read();
    assert.equal(view.status, "ready");
    if (view.status !== "ready") return;

    const decision = view.projection.decisions.find(row => row.value.decisionRef === "operation:second-task-read");
    assert.ok(decision);
    assert.match(decision.value.program.depth, /"kind":"read"/);
    assert.ok(decision.value.experienceUse);
    assert.equal(decision.value.experienceUse.changes[0]?.choice, "program");
  } finally {
    await Promise.all(drivers.map(driver => driver.close?.()));
    await rm(root, { recursive: true, force: true });
  }
});
