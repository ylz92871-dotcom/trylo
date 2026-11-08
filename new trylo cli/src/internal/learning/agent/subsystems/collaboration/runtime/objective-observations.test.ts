import assert from "node:assert/strict";
import test from "node:test";
import type { Envelope, JsonObject } from "../../../../../protocol/envelope.js";
import type { CollaborationRound } from "../../../../../subagent/collaboration.js";
import { createCollaborationObjectiveObservations } from "./objective-observations.js";

const options = { scope: "workspace:objective", turnId: "parent-turn", taskId: "parent-task" };
const envelope = (sequence: number, kind: string, payload: JsonObject, turnId = options.turnId): Envelope => ({
  protocolVersion: "0.0", eventId: `event:${sequence}`, sequence, timestamp: "2026-11-04T00:00:00.000Z",
  kind, payload, turnId, producerId: "loop", producerSequence: sequence,
});
const round = (patch: Partial<CollaborationRound> = {}): CollaborationRound => ({
  executionId: "execution:one", taskId: "task:one", teamRunId: "team:one", memberId: "worker", role: "worker", round: 1,
  assignment: "Produce the inventory handoff.", dependencies: ["task:source"], ...patch,
});

test("tool observation metadata stays whole within 512 characters and invalid result status still closes its real pending call", () => {
  const sensor = createCollaborationObjectiveObservations(options), boundary = "i".repeat(512), overlong = "x".repeat(513);

  sensor.capture(envelope(1, "tool_use", { toolCallId: overlong, name: "read_file" }));
  assert.equal(sensor.snapshot().pendingTools.length, 0, "overlong tool identity must be omitted instead of entering the bounded-count map");
  sensor.capture(envelope(2, "tool_result", { toolCallId: "bad\0id", status: "succeeded" }));
  assert.equal(sensor.snapshot().omitted.invalidToolObservations, 2);
  sensor.capture(envelope(3, "tool_use", { toolCallId: boundary, name: boundary, body: "PRIVATE_RAW_BODY" }));
  assert.equal(sensor.snapshot().pendingTools[0]?.toolCallId, boundary);
  assert.equal(sensor.snapshot().pendingTools[0]?.toolName, boundary);
  sensor.capture(envelope(4, "tool_result", { toolCallId: boundary, name: overlong, status: overlong, code: overlong, body: "PRIVATE_RAW_BODY" }));
  assert.equal(sensor.snapshot().pendingTools.length, 0);
  const result = sensor.recentFacts().find(fact => fact.kind === "tool_result");
  assert.ok(result);
  assert.equal(result.toolCallId, boundary);
  assert.equal(result.toolName, boundary, "retain the actually observed bounded opening name");
  assert.equal(result.status, "result_observed");
  assert.equal(result.errorCode, undefined);
  sensor.capture(envelope(5, "tool_use", { toolCallId: "call:unknown-name", name: overlong }));
  assert.equal(sensor.snapshot().pendingTools[0]?.toolName, undefined);
  sensor.capture(envelope(6, "tool_result", { toolCallId: "call:unknown-name", status: "bad\0status", code: "bad\0code" }));
  assert.equal(sensor.snapshot().pendingTools.length, 0);
  const activity = { subagentId: "activity:execution", taskId: "activity:task", memberId: "activity:member" };

  sensor.capture(envelope(7, "subagent_update", { ...activity, activity: { id: overlong, kind: "tool", tool: "read_file" } }));
  sensor.capture(envelope(8, "subagent_update", { ...activity, activity: { id: "bad\0activity", kind: "result", ok: true } }));
  sensor.capture(envelope(9, "subagent_update", { ...activity, activity: { id: "activity:valid", kind: "tool", tool: overlong } }));
  assert.equal(sensor.snapshot().pendingTools[0]?.toolName, undefined);
  sensor.capture(envelope(10, "subagent_update", { ...activity, activity: { id: "activity:valid", kind: "result", ok: true } }));
  assert.equal(sensor.snapshot().pendingTools.length, 0);
  assert.equal(sensor.snapshot().omitted.invalidToolObservations, 4);
  assert.equal(sensor.inspectionView().omitted.invalidToolObservations, 4);
  assert.ok(!JSON.stringify(sensor.snapshot()).includes(overlong));
  assert.ok(!JSON.stringify(sensor.snapshot()).includes("PRIVATE_RAW_BODY"));
});

