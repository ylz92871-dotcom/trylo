import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { contentHashOf } from "../../../../control/hash.js";
import type { Transcript } from "../../../../../protocol/transcript.js";
import type { JsonObject } from "../../../../../protocol/envelope.js";
import { recoverSessionRecordView } from "../../../../../adapters/session-store/ndjson.js";
import { skillExperience } from "../experience.js";
import { skillTaskReport } from "../control/task-report.js";
import { journalSkillExperience } from "./journal-experience.js";
import { journalExperienceFixture } from "./journal-experience-fixture.js";

const loaded = (name: string, body = "Read the actual inputs before choosing the repair."): Transcript => [
  { sequence: 0, kind: "system", text: "PRIVATE_CHILD_SYSTEM" },
  { sequence: 1, kind: "assistant_reasoning", blockId: "reason", redacted: false, text: "PRIVATE_CHILD_THINKING" },
  { sequence: 2, kind: "tool_call", toolCallId: "shared", name: "mcp__trylo-hermes-skills__skill_view", arguments: { name } },
  { sequence: 3, kind: "tool_result", toolCallId: "shared", name: "mcp__trylo-hermes-skills__skill_view", outcome: "succeeded", truncated: false,
    output: JSON.stringify({ success: true, name, content: body }) },
];

function object(value: unknown): JsonObject {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as JsonObject;
}

function children(experience: unknown): JsonObject[] {
  assert.ok(experience && typeof experience === "object" && "delegatedTasks" in experience && Array.isArray(experience.delegatedTasks));
  return experience.delegatedTasks.map(object);
}

function firstChild(experience: unknown): JsonObject {
  const child = children(experience)[0];
  assert.ok(child);
  return child;
}

test("canonical checkpoint exchanges reach the opportunity with separate parent/child provenance and native hashes", async t => {
  const fx = await journalExperienceFixture(t), turn = fx.turn("work");
  await turn.start("Fix the report with a delegated investigation.");
  await turn.spawn("task", "shared");
  const transcript: Transcript = [...loaded("resolved-procedure"),
    { sequence: 4, kind: "user", text: "PRIVATE_FIRST_EXECUTION_ROLE\nTask: first assignment" },
    { sequence: 5, kind: "user", text: "PRIVATE_RESUMED_ROLE\nTask: resumed assignment" },
    { sequence: 6, kind: "tool_call", toolCallId: "shared", name: "run_shell", arguments: { command: "node report --old" } },
    { sequence: 7, kind: "tool_result", toolCallId: "shared", name: "run_shell", outcome: "failed", truncated: false, output: "The report omitted empty groups." },
    { sequence: 8, kind: "tool_call", toolCallId: "repair", name: "apply_patch", arguments: { path: "report.ts", patch: "retain empty groups", api_key: "synthetic-child-secret" } },
    { sequence: 9, kind: "tool_result", toolCallId: "repair", name: "apply_patch", outcome: "succeeded", truncated: false, output: "Patch applied; quality not yet independently checked." }];

  await turn.checkpoint("task", "task", transcript);
  await turn.event("subagent_end", { taskId: "task", subagentId: "task", toolCallId: "shared", status: "completed" }, "att-root-shared");
  await turn.terminal();
  const opportunity = await fx.opportunity("work");
  assert.ok(opportunity?.experience);
  const child = firstChild(opportunity.experience);

  assert.deepEqual(child.namespace, { parentSessionId: fx.sessionId, parentTurnId: "work", parentToolCallId: "shared",
    rootAttemptId: "att-root-shared", taskId: "task", agentId: "task" });
  assert.equal(child.source, "checkpoint");
  assert.equal(child.terminalObserved, true);
  assert.equal(child.terminalStatus, "completed");
  assert.equal(child.partial, false);
  assert.match(String(child.lifecycleInterpretation), /not verified task quality/);
  assert.match(JSON.stringify(object(child.experience).messages), /node report --old/);
  assert.match(JSON.stringify(object(child.experience).messages), /retain empty groups/);
  assert.deepEqual(object(child.experience).skillReads, [{ name: "resolved-procedure", contentHash: contentHashOf("Read the actual inputs before choosing the repair."),
    toolCallId: "shared", sequence: 3 }]);
  assert.equal(object(child.experience).omittedRuntimeComposedInputs, 2);
  assert.doesNotMatch(JSON.stringify(opportunity), /PRIVATE_|roleBinding|forkMessages|allowedTools|tokenLimit/);
  assert.equal(opportunity.experience.loadedSkills instanceof Array && opportunity.experience.loadedSkills.length, 0,
    "a child instruction read is not relabeled as a parent instruction read");
  // Exercise the actual native prompt preparation/sanitisation boundary, with
  // no model execution or Python/provider transport in this contract.
  const require = createRequire(import.meta.url);
  const { createNativeReviewBackend } = require("./review-backend.mjs");
  const backend = createNativeReviewBackend({ loadPrompt: async () => ({ success: true, prompt: "Official review guidance fixture." }) });
  const storage = { root: "child-record-contract", memento: { get: (_key: string, fallback: unknown) => fallback, update: async () => {} },
    compatibility: { pendingList: async () => ({ ok: true, pending: [] }) } };
  const prepared = await backend.begin(storage, opportunity, "child-record-contract");

  try {
    assert.equal(prepared.status, "ready");
    assert.match(prepared.prompt, /node report --old/);
    assert.match(prepared.prompt, /retain empty groups/);
    assert.doesNotMatch(prepared.prompt, /PRIVATE_|synthetic-child-secret/);
  } finally { backend.release(storage, "child-record-contract"); }
});

