import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Envelope } from "../../protocol/envelope.js";
import { createTopicLearningRuntime } from "./runtime.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";

test("the common-stream component retains an open question without manufacturing hypotheses or a job", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-common-question-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = createTopicLearningRuntime({ boardRoot: root, scope: "project:one", sessionId: "session", turnId: "turn",
    enabled: () => true, emit: () => {} }), port = runtime.attach(undefined);
  const event = (kind: string, sequence: number, payload: Envelope["payload"]): Envelope => ({ protocolVersion: "0.0", kind, sequence,
    eventId: `event-${sequence}`, timestamp: "2026-11-03T00:00:00.000Z", sessionId: "session", turnId: "turn", attemptId: "attempt",
    producerId: "loop", producerSequence: sequence, payload });

  runtime.capture(event("tool_use", 1, { toolCallId: "call", name: "read_file", arguments: {} }));
  runtime.capture(event("tool_result", 2, { toolCallId: "call", status: "failed", output: "not-collected" }));
  const report = { turnId: "turn", failures: [], succeededTools: [], toolNames: ["read_file"] };

  await port.observe({ ...report, beat: 1 });
  const slot = await port.requestSlot({ turnId: "turn", beat: 2, toolNames: ["read_file"] });
  assert.ok(slot);
  assert.ok(slot.message.content.length <= 1200);
  const proposal = JSON.stringify({ schemaVersion: 2, question: "什么条件影响读取结果？", whenRelevant: "下一次读取时",
    expectedChange: "先确定适用条件再选读取方法", citations: [{ evidenceRef: "event-2", quote: '"reportedStatus":"failed"' }] });

  assert.ok(proposal.length <= 1100);
  await port.observe({ ...report, beat: 2, proposal });
  const loaded = await createBoardReader(root).load();
  assert.ok(loaded.ok);
  if (!loaded.ok) return;

  const facts = loaded.state.rewardV2Facts ?? [];
  assert.equal(facts.length, 1);
  assert.equal(JSON.parse(facts[0]!.payloadJson).proposal.schemaVersion, 2);
  assert.equal(loaded.state.jobs.length, 0);
  assert.equal(loaded.state.assets.length, 0);
  assert.equal(runtime.inspect().phase, "closed");
});