test("canonical tool_use remains unresolved evidence until its own result and never turns lack of return into failure", () => {
  const sensor = createCollaborationObjectiveObservations(options);
  const use = envelope(1, "tool_use", { toolCallId: "tool:one", name: "read_file", arguments: { path: "private-source" } });

  sensor.capture(use);
  sensor.capture(use);
  sensor.capture(envelope(2, "tool_call", { toolCallId: "provider-only", name: "wrong-layer" }));
  assert.equal(sensor.snapshot().pendingTools.length, 1);
  assert.equal(sensor.recentFacts().length, 1);
  const pending = sensor.snapshot().pendingTools[0]!;

  assert.equal(pending.kind, "tool_pending");
  assert.equal(pending.status, undefined);
  assert.equal(pending.source?.eventId, use.eventId);
  assert.equal(pending.source?.turnId, options.turnId);
  assert.ok(!JSON.stringify(pending).includes("private-source"));
  Reflect.set(pending, "toolName", "caller:tampered");
  assert.equal(sensor.snapshot().pendingTools[0]!.toolName, "read_file", "a read projection cannot mutate the observed execution facts");
  sensor.capture(envelope(3, "tool_result", { toolCallId: "tool:one", status: "cancelled", code: "user_cancelled" }));
  assert.equal(sensor.snapshot().pendingTools.length, 0);
  const result = sensor.recentFacts().find(fact => fact.kind === "tool_result");
  assert.ok(result);
  assert.equal(result.status, "cancelled");
  assert.equal(result.errorCode, "user_cancelled");
  assert.equal(result.toolName, "read_file");
});

test("raw child events and runtime activity updates refer to one tool while same-named calls in another execution remain independent", () => {
  const sensor = createCollaborationObjectiveObservations(options), one = round(), two = round({ executionId: "execution:two", taskId: "task:two", memberId: "reviewer" });

  sensor.capture(envelope(1, "tool_use", { toolCallId: "same-id", name: "exec_command" }, "child-turn:one"), one);
  sensor.capture(envelope(2, "subagent_update", { subagentId: one.executionId!, taskId: one.taskId, memberId: one.memberId,
    teamRunId: one.teamRunId, activity: { id: "same-id", kind: "tool", tool: "exec_command" } }));
  sensor.capture(envelope(3, "tool_use", { toolCallId: "same-id", name: "read_file" }, "child-turn:two"), two);
  assert.equal(sensor.snapshot().pendingTools.length, 2);
  assert.equal(sensor.recentFacts().length, 2);
  sensor.capture(envelope(4, "tool_result", { toolCallId: "same-id", status: "succeeded" }, "child-turn:one"), one);
  sensor.capture(envelope(5, "subagent_update", { subagentId: one.executionId!, taskId: one.taskId, memberId: one.memberId,
    teamRunId: one.teamRunId, activity: { id: "same-id", kind: "result", ok: true } }));
  assert.equal(sensor.snapshot().pendingTools.length, 1);
  assert.equal(sensor.snapshot().pendingTools[0]!.executionId, two.executionId);
  assert.equal(sensor.recentFacts().filter(fact => fact.kind === "tool_result").length, 1);
});

test("tool IDs reused in later work rounds stay distinct and a late weaker activity summary cannot close current work", () => {
  const sensor = createCollaborationObjectiveObservations(options), one = round(), two = round({ round: 2 });

  sensor.capture(envelope(1, "tool_use", { toolCallId: "reused", name: "read_file" }, "child:r1"), one);
  sensor.capture(envelope(2, "tool_result", { toolCallId: "reused", status: "succeeded" }, "child:r1"), one);
  sensor.capture(envelope(3, "tool_use", { toolCallId: "reused", name: "write_file" }, "child:r2"), two);
  sensor.capture(envelope(4, "subagent_update", { subagentId: one.executionId!, taskId: one.taskId, memberId: one.memberId,
    teamRunId: one.teamRunId, activity: { id: "reused", kind: "result", ok: true } }));
  assert.equal(sensor.snapshot().pendingTools.length, 1);
  assert.equal(sensor.snapshot().pendingTools[0]!.round, 2);
  sensor.capture(envelope(5, "tool_result", { toolCallId: "reused", status: "cancelled" }, "child:r2"), two);
  assert.equal(sensor.snapshot().pendingTools.length, 0);
  assert.deepEqual(sensor.recentFacts().filter(fact => fact.kind === "tool_result").map(fact => fact.status), ["succeeded", "cancelled"]);
});

