import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Envelope } from "../../protocol/envelope.js";
import type { TopicEvidenceWindow, TopicExperimentDescriptor } from "../../learning/domains/shared/topics/contracts.js";
import type { TopicPairedMeasurement } from "../../learning/domains/shared/topics/empirical-model.js";
import { freezeTopicExperimentDescriptor, isTopicExperimentDescriptor, parseTopicWindow } from "../../learning/domains/shared/topics/parse.js";
import { buildCommonTopicPrompt, prepareCommonTopicPrompt, readTopicSubmission } from "../../learning/domains/shared/topics/submission.js";
import { DEFAULT_METHOD_GRANT, LEARNING_FENCE } from "../../learning/agent/subsystems/method/index.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { createTopicEvidenceBuffer } from "./evidence.js";
import { comparisonEvidenceRecord } from "./comparison-evidence.js";
import { createTopicLearningRuntime } from "./runtime.js";
import { createTopicLearningSystem } from "./system.js";
import { createRewardV2BoardPort } from "../reward/v2-board-port.js";
import { createDefaultReadTopicConfiguration, createReadStrategyRuntime } from "../../learning/agent/subsystems/tool/read-strategy/index.js";
import { teachingFor } from "../../loop/method-signal.js";
import { createFakeTools } from "../../loop/fakes.js";

const scope = "decision-context-contract";
const context = { decision: "Choose whole or stream for the captured bounded read.",
  observation: "Compare checked output and actual bytes within the existing read protocol." };
const descriptor: TopicExperimentDescriptor = { ref: "read-context-contract", version: "1", domain: "tool",
  purpose: "Compare two existing readers", conditionHash: "a".repeat(64), context };

function windowOf(records: TopicEvidenceWindow["records"]): TopicEvidenceWindow {
  return { schemaVersion: 1, domain: "prompt", scope, boardSequence: 0,
    watermarks: [{ runId: "execution:source", throughSequence: 2 }], records, experiments: [descriptor] };
}

function draft(ref: string, quote: string): string {
  return JSON.stringify({ schemaVersion: 2, question: "Which observed condition should influence the next read choice?",
    whenRelevant: "When choosing the next bounded reader", expectedChange: "Use the answer before changing reader choice",
    citations: [{ evidenceRef: ref, quote }] });
}

test("decision context is a strict optional descriptor contract and its frozen copy preserves legacy shapes", () => {
  const { context: _context, conditionHash: _conditionHash, ...legacy } = descriptor;

  assert.equal(isTopicExperimentDescriptor(legacy), true);
  assert.equal(isTopicExperimentDescriptor({ ...legacy, conditionHash: descriptor.conditionHash }), true);
  assert.equal(isTopicExperimentDescriptor(descriptor), true, "a valid host decision/observation contract must be accepted");
  assert.equal(isTopicExperimentDescriptor({ ...descriptor, authority: "approved" }), false);
  assert.equal(isTopicExperimentDescriptor({ ...descriptor, context: { ...context, passed: true } }), false);
  assert.equal(isTopicExperimentDescriptor({ ...descriptor, context: { ...context, observation: "x".repeat(161) } }), false);
  const mutable = { ...descriptor, context: { ...context } }, frozen = freezeTopicExperimentDescriptor(mutable);

  mutable.context.decision = "changed after registration";
  assert.equal(frozen.context!.decision, context.decision);
  assert.ok(Object.isFrozen(frozen));
  assert.ok(Object.isFrozen(frozen.context));
  const oldWindow = { ...windowOf([{ ref: "old", runId: "execution:source", sequence: 1, scope, origin: "execution_result", text: "reported only" }]),
    experiments: [legacy] };
  const parsed = parseTopicWindow(JSON.stringify(oldWindow));
  assert.ok(parsed.ok);

  if (parsed.ok) assert.deepEqual(parsed.value, oldWindow, "reading an old window must not backfill context or alter identity bytes");
});