test("canonical provided names and hashes stay distinct from reads and enable only prior-turn feedback facts", async t => {
  const fx = await journalExperienceFixture(t), turn = fx.turn("provided");
  await turn.start("Use the explicitly provided native procedure.");
  const teamMember = { teamRunId: "team", memberId: "worker" };

  await turn.spawn("provided-task", "provided-call", { teamMember });
  const fact = { kind: "skill_context_provided", version: 1, origin: "hermes", source: "team_selection", ...teamMember,
    taskId: "provided-task", subagentId: "provided-task", rootAttemptId: "att-root-provided-call", parentToolCallId: "provided-call",
    requestId: "first-request", round: 1, skills: [{ name: "native-provided", contentHash: contentHashOf("The exact supplied native content.") }] };

  await turn.event("observation", fact, fact.rootAttemptId);
  await turn.event("observation", { ...fact, requestId: "duplicate-request" }, fact.rootAttemptId);
  await turn.event("observation", { ...fact, memberId: "foreign-member", skills: [{ name: "FOREIGN_PROVISION", contentHash: contentHashOf("foreign") }] }, fact.rootAttemptId);
  await turn.event("observation", { ...fact, prompt: "PRIVATE_PROVISION_BODY", skills: [{ name: "UNSAFE_PROVISION", contentHash: contentHashOf("unsafe") }] }, fact.rootAttemptId);
  await turn.event("observation", { ...fact, skills: [{ name: "PREFIXED_HASH", contentHash: `sha256:${contentHashOf("bad prefix")}` }] }, fact.rootAttemptId);
  await turn.terminal();
  const initial = await fx.opportunity("provided", observed => {
    assert.deepEqual(observed.priorProvidedSkills, []);
    assert.deepEqual(observed.priorLoadedSkills, []);
  });
  assert.ok(initial?.experience);
  const child = firstChild(initial.experience), entries = child.providedSkills;
  assert.ok(Array.isArray(entries));
  assert.equal(entries.length, 1);
  assert.equal(object(entries[0]).name, "native-provided");
  assert.equal(object(entries[0]).requestId, "first-request");
  assert.equal(object(entries[0]).contentHash, contentHashOf("The exact supplied native content."));
  assert.deepEqual(object(child.experience).skillReads, []);
  assert.deepEqual(object(child.experience).loadedSkills, []);
  assert.doesNotMatch(JSON.stringify(initial), /PRIVATE_PROVISION_BODY|UNSAFE_PROVISION|FOREIGN_PROVISION|PREFIXED_HASH/);
  const feedback = fx.turn("provided-feedback");
  await feedback.start("Correction: the supplied procedure needs an empty-group step.");
  await feedback.terminal();
  let report: ReturnType<typeof skillTaskReport>;

  await fx.opportunity("provided-feedback", observed => {
    assert.deepEqual(observed.priorProvidedSkills, ["native-provided"]);
    assert.deepEqual(observed.priorLoadedSkills, []);
    report = skillTaskReport({ sessionId: fx.sessionId, turnId: "provided-feedback", transcript: observed.transcript,
      historyLoadedSkills: observed.priorLoadedSkills, historyProvidedSkills: observed.priorProvidedSkills });
  });
  assert.ok(report);
  assert.match(report.facts.join("\n"), /Earlier explicitly provided Hermes skills in the same session: 1/);
  assert.match(report.facts.join("\n"), /Earlier successful skill loads in the same session: 0/);
});