test("normal member progress remains a bounded attributed claim even when the stronger raw tool hook is mounted", () => {
  const sensor = createCollaborationObjectiveObservations(options), current = round();

  sensor.capture(envelope(1, "tool_use", { toolCallId: "read:member", name: "read_file" }, "child:member"), current);
  const before = sensor.decisionRevision();

  sensor.capture(envelope(2, "subagent_update", { subagentId: current.executionId!, taskId: current.taskId,
    memberId: current.memberId, teamRunId: current.teamRunId, round: 1,
    observation: { id: "progress:blocked", round: 1, kind: "report", reportState: "blocked", text: "The input does not state its timestamp unit." } }));
  sensor.capture(envelope(3, "subagent_update", { subagentId: current.executionId!, taskId: current.taskId,
    memberId: current.memberId, teamRunId: current.teamRunId, round: 1,
    observation: { id: "private:thinking", round: 1, kind: "thinking", text: "Do not copy private model reasoning." } }));
  const report = sensor.recentFacts().find(fact => fact.kind === "member_report");
  assert.ok(report);
  assert.equal(report.attribution, "member_claim");
  assert.equal(report.reportState, "blocked");
  assert.match(report.reportExcerpt!, /timestamp unit/);
  assert.ok(sensor.decisionRevision() > before);
  assert.doesNotMatch(JSON.stringify(sensor.inspectionView()), /private model reasoning/);
  assert.equal(sensor.snapshot().pendingTools.length, 1, "an authored blocker neither completes nor fails the outstanding tool");
});

test("round context uses only a real typed handoff, keeps current member state, and bounds goal excerpts without judging readiness", () => {
  const sensor = createCollaborationObjectiveObservations(options);

  sensor.observeGoal("Deliver inventory totals while preserving source files.");
  const one = round({ handoff: { scope: "Inventory consumer", artifacts: ["inventory.csv"], evidence: ["check:csv"],
    pending: ["Await warehouse confirmation"], blockers: [] } });

  sensor.roundPrepared(one);
  sensor.roundPrepared(one);
  sensor.roundDispatched(one, "request:one");
  sensor.roundCompleted(one);
  const context = sensor.roundContext(one, { configuredToolNames: ["read_file"] });

  assert.ok(context.length <= 900);
  assert.match(context, /inventory.csv/);
  assert.match(context, /Await warehouse confirmation/);
  assert.match(context, /preserving source files/);
  assert.match(context, /configuredToolNames/);
  const snapshot = sensor.snapshot();
  assert.equal(snapshot.rounds.length, 1);
  assert.equal(snapshot.rounds[0]!.phase, "completed");
  assert.equal(sensor.recentFacts().length, 3);
  assert.match(snapshot.note, /not quality acceptance/);
  const next = round({ executionId: "execution:later", taskId: "task:later", assignment: "There is a handoff mentioned in this sentence." });

  sensor.roundPrepared(next);
  sensor.roundEnded(one, "completed");
  assert.equal(sensor.snapshot().rounds[0]!.identity.taskId, "task:later");
  assert.equal(sensor.snapshot().rounds[0]!.phase, "prepared");
  assert.match(sensor.roundContext(next), /"handoff":"absent"/);
  sensor.observeGoal("x".repeat(5000));
  assert.equal(sensor.snapshot().goal?.truncated, true);
  assert.ok(sensor.snapshot().goal!.excerpt.length <= 1000);
  assert.ok(sensor.roundContext(next, { maxChars: 80 }).length <= 80);
});