test("common prompt drops only complete old records and grounds against the exact returned visible window", () => {
  const retainedText = "The independent checker accepted the bounded read output.";
  const source = windowOf([
    { ref: "omitted", runId: "execution:source", sequence: 1, scope, origin: "user_statement", text: "old evidence " + "x".repeat(1000) },
    { ref: "retained", runId: "execution:source", sequence: 2, scope, origin: "checker_result", text: retainedText },
  ]);
  const original = JSON.stringify(source), full = buildCommonTopicPrompt(original);
  assert.ok(full.ok);

  if (!full.ok) return;
  assert.ok(full.value.length > 1200);
  const prepared = prepareCommonTopicPrompt(original, 1200);
  assert.ok(prepared.ok);
  if (!prepared.ok) return;

  assert.ok(prepared.value.prompt.length <= 1200);
  const selected = parseTopicWindow(prepared.value.windowJson);
  assert.ok(selected.ok);
  if (!selected.ok) return;

  assert.deepEqual(selected.value.records, [source.records[1]]);
  assert.equal(selected.value.records[0]!.text, retainedText);
  assert.deepEqual(selected.value.watermarks, [{ runId: "execution:source", throughSequence: 2 }]);
  assert.equal(JSON.stringify(source), original);
  assert.equal(prepared.value.prompt.includes(source.records[0]!.text), false);
  const removed = readTopicSubmission(draft("omitted", "old evidence"), prepared.value.windowJson);

  assert.equal(removed.ok, false);
  if (!removed.ok) assert.equal(removed.reason, "topic_evidence_missing");

  const kept = readTopicSubmission(draft("retained", retainedText), prepared.value.windowJson);

  assert.ok(kept.ok);
  if (kept.ok) assert.equal(kept.value.kind, "topic");
});

test("ordinary runtime fields current host context within the shared ceiling and persists the same unmodified grounding window", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-decision-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const boardRoot = path.join(root, "board");
  let probeCalls = 0, described = 0;
  const system = createTopicLearningSystem({ boardRoot, scope, enabled: () => true, configuration: {
    policy: { poolId: "decision-context", algorithmVersion: "decision-context-v1", utilityUnit: "read-check-utility", quotaUnit: "read-pair", totalQuota: 2 },
    perTurnQuota: 1, domainRelation: "separable", experiments: [{ descriptor,
      policy: { conditionHash: descriptor.conditionHash!, futureUses: 1, utilityScale: 1, experimentUnits: 1,
        priorStrength: 2, priorWeights: [0.25, 0.25, 0.25, 0.25], deltaBounds: { minimum: -1, maximum: 1 } },
      checkerVersion: "check-v1", executionVersion: "execution-v1", available: () => true,

      describeContext() {
        described += 1;
        return context;
      },

      probe: { async run() {
        probeCalls += 1;
        throw new Error("proposal_must_not_execute_probe");
      }, async read() { return undefined; } },
    }] } });
  const event: Envelope = { protocolVersion: "0.0", eventId: "current-statement", sequence: 0, timestamp: "2026-11-03T00:00:00.000Z",
    sessionId: "session", turnId: "turn", attemptId: "attempt", kind: "turn_start", payload: {}, producerId: "host", producerSequence: 0 };
  const text = "Check the input conditions before choosing a reader.";
  const projectEvidence = () => ({ origin: "user_statement" as const, text });
  const runtime = createTopicLearningRuntime({ boardRoot, scope, sessionId: "session", turnId: "turn", enabled: () => true,
    emit: () => {}, projectEvidence, control: { system, requestId: "turn:session:turn", totalQuota: 1 } });
  const expected = createTopicEvidenceBuffer({ scope, sessionId: "session", turnId: "turn", projectEvidence });
  expected.capture(event);
  const originalWindow = expected.snapshot(0, system.descriptors([]))!;

  runtime.capture(event);
  const port = runtime.attach(undefined), slot = await port.requestSlot({ turnId: "turn", beat: 1, toolNames: [] });

  assert.ok(slot);
  assert.ok(slot.message.content.length <= DEFAULT_METHOD_GRANT.slotChars);
  assert.ok(slot.message.content.includes(LEARNING_FENCE));
  assert.ok(slot.message.content.includes(context.decision));
  assert.ok(slot.message.content.includes(context.observation));
  assert.ok(described > 0);
  await port.observe({ turnId: "turn", beat: 1, failures: [], succeededTools: [], toolNames: [], proposal: draft(event.eventId, text) });
  const loaded = await createBoardReader(boardRoot).load();
  assert.ok(loaded.ok);
  if (!loaded.ok) return;

  const candidates = (loaded.state.rewardV2Facts ?? []).map(row => JSON.parse(row.payloadJson)).filter(row => row.type === "ws1_topic_candidate");

  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].evidenceWindow, JSON.parse(originalWindow));
  assert.equal(candidates[0].evidenceWindow.records[0].text, text);
  assert.equal(probeCalls, 0);
  assert.equal(loaded.state.jobs.length, 0);
  assert.equal(loaded.state.assets.length, 0);
});