test("future checkpoints, mismatched roots and unsettled unrelated parent calls cannot contaminate an old source", async t => {
  const fx = await journalExperienceFixture(t), turn = fx.turn("source");
  await turn.start("Inspect the source task.");
  await turn.spawn("task", "good");
  await turn.checkpoint("task", "task", loaded("eligible"));
  await turn.spawn("foreign-root", "foreign-call", { root: "att-root-someone-else" });
  await turn.checkpoint("foreign-root", "foreign-root", loaded("FOREIGN_ROOT"));
  await turn.spawn("unsettled", "unfinished", { settle: "unsettled" });
  await turn.checkpoint("unsettled", "unsettled", loaded("UNSETTLED_CHILD"));
  await turn.terminal();
  await turn.event("subagent_end", { taskId: "task", subagentId: "task", toolCallId: "good", status: "completed" }, "att-root-good");
  const future = fx.turn("future");
  await future.start("A later task after the selected source.");
  await future.spawn("task", "resume", { agentId: "task-v2", resumedFrom: "task" });
  await future.checkpoint("task", "task-v2", loaded("FUTURE_CHILD"), 2);
  await future.terminal();
  const opportunity = await fx.opportunity("source");
  assert.ok(opportunity?.experience);
  assert.equal(children(opportunity.experience).length, 1);
  assert.equal(firstChild(opportunity.experience).terminalObserved, false);
  assert.equal(firstChild(opportunity.experience).partial, true);
  assert.match(JSON.stringify(opportunity.experience), /eligible/);
  assert.doesNotMatch(JSON.stringify(opportunity.experience), /FOREIGN_ROOT|UNSETTLED_CHILD|FUTURE_CHILD|task-v2/);
});

test("missing checkpoint uses only namespaced visible tool/result observations and declares partial evidence", async t => {
  const fx = await journalExperienceFixture(t), turn = fx.turn("delegate");
  await turn.start("Inspect through the legacy delegate.");
  await turn.spawn("legacy-task", "legacy-call", { toolName: "delegate_subagent" });
  const event = (observation: JsonObject) => turn.event("subagent_update",
    { taskId: "legacy-task", subagentId: "legacy-task", observation }, "att-root-legacy-call");

  await event({ id: "thinking", round: 1, kind: "thinking", text: "PRIVATE_OBSERVATION_THINKING" });
  await event({ id: "report", round: 1, kind: "report", text: "PRIVATE_REPORT_NOT_TOOL_EVIDENCE", reportState: "ready" });
  await event({ id: "read", round: 1, kind: "tool", tool: "read_file", input: { path: "rows.json" } });
  await event({ id: "read", round: 1, kind: "result", tool: "read_file", ok: true, text: "Visible actual rows" });
  await event({ id: "orphan", round: 1, kind: "result", tool: "read_file", ok: true, text: "ORPHAN_RESULT" });
  await turn.event("subagent_update", { taskId: "legacy-task", subagentId: "legacy-task",
    observation: { id: "forged", round: 1, kind: "tool", tool: "read_file", input: { path: "WRONG_ROOT" } } }, "att-root-other");
  await turn.event("subagent_end", { taskId: "legacy-task", subagentId: "legacy-task", toolCallId: "legacy-call", status: "failed" }, "att-root-legacy-call");
  await turn.terminal();
  const opportunity = await fx.opportunity("delegate");
  assert.ok(opportunity?.experience);
  const child = firstChild(opportunity.experience);

  assert.equal(child.source, "bounded_observations");
  assert.equal(child.partial, true);
  assert.equal(child.terminalObserved, true);
  assert.equal(child.terminalStatus, "failed");
  assert.match(JSON.stringify(child), /rows.json/);
  assert.match(JSON.stringify(child), /Visible actual rows/);
  assert.doesNotMatch(JSON.stringify(child), /PRIVATE_|ORPHAN_RESULT|WRONG_ROOT/);
});