test("pending tools survive recent-fact eviction and capacity loss is visible without evicting known inflight work", () => {
  const sensor = createCollaborationObjectiveObservations({ ...options, maxFacts: 2, maxPendingTools: 2 });

  sensor.capture(envelope(1, "tool_use", { toolCallId: "keep:one", name: "web_fetch" }));
  sensor.capture(envelope(2, "tool_use", { toolCallId: "keep:two", name: "exec_command" }));
  sensor.capture(envelope(3, "tool_use", { toolCallId: "overflow", name: "exec_command" }));
  sensor.roundPrepared(round());
  sensor.roundDispatched(round(), "request:round");
  sensor.roundCompleted(round());
  assert.deepEqual(sensor.snapshot().pendingTools.map(tool => tool.toolCallId), ["keep:one", "keep:two"]);
  assert.equal(sensor.snapshot().recentFacts.length, 2);
  assert.equal(sensor.snapshot().omitted.pendingToolObservations, 1);
  assert.ok(sensor.snapshot().omitted.facts > 0);
  assert.equal(sensor.recentFacts().filter(fact => fact.kind === "tool_pending").length, 2);
  assert.ok(sensor.recentFacts().length <= 4);
});

test("member work boundaries invalidate PA inspection while routine tool traffic and buffer eviction cannot starve its decision", () => {
  const sensor = createCollaborationObjectiveObservations({ ...options, maxFacts: 2 });

  sensor.roundPrepared(round());
  const first = sensor.decisionRevision();
  assert.ok(first > 0);
  sensor.roundPrepared(round());
  assert.equal(sensor.decisionRevision(), first);

  for (let sequence = 1; sequence <= 5; sequence++) {
    sensor.capture(envelope(sequence * 2, "tool_use", { toolCallId: `pa:${sequence}`, name: "collaboration_inspect" }));
    sensor.capture(envelope(sequence * 2 + 1, "tool_result", { toolCallId: `pa:${sequence}`, status: "succeeded" }));
  }

  sensor.inspectionView();
  assert.equal(sensor.decisionRevision(), first);
  const member = round();

  sensor.capture(envelope(20, "tool_use", { toolCallId: "member:routine", name: "read_file" }, "child:routine"), member);
  sensor.capture(envelope(21, "tool_result", { toolCallId: "member:routine", status: "succeeded" }, "child:routine"), member);
  assert.equal(sensor.decisionRevision(), first, "ordinary activity remains visible without forcing an inspect/decide livelock");
  assert.ok(sensor.recentFacts().some(fact => fact.toolCallId === "member:routine" && fact.kind === "tool_result"));
  sensor.roundDispatched(round(), "request:new");
  assert.ok(sensor.decisionRevision() > first);
  const revision = sensor.decisionRevision();
  sensor.roundDispatched(round(), "request:new");
  assert.equal(sensor.decisionRevision(), revision);
});

test("inspection exposes bounded genuine handoff references with omission counts instead of cutting exact references", () => {
  const sensor = createCollaborationObjectiveObservations(options), current = round({ handoff: { scope: "x".repeat(300),
    artifacts: ["a".repeat(600), "source.csv", "another.csv"], evidence: ["check:actual"],
    pending: ["p".repeat(500), "Confirm source", "Another pending item"], blockers: [] } });

  sensor.roundPrepared(current);
  const view = sensor.inspectionView();
  assert.ok(new TextEncoder().encode(JSON.stringify(view)).length <= 24000);
  assert.equal(view.totals.members, 1);
  assert.equal(view.omitted.rounds, 0);
  const row = view.rounds[0] as { handoff: { artifacts: string[]; omittedArtifactRefs: number; textTruncated: boolean; pendingCount: number } };

  assert.deepEqual(row.handoff.artifacts, ["source.csv"]);
  assert.equal(row.handoff.omittedArtifactRefs, 2);
  assert.equal(row.handoff.textTruncated, true);
  assert.equal(row.handoff.pendingCount, 3);
});