test("the real shared slot retains a published two-arm IO comparison and current read status within 1200 characters", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-comparison-capacity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const boardRoot = path.join(root, "board"), board = createRewardV2BoardPort(boardRoot, () => true);

  assert.equal((await board.append(0, { id: "public-comparison-fixture-prefix", scope, algorithmVersion: "capacity-fixture-v1",
    kind: "feedback", payloadJson: '{"fixture":"published-comparison-prefix"}' })).status, "written");
  // Public shape/IDs/costs from volc-ordinary-io-execute-v1/orders/BOARD-AFTER READBACK,
  // second pair (sequence 30), plus REQUEST02 evt-15 status. Only fixture coordinates change;
  // this tests the trusted semantic-input representation, not sampling or source authentication.
  const comparisonRef = "topic-measure:911e558618f30a1be977a38dc2bda90cf888168e40aadb1192afe4148a09f737";
  const measurement: TopicPairedMeasurement = { id: comparisonRef, scope, sequence: 1, kind: "measured",
    experimentRef: "tool.read.whole-stream.v2", experimentVersion: "2", conditionHash: "a".repeat(64),
    utilityUnit: "read_quality_io_cost_v2", sourceRef: "checker:public-comparison",
    baselineUtility: -4247, candidateUtility: -9367, fullStudyCost: 60298 };
  const comparison = comparisonEvidenceRecord({ schemaVersion: 2, comparisonRef,
    case: { kind: "read_opportunity", ref: "5eb1385c1508f146f630d04d8ce74fc219aac287b303f4031660cf0361f187a5" }, costUnit: "io_cost",
    arms: [{ id: "whole", checked: "pass", candidateCost: 4247, studyCost: 17861 },
      { id: "stream", checked: "pass", candidateCost: 9367, studyCost: 42437 }] }, measurement, scope, 1);

  assert.ok(comparison);
  const comparisonText = comparison.text;

  assert.ok(comparisonText.length > 256, "the real cost-role payload needs the dedicated bounded comparison admission");
  const local = createDefaultReadTopicConfiguration({ boardRoot, scope, collect: () => true });

  local.bindRuntime(createReadStrategyRuntime({ boardRoot, scope, sessionId: "session", turnId: "turn", enabled: true }));
  let trials = 0;

  local.offer({ executionId: "current-public-read", conditions: { fileBytes: 17861, range: "bounded", streaming: true }, requiredBytes: 262144,

    async trial() {
      trials += 1;
      throw new Error("slot_preparation_must_not_run_a_trial");
    } });
  const system = createTopicLearningSystem({ boardRoot, scope, enabled: () => true, configuration: local.configuration });
  const control = { ...system, semanticEvidence: () => comparison };
  const runtime = createTopicLearningRuntime({ boardRoot, scope, sessionId: "session", turnId: "turn", enabled: () => true,
    emit: () => {}, control: { system: control, requestId: "turn:session:turn", totalQuota: 1 } });
  const event: Envelope = { protocolVersion: "0.0", eventId: "evt-14", sequence: 14, timestamp: "2026-11-03T00:00:00.000Z",
    sessionId: "session", turnId: "turn", attemptId: "attempt", kind: "tool_use", payload: { toolCallId: "read-one", name: "read_file" },
    producerId: "host", producerSequence: 14 };
  const resultEvent: Envelope = { ...event, eventId: "evt-15", sequence: 15, producerSequence: 15,
    kind: "tool_result", payload: { toolCallId: "read-one", status: "succeeded" } };
  const generic = createTopicEvidenceBuffer({ scope, sessionId: "session", turnId: "turn",
    projectEvidence: () => ({ origin: "checker_result", text: comparisonText }) });

  assert.throws(() => generic.capture(resultEvent), { reason: "topic_evidence_projection_invalid" },
    "the comparison exception must not enlarge ordinary event projector admission");
  runtime.capture(event);
  runtime.capture(resultEvent);
  const expected = createTopicEvidenceBuffer({ scope, sessionId: "session", turnId: "turn" });
  expected.capture(event);
  expected.capture(resultEvent);
  const originalWindow = expected.snapshot(1, system.descriptors([]), comparison)!;
  const port = runtime.attach(undefined), teaching = await teachingFor(port, undefined, "turn", 1, createFakeTools([]));

  assert.ok(teaching.slot, "the actual teaching boundary must field both records, rather than skip for topic_prompt_capacity");
  assert.ok(teaching.channel);
  assert.ok(teaching.slot.message.content.length <= DEFAULT_METHOD_GRANT.slotChars);
  const visible = JSON.parse(teaching.slot.message.content.split("[topic evidence JSON]\n")[1]!.split("\n[/topic evidence JSON]")[0]!);

  assert.deepEqual(visible.map((row: { ref: string }) => row.ref), ["evt-15", comparisonRef]);
  assert.equal(visible[0].text, '{"reportedStatus":"succeeded","tool":"read_file"}');
  assert.equal(visible[1].text, comparisonText);
  const shown = JSON.parse(visible[1].text);
  assert.equal(shown.schemaVersion, 2);
  assert.equal(shown.arms[0].candidateCost, 4247);
  assert.equal(shown.arms[0].studyCost, 17861);
  assert.equal(shown.arms.reduce((sum: number, arm: { studyCost: number }) => sum + arm.studyCost, 0), measurement.fullStudyCost);
  const experimentRef = system.descriptors([])[0]!.ref;

  assert.ok(teaching.slot.message.content.includes(`"experimentRef":"${experimentRef}"`));
  const proposal = JSON.stringify({ kind: "topic", experimentRef, question: "Which missing condition matters before changing the next reader?",
    whenRelevant: "When the next bounded read is selected", expectedChange: "Use the answer before choosing a reader",
    citations: [{ evidenceRef: "evt-15", quote: visible[0].text }, { evidenceRef: comparisonRef, quote: '"candidateCost":4247' }] });
  const parsed = readTopicSubmission(proposal, originalWindow);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;

  assert.equal(parsed.value.kind, "topic");
  if (parsed.value.kind !== "topic") return;

  assert.equal(parsed.value.topic.schemaVersion, 3);
  await port.observe({ turnId: "turn", beat: 1, failures: [], succeededTools: [], toolNames: [], proposal });
  const loaded = await createBoardReader(boardRoot).load();
  assert.ok(loaded.ok);
  if (!loaded.ok) return;

  const candidates = (loaded.state.rewardV2Facts ?? []).map(row => JSON.parse(row.payloadJson)).filter(row => row.type === "ws1_topic_candidate");

  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].evidenceWindow, JSON.parse(originalWindow));
  assert.deepEqual(candidates[0].proposal, JSON.parse(proposal));
  assert.equal(Object.hasOwn(candidates[0].proposal, "schemaVersion"), false);
  assert.equal(candidates[0].proposal.kind, "topic");
  assert.equal(candidates[0].proposal.experimentRef, experimentRef);
  assert.equal(candidates[0].evidenceWindow.experiments[0].ref, experimentRef);
  assert.deepEqual(candidates[0].proposal.citations.map((citation: { evidenceRef: string }) => citation.evidenceRef), ["evt-15", comparisonRef]);
  assert.equal(trials, 0);
  assert.equal(loaded.state.jobs.length, 0);
  assert.equal(loaded.state.assets.length, 0);
});