test("pure later user feedback sees earlier child loads without labeling current child reads as prior", async t => {
  const fx = await journalExperienceFixture(t), first = fx.turn("initial");
  await first.start("Use a procedure in the child.");
  await first.spawn("earlier-task", "earlier-call");
  await first.checkpoint("earlier-task", "earlier-task", loaded("earlier-child-procedure"));
  await first.terminal();
  const feedback = fx.turn("feedback");
  await feedback.start("Correction: include the empty groups too.");
  await feedback.terminal();
  let sensor: ReturnType<typeof skillTaskReport>;
  const opportunity = await fx.opportunity("feedback", observed => {
    assert.deepEqual(observed.priorLoadedSkills, ["earlier-child-procedure"]);
    sensor = skillTaskReport({ sessionId: fx.sessionId, turnId: "feedback", transcript: observed.transcript, historyLoadedSkills: observed.priorLoadedSkills });
  });

  assert.ok(sensor);
  assert.match(sensor.facts.join("\n"), /Earlier successful skill loads in the same session: 1/);
  assert.ok(opportunity?.experience);
  assert.match(JSON.stringify(opportunity.experience), /earlier-child-procedure/);
  const current = fx.turn("current");
  await current.start("Use another procedure now.");
  await current.spawn("current-task", "current-call");
  await current.checkpoint("current-task", "current-task", loaded("current-only-procedure"));
  await current.terminal();
  await fx.opportunity("current", observed => assert.deepEqual(observed.priorLoadedSkills, ["earlier-child-procedure"]));
});

test("latest resumed checkpoint is included once and invalid latest checkpoint never substitutes older content", async t => {
  const fx = await journalExperienceFixture(t), turn = fx.turn("resume");
  await turn.start("Continue the same delegated task.");
  await turn.spawn("stable", "first");
  await turn.checkpoint("stable", "stable", loaded("old"));
  await turn.spawn("stable", "second", { agentId: "stable-v2", resumedFrom: "stable" });
  await turn.checkpoint("stable", "stable-v2", loaded("new"), 2);
  await turn.terminal();
  const opportunity = await fx.opportunity("resume");
  assert.ok(opportunity?.experience);
  const child = firstChild(opportunity.experience);
  assert.equal(children(opportunity.experience).length, 1);
  assert.equal(object(child.namespace).agentId, "stable-v2");
  assert.equal(child.round, 2);
  assert.match(JSON.stringify(child), /"new"/);
  const invalid = fx.turn("invalid");
  await invalid.start("Continue after a broken snapshot.");
  await invalid.spawn("stable", "third", { agentId: "stable-v3", resumedFrom: "stable-v2" });
  await invalid.event("observation", { component: "checkpoint", scope: "subagent", subagentId: "stable-v3",
    checkpointPart: { taskId: "stable", invalid: true } }, "att-checkpoint-invalid");
  await invalid.terminal();
  const broken = await fx.opportunity("invalid");
  assert.ok(broken?.experience);
  const unavailable = firstChild(broken.experience);
  assert.equal(unavailable.source, "checkpoint_unavailable");
  assert.equal(unavailable.experience, undefined);
  assert.doesNotMatch(JSON.stringify(unavailable), /"old"|"new"/);
});