test("canonical file, observation and terminal metadata survive projection without raw content or plausible partial references", () => {
  const sensor = createCollaborationObjectiveObservations(options), current = round({ dependencies: ["dependency:" + "d".repeat(600), "task:source"],
    handoff: { scope: "Consumer", artifacts: ["C:/" + "a".repeat(600), "source.csv"], evidence: [], pending: [], blockers: [] } });

  sensor.capture(envelope(1, "file_write", { toolCallId: "write:one", path: "output.csv", status: "succeeded", value: { secret: "secret:do-not-copy" } }), current);
  sensor.capture(envelope(2, "observation", { component: "tool_cancel", late: true, ignored: "late_result", terminalReason: "cancelled",
    raw_unknown: "secret:do-not-copy", message: "secret:do-not-copy" }), current);
  sensor.capture(envelope(3, "terminal", { reason: "cancelled", cause: "user_cancelled", errorClass: "cancelled", finishReason: "stop",
    message: "secret:do-not-copy" }), current);
  sensor.capture(envelope(4, "file_write", { toolCallId: "write:long", path: "p".repeat(600) }), current);
  const facts = sensor.recentFacts();
  assert.deepEqual(facts.map(fact => fact.kind), ["file_write", "observation", "terminal", "file_write"]);
  assert.equal(facts[0]!.path, "output.csv");
  assert.equal(facts[0]!.toolCallId, "write:one");
  assert.equal(facts[1]!.component, "tool_cancel");
  assert.equal(facts[1]!.late, true);
  assert.equal(facts[1]!.ignored, "late_result");
  assert.equal(facts[2]!.reason, "cancelled");
  assert.equal(facts[2]!.cause, "user_cancelled");
  assert.equal(facts[2]!.errorClass, "cancelled");
  assert.equal(facts[2]!.executionId, current.executionId);
  assert.equal(facts[2]!.source?.eventId, "event:3");
  assert.equal(facts[3]!.path, undefined);
  assert.deepEqual(facts[3]!.omittedFields, ["path"]);
  assert.ok(!JSON.stringify(facts).includes("secret:do-not-copy"));
  assert.ok(!JSON.stringify(facts).includes("raw_unknown"));
  const context = sensor.roundContext(current);
  assert.ok(context.length <= 900);
  const data = JSON.parse(context.slice(context.indexOf("\n") + 1));

  assert.deepEqual(data.handoff.artifacts, ["source.csv"]);
  assert.equal(data.handoff.omittedArtifactRefs, 1);
  assert.deepEqual(data.dependencies, ["task:source"]);
  assert.equal(data.omittedDependencyRefs, 1);
  assert.ok(!context.includes("C:/"));
  assert.ok(!context.includes("dependency:ddd"));
});

test("round boundaries release current tool slots as unknown results, and late results match only their original work round", () => {
  const sensor = createCollaborationObjectiveObservations({ ...options, maxPendingTools: 2 }), one = round(), two = round({ round: 2 });

  sensor.roundPrepared(one);
  sensor.capture(envelope(1, "tool_use", { toolCallId: "old:one", name: "web_fetch" }, "child:r1"), one);
  sensor.capture(envelope(2, "tool_use", { toolCallId: "old:two", name: "exec_command" }, "child:r1"), one);
  sensor.roundCompleted(one);
  assert.equal(sensor.snapshot().pendingTools.length, 0);
  assert.equal(sensor.snapshot().unreturnedTools.length, 2);
  assert.ok(sensor.snapshot().unreturnedTools.every(tool => tool.kind === "tool_unreturned_at_boundary" && tool.boundary === "round_completed" && tool.status === undefined));
  sensor.roundPrepared(two);
  sensor.capture(envelope(3, "tool_use", { toolCallId: "current", name: "read_file" }, "child:r2"), two);
  sensor.capture(envelope(4, "tool_result", { toolCallId: "old:one", status: "succeeded" }, "child:r1"), one);
  assert.equal(sensor.snapshot().pendingTools.length, 1);
  assert.equal(sensor.snapshot().pendingTools[0]!.toolCallId, "current");
  assert.equal(sensor.snapshot().unreturnedTools.length, 1);
  assert.equal(sensor.snapshot().rounds[0]!.phase, "prepared");
  const late = sensor.recentFacts().find(fact => fact.kind === "tool_result" && fact.toolCallId === "old:one");
  assert.ok(late);
  assert.equal(late.toolName, "web_fetch");
  assert.equal(late.round, 1);
  assert.equal(late.resolvedFromBoundary, "round_completed");
  sensor.roundEnded(one, "cancelled");
  assert.equal(sensor.snapshot().pendingTools.length, 1, "a stale ended round cannot close the newer execution view");
  sensor.roundEnded(two, "cancelled");
  assert.equal(sensor.snapshot().pendingTools.length, 0);
  assert.equal(sensor.snapshot().unreturnedTools.length, 2);
  assert.ok(sensor.snapshot().unreturnedTools.every(tool => tool.boundary === "round_ended" && tool.status === "cancelled"));
  sensor.capture(envelope(5, "tool_result", { toolCallId: "old:two", status: "cancelled" }, "child:r1"), one);
  const lateEnded = sensor.recentFacts().find(fact => fact.kind === "tool_result" && fact.toolCallId === "old:two");
  assert.ok(lateEnded);
  assert.equal(lateEnded.toolName, "exec_command");
  assert.equal(lateEnded.resolvedFromBoundary, "round_ended");
  assert.equal(sensor.snapshot().rounds[0]!.phase, "ended");
  assert.equal(sensor.snapshot().pendingTools.length, 0);
  assert.match(sensor.snapshot().note, /not failure or proof of resource cleanup/);
});

