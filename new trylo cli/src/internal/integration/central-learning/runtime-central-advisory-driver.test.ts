import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import type { CentralDeliberationPort, CentralLearningConfiguration, CentralLearningDriveInput,
  CentralLearningIntentDraft, CentralRuntimeExecutionPort, CentralRuntimeSourcePort } from "../../learning/central/runtime/contracts.js";
import { createCentralLearningDriver } from "./runtime-driver.js";
import { createCentralRuntimeStore } from "./runtime-store.js";
import { createCentralDeliberationReceiptsAtRoot } from "./deliberation-receipts.js";
import { createRuntimeCentralAdvisoryPublisher } from "./runtime-central-advisory-publication.js";
import { createRuntimeCentralAdvisoryContext } from "./runtime-central-advisory-context.js";
import { centralAdvisoryKnowledgeHash, lookupCentralAdvisories } from "./central-advisory-records.js";
import { readAppliedCentralAdvisoryDecisions } from "./central-advisory-applied-decisions.js";

test("a cold driver publishes the original applied handoff after checkpoint interruption without another computation", async () => {
  const boardRoot = await mkdtemp(join(tmpdir(), "trylo-advisory-driver-"));

  assert.equal(dirname(boardRoot), resolve(tmpdir()));
  const scope = "project:advisory-driver", enabled = () => true, signal = new AbortController().signal;
  const now = () => "2026-11-06T00:00:00.000Z", sourceRef = "source:original-public-observation";
  const configuration: CentralLearningConfiguration = { schemaVersion: 1, configurationRef: "configuration:advisory-driver",
    authorizationRef: "authorization:advisory-driver", allowance: { schemaVersion: 2, unit: "total_model_tokens",
      maxTokens: 10000, maxCalls: 4, maxSteps: 4, maxPromptChars: 20000 } };
  const operation = { kind: "think" as const, operationId: "operation:advisory-driver", purpose: "Retain a conditional observation",
    expectedChange: "Choose whether the original knowledge should be publicly reusable", sourceRefs: [sourceRef] };
  const intent: CentralLearningIntentDraft = { intentId: "intent:advisory-driver", subject: { plane: "central", questionRef: "question:advisory-driver" },
    goal: "Understand the actual receiver condition", rationale: "The original public observation is bounded", conditions: ["Same receiver"],
    knowledge: [], residual: ["Future benefit is unknown"], commitment: { purpose: "Investigate the receiver condition", assumptions: [], reconsiderWhen: [] },
    revisionReason: "The public source warrants this comparison", sourceRefs: [sourceRef], continuation: { kind: "ready", operation } };
  const material = { ref: sourceRef, kind: "source" as const, text: "Only the original receiver has been observed.", sourceRefs: [] };
  const store = createCentralRuntimeStore({ boardRoot, enabled });
  const drivers: ReturnType<typeof createCentralLearningDriver>[] = [];

  try {
    const empty = await store.read(scope);

    assert.equal((await store.append({ expectedRevision: empty.revision, previousRef: empty.stateRef,
      state: { ...empty.state, intents: [intent], materials: [material], consumedSourceRefs: [sourceRef] },
      reason: "original_ready_computation", sourceRefs: [sourceRef] })).status, "written");
    const source: CentralRuntimeSourcePort = { async snapshot() {
      const current = await store.read(scope);
      return { boardSequence: current.revision, materials: [material], opportunities: [], sourceRefs: [sourceRef] };
    }, async read() { throw new Error("No read is selected in this journey"); } };
    const execution: CentralRuntimeExecutionPort = { async consult() { throw new Error("No consultation is selected"); },
      async prepare() { throw new Error("No dispatch is selected"); }, async execute() { throw new Error("No worker is selected"); },
      async recover() { return null; } };
    let calls = 0;
    const semantic: CentralDeliberationPort = {
      async deliberate(request, cancellation) {
        calls += 1;
        const knowledge = { statement: "Compare the declared receiver before reuse.", conditions: "Only the observed receiver.", sourceRefs: [sourceRef] };
        const output = { schemaVersion: 1 as const, intents: [{ ...intent, knowledge: [knowledge],
          continuation: { kind: "ended" as const, goalState: "open" as const, reason: "No further investment is selected" } }],
        publicExplanation: "Retain the conditioned knowledge; delivery and benefit remain unknown.", sourceRefs: [sourceRef],
        knowledgeHandoffs: [{ kind: "publish" as const, intentId: intent.intentId, knowledgeHash: centralAdvisoryKnowledgeHash(knowledge),
          whenRelevant: "When comparing the same declared receiver", uncertainty: "No later reuse has been observed" }] };

        await createCentralDeliberationReceiptsAtRoot({ boardRoot, scope, budgetId: request.budgetId, enabled }).save({ request, output }, cancellation);

        return output;
      },

      async inspect(input, cancellation) {
        const receipt = await createCentralDeliberationReceiptsAtRoot({ boardRoot, scope, budgetId: input.budgetId, enabled })
          .read(input.operationId, cancellation);
        return receipt === undefined ? { status: "unknown", sourceRefs: [] } : { status: "returned", ...receipt };
      },
    };
    const publisher = createRuntimeCentralAdvisoryPublisher({ boardRoot, scope, enabled, access: async () => ({ ok: true }) });
    const interrupted = createCentralLearningDriver({ boardRoot, scope, enabled, now, source, execution, deliberation: semantic,
      advisories: { ...publisher, async recordDecision() { throw new Error("process interrupted after applied checkpoint"); } } });

    drivers.push(interrupted);
    const input: CentralLearningDriveInput = { scope, configuration, signal, wake: { reason: "original_committed_work", sourceRefs: [sourceRef] }, publish() {} };

    await assert.rejects(interrupted.drive(input), /interrupted after applied checkpoint/);
    const applied = await createBoardReader(boardRoot).load();
    assert.ok(applied.ok);
    assert.equal(readAppliedCentralAdvisoryDecisions(applied.state.rewardV2Facts ?? [], scope, applied.state.sequence).length, 1);
    assert.deepEqual(lookupCentralAdvisories(applied.state, scope), []);
    await interrupted.close?.();
    const cold = createCentralLearningDriver({ boardRoot, scope, enabled, now, source, execution, advisories: publisher,
      deliberation: { inspect: semantic.inspect!, async deliberate() { throw new Error("Recovery must not purchase another computation"); } } });

    drivers.push(cold);
    await cold.drive(input);
    assert.equal(calls, 1);
    const published = await createBoardReader(boardRoot).load();
    assert.ok(published.ok);
    const views = lookupCentralAdvisories(published.state, scope);
    assert.equal(views.length, 1);
    const context = createRuntimeCentralAdvisoryContext({ boardRoot, scope, enabled, access: async () => ({ ok: true }) });
    const materials = await context.recall({ scope, boardSequence: published.state.sequence }, signal);

    assert.ok(materials.some(row => row.text.includes('"published"')));
    assert.ok(materials.some(row => row.sourceRefs.includes(views[0]!.version)), "the actual publication version is offered for a later typed read/withdraw");
    const passive = await context.source.snapshot(scope, signal);

    assert.deepEqual(passive.sourceRefs, []);
    assert.deepEqual(passive.opportunities, []);
    const before = published.state.sequence;

    await cold.drive(input);
    assert.equal(calls, 1);
    const unchanged = await createBoardReader(boardRoot).load();
    assert.ok(unchanged.ok);
    assert.equal(unchanged.state.sequence, before);
  } finally {
    await Promise.allSettled(drivers.map(driver => driver.close?.()));
    assert.equal(dirname(boardRoot), resolve(tmpdir()));
    await rm(boardRoot, { recursive: true, force: true });
  }
});