test("parent and child share a 40000 character budget while child-free projection only adds bounded source facts", async t => {
  const fx = await journalExperienceFixture(t), turn = fx.turn("budget");
  await turn.start("Parent history ".repeat(700));

  for (let index = 0; index < 8; index++) {
    await turn.item({ kind: "tool_call", toolCallId: `parent-${index}`, name: "read_file", arguments: { path: `parent-${index}` } });
    await turn.item({ kind: "tool_result", toolCallId: `parent-${index}`, name: "read_file", outcome: "succeeded", truncated: false, output: "parent-visible ".repeat(550) });
  }

  const beforeChildren = await turn.terminal(), view = await fx.store.readRecords();
  assert.ok(view.ok);
  const recovered = recoverSessionRecordView(view.view);
  assert.ok(recovered.ok);
  const plain = journalSkillExperience({ records: view.view.records, history: recovered.session.transcript,
    source: { sessionId: fx.sessionId, turnId: "budget", terminalSequence: beforeChildren } });
  const sourceOverhead = JSON.stringify({ sourceContext: plain.sourceContext }).length - 1;

  assert.deepEqual(plain.experience, { ...skillExperience(recovered.session.transcript, 40_000 - sourceOverhead), sourceContext: plain.sourceContext });
  const later = fx.turn("with-children");
  await later.start("Use the observed parent history and a child.");
  await later.spawn("large-child", "large-call");
  const transcript: Transcript = Array.from({ length: 20 }, (_, index) => [
    { sequence: index * 2, kind: "tool_call" as const, toolCallId: `child-${index}`, name: "read_file", arguments: { path: `child-${index}` } },
    { sequence: index * 2 + 1, kind: "tool_result" as const, toolCallId: `child-${index}`, name: "read_file", outcome: "succeeded" as const,
      truncated: false, output: "child-visible ".repeat(550) },
  ]).flat();

  await later.checkpoint("large-child", "large-child", transcript);
  await later.terminal();
  const result = await fx.opportunity("with-children");
  assert.ok(result?.experience);
  assert.ok(JSON.stringify(result.experience).length <= 40_000);
  assert.ok(JSON.stringify(children(result.experience)).length <= 16_000);
  assert.equal(children(result.experience).length, 1);
  assert.equal(object(firstChild(result.experience).experience).truncated, true);
  assert.ok(JSON.stringify(object(firstChild(result.experience).experience)).length <= 12_000);
  assert.match(JSON.stringify(result.experience.messages), /parent-visible/);
});

test("bounded prior skill hints survive omission of an oversized child provision detail", async t => {
  const fx = await journalExperienceFixture(t), first = fx.turn("large-provision");
  await first.start("Provide selected native procedures.");
  const teamMember = { teamRunId: "team", memberId: "worker" };

  await first.spawn("large-provided-task", "large-provided-call", { teamMember });
  const names = Array.from({ length: 32 }, (_, index) => `procedure-${index}-${"x".repeat(490)}`);

  await first.event("observation", { kind: "skill_context_provided", version: 1, origin: "hermes", source: "team_selection", ...teamMember,
    taskId: "large-provided-task", subagentId: "large-provided-task", rootAttemptId: "att-root-large-provided-call",
    parentToolCallId: "large-provided-call", requestId: "large-provision-request", round: 1,
    skills: names.map(name => ({ name, contentHash: contentHashOf(name) })) }, "att-root-large-provided-call");
  await first.terminal();
  const feedback = fx.turn("large-feedback");
  await feedback.start("Correction: improve the previously supplied procedures.");
  const terminalSequence = await feedback.terminal();
  const opportunity = await fx.opportunity("large-feedback", observed => assert.equal(observed.priorProvidedSkills.length, 32));
  assert.ok(opportunity?.experience);
  assert.deepEqual(children(opportunity.experience), []);
  assert.equal(opportunity.experience.omittedDelegatedTasks, 1);
  assert.ok(Array.isArray(opportunity.experience.priorProvidedSkills));
  assert.ok(opportunity.experience.priorProvidedSkills.length > 0);
  assert.ok(Number(opportunity.experience.omittedPriorProvidedSkills) > 0);
  const hints = Object.fromEntries(Object.entries(opportunity.experience).filter(([key]) => key.startsWith("prior") || key.startsWith("omittedPrior")));

  assert.ok(JSON.stringify(hints).length <= 4000);
  assert.ok(JSON.stringify(opportunity.experience).length <= 40_000);
  assert.deepEqual(opportunity.experience.priorLoadedSkills, []);
  const view = await fx.store.readRecords();
  assert.ok(view.ok);
  const recovered = recoverSessionRecordView(view.view);
  assert.ok(recovered.ok);
  const small = journalSkillExperience({ records: view.view.records, history: recovered.session.transcript,
    source: { sessionId: fx.sessionId, turnId: "large-feedback", terminalSequence }, maxChars: 2048,
    terminal: { reason: "r".repeat(128), finishReason: "f".repeat(128),
      interpretation: "Canonical terminal, not verified task quality." } });

  assert.ok(JSON.stringify(small.experience).length <= 2048, "a small source budget must reserve space for parent context before prior hints");
  assert.equal(small.sourceContext.currentUserAttribution, "not_recorded");
  assert.deepEqual(small.experience.sourceContext, small.sourceContext);
  const oversizedTerminal = journalSkillExperience({ records: view.view.records, history: recovered.session.transcript,
    source: { sessionId: fx.sessionId, turnId: "large-feedback", terminalSequence }, maxChars: 2048,
    terminal: { reason: "arbitrary-terminal-detail".repeat(500) } });

  assert.equal(oversizedTerminal.experience.terminal, undefined);
  assert.equal(oversizedTerminal.experience.terminalOmitted, true);
  assert.equal(oversizedTerminal.sourceContext.currentUserAttribution, "not_recorded");
  assert.ok(JSON.stringify(oversizedTerminal.experience).length <= 2048);
});