test("late lifecycle callbacks cannot revive a completed round or end its replacement at the same logical round", () => {
  const sensor = createCollaborationObjectiveObservations(options), original = round();

  sensor.roundPrepared(original);
  sensor.roundDispatched(original, "request:original");
  sensor.roundCompleted(original);
  sensor.roundDispatched(original, "request:late");
  assert.equal(sensor.snapshot().rounds[0]!.phase, "completed");
  const replacement = round({ executionId: "execution:replacement" });
  sensor.roundPrepared(replacement);
  sensor.capture(envelope(1, "tool_use", { toolCallId: "replacement:tool", name: "read_file" }, "replacement:turn"), replacement);
  const revision = sensor.decisionRevision();
  sensor.roundEnded(original, "cancelled");
  sensor.roundCompleted(original);
  assert.equal(sensor.snapshot().rounds[0]!.identity.executionId, replacement.executionId);
  assert.equal(sensor.snapshot().rounds[0]!.phase, "prepared");
  assert.equal(sensor.snapshot().pendingTools.length, 1);
  assert.equal(sensor.decisionRevision(), revision, "ignored stale lifecycle callbacks do not invalidate PA's current inspection");
});

test("unreturned history is independently bounded and cloned without consuming new inflight capacity", () => {
  const sensor = createCollaborationObjectiveObservations({ ...options, maxFacts: 2, maxPendingTools: 1, maxUnreturnedTools: 2 });

  for (let index = 1; index <= 5; index++) {
    const current = round({ round: index });
    sensor.roundPrepared(current);
    sensor.capture(envelope(index, "tool_use", { toolCallId: `unknown:${index}`, name: "read_file" }, `child:r${index}`), current);
    sensor.roundCompleted(current);
    assert.equal(sensor.snapshot().pendingTools.length, 0);
  }

  const snapshot = sensor.snapshot();
  assert.deepEqual(snapshot.unreturnedTools.map(tool => tool.toolCallId), ["unknown:4", "unknown:5"]);
  assert.equal(snapshot.omitted.unreturnedTools, 3);
  const current = round({ round: 6 });
  sensor.roundPrepared(current);
  sensor.capture(envelope(6, "tool_use", { toolCallId: "new:inflight", name: "web_fetch" }, "child:r6"), current);
  const view = sensor.inspectionView();
  assert.equal(view.totals.pendingTools, 1);
  assert.equal(view.totals.unreturnedTools, 2);
  assert.ok(new TextEncoder().encode(JSON.stringify(view)).length <= 8192);
  assert.equal(sensor.recentFacts().filter(fact => fact.kind === "tool_pending").length, 1);
  Object.assign(snapshot.unreturnedTools[0]!, { toolName: "mutated snapshot" });

  if (view.unreturnedTools[0]) Object.assign(view.unreturnedTools[0], { toolName: "mutated inspection" });

  assert.ok(sensor.snapshot().unreturnedTools.every(tool => tool.toolName === "read_file"));
  assert.equal(sensor.snapshot().pendingTools[0]!.toolCallId, "new:inflight");
});