test("terminal evidence accepts bounded strings only and cannot expand the combined transport limit", async t => {
  const fx = await journalExperienceFixture(t), turn = fx.turn("terminal-shape");
  await turn.start("Observe terminal fields as execution facts.");
  await turn.terminal({ reason: { private: "ARBITRARY_TERMINAL_OBJECT" }, finishReason: "f".repeat(10_000) });
  const opportunity = await fx.opportunity("terminal-shape");
  assert.ok(opportunity?.experience);
  const terminal = object(opportunity.experience.terminal);

  assert.equal(terminal.reason, "unknown");
  assert.equal(terminal.finishReason, "f".repeat(128));
  assert.ok(JSON.stringify(opportunity.experience).length <= 40_000);
  assert.doesNotMatch(JSON.stringify(opportunity), /ARBITRARY_TERMINAL_OBJECT/);
});

test("a third-party same-shaped skill_view is visible tool evidence but cannot create prior Hermes reads or pure-feedback eligibility", async t => {
  const fx = await journalExperienceFixture(t), first = fx.turn("foreign-read");
  await first.start("Read another library's instructions.");
  const name = "mcp__other-library__skill_view";

  await first.item({ kind: "tool_call", toolCallId: "foreign", name, arguments: { name: "same-shaped-procedure" } });
  await first.item({ kind: "tool_result", toolCallId: "foreign", name, outcome: "succeeded", truncated: false,
    output: JSON.stringify({ success: true, name: "same-shaped-procedure", content: "Third-party instructions." }) });
  await first.terminal();
  const initial = await fx.opportunity("foreign-read");
  assert.ok(initial?.experience);
  assert.deepEqual(initial.experience.loadedSkills, []);
  assert.deepEqual(initial.experience.skillReads, []);
  assert.match(JSON.stringify(initial.experience.messages), /Third-party instructions/);
  const feedback = fx.turn("foreign-feedback");
  await feedback.start("The earlier instructions missed an edge case.");
  await feedback.terminal();
  let report: ReturnType<typeof skillTaskReport>;
  const subsequent = await fx.opportunity("foreign-feedback", observed => {
    assert.deepEqual(observed.priorLoadedSkills, []);
    assert.deepEqual(observed.priorProvidedSkills, []);
    report = skillTaskReport({ sessionId: fx.sessionId, turnId: "foreign-feedback", transcript: observed.transcript,
      historyLoadedSkills: observed.priorLoadedSkills, historyProvidedSkills: observed.priorProvidedSkills });
  });

  assert.ok(subsequent);
  assert.equal(report, undefined);
});
