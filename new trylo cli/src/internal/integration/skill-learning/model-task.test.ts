import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderEvent, ProviderPort, ProviderRequest } from "../../ports/provider.js";
import type { Envelope } from "../../protocol/envelope.js";
import type { SkillEpisode } from "../../learning/domains/skill/types.js";
import { createSkillTaskModel } from "./model-task.js";
import type { SkillTaskExtractionInput } from "./task-contract.js";

const allowance = { maxModelCalls: 1, maxInputBytes: 64_000, maxOutputTokens: 1024 };
const family = { id: "ts-parser-fix", intentClass: "parser-fix", checkKind: "unit_test" as const, language: "typescript", checkSchema: "node-assert-v1" };
const finish: ProviderEvent = { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
const usage: ProviderEvent = { type: "usage", usage: { mode: "snapshot", inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };

function event(kind = "check_result"): Envelope {
  return { protocolVersion: "0.0", eventId: "check-1", sequence: 1, timestamp: "2026-11-03T01:00:00Z", kind,
    sessionId: "s1", turnId: "t1", producerId: "runtime-checker", producerSequence: 1, payload: { status: "pass" } };
}

function input(): SkillTaskExtractionInput {
  return { workspaceId: "workspace", sessionId: "s1", turnId: "t1", taskText: "Fix the parser", fromSequence: 4,
    transcript: [
      { kind: "assistant_reasoning", sequence: 0, blockId: "r1", text: "HIDDEN_REASONING_NEVER_SEND", redacted: false },
      { kind: "tool_result", sequence: 1, toolCallId: "old", name: "run_shell", output: "old fail", truncated: false, outcome: "failed" },
      { kind: "user", sequence: 4, text: "Fix the parser" },
      { kind: "tool_call", sequence: 5, toolCallId: "read", name: "read_file", arguments: { path: "src/parser.ts", content: "PRIVATE_FILE_BODY" } },
      { kind: "tool_result", sequence: 6, toolCallId: "read", name: "read_file", output: "current parser input", outcome: "succeeded", truncated: false },
      { kind: "tool_call", sequence: 7, toolCallId: "check", name: "run_shell", arguments: { command: "node --test parser.test.ts", token: "PRIVATE_ARG_SECRET" } },
      { kind: "tool_result", sequence: 8, toolCallId: "check", name: "run_shell", output: "2 checks pass", outcome: "succeeded", truncated: false },
    ], events: [event()], qualification: { kind: "external_check", ref: "checker:check-1", outcome: "success", checks: [{ label: "parser assertions", eventId: "check-1" }] } };
}

function answer() {
  return { taskFamily: family, steps: [{ text: "Inspect the parser's input contract", sourceSequences: [5] },
    { text: "Run the parser's independent assertions", sourceSequences: [7] }], checks: [{ label: "parser assertions", eventIds: ["check-1"] }] };
}

function harness(response: string, events?: (signal: AbortSignal) => AsyncIterable<ProviderEvent>) {
  const requests: ProviderRequest[] = [];
  let forks = 0;
  const isolated: ProviderPort = { async *stream(request, signal) {
    requests.push(request);
    if (events !== undefined) {
      yield* events(signal);
      return;
    }
    yield { type: "text_delta", blockId: "text", text: response };
    yield usage;
    yield finish;
  } };
  const provider: ProviderPort = { fork: () => {
    forks += 1;
    return isolated;
  }, async *stream() { throw new Error("execution provider must not be used"); } };

  return { requests, forks: () => forks, provider };
}

test("actual tool pairs become model-normalized steps with immutable source qualification and measured usage", async () => {
  const fx = harness(JSON.stringify(answer()));
  const model = createSkillTaskModel({ provider: fx.provider, model: "configured-model", collection: () => "enabled" });
  const usedSkill = { versionId: "actual-version", variantId: "actual-variant", contentHash: "actual-content-hash" };
  const result = await model.extract({ ...input(), usedSkill }, allowance, new AbortController().signal);

  assert.equal(result.kind, "experience");

  if (result.kind !== "experience") return;

  assert.deepEqual(result.experience.episode.steps, answer().steps.map(step => step.text));
  assert.equal(result.experience.episode.outcome, "success");
  assert.deepEqual(result.experience.qualification, { kind: "external_check", ref: "checker:check-1" });
  assert.deepEqual(result.experience.usedSkill, usedSkill, "actual exposure attribution is supplied by runtime, not the model");
  assert.equal(result.experience.episode.trajectory.hadFailureRecovery, false, "old failures are outside this task");
  assert.deepEqual(result.derivation.stepSources.map(source => source.sequences), [[5], [7]]);
  assert.deepEqual(result.usage, { calls: 1, inputBytes: result.usage.inputBytes, usageStatus: "reported", inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  assert.deepEqual(fx.requests[0]?.tools, []);
  assert.equal(fx.requests[0]?.model, "configured-model");
  assert.equal(fx.requests[0]?.maxOutputTokens, 1024);
  const sent = JSON.stringify(fx.requests);

  assert.doesNotMatch(sent, /HIDDEN_REASONING_NEVER_SEND|PRIVATE_FILE_BODY|PRIVATE_ARG_SECRET|old fail/);
  assert.match(sent, /UNTRUSTED DATA/);
});

test("completed without a runtime check cannot manufacture successful experience or spend a model call", async () => {
  const fx = harness(JSON.stringify(answer()));
  const { qualification: _qualification, ...unqualified } = input();
  const result = await createSkillTaskModel({ provider: fx.provider, model: "model", collection: () => "enabled" })
    .extract(unqualified, allowance, new AbortController().signal);

  assert.equal(result.kind, "waiting");
  assert.equal(fx.forks(), 0);
  assert.equal(result.usage.calls, 0);
  const userAcceptance = await createSkillTaskModel({ provider: fx.provider, model: "model", collection: () => "enabled" })
    .extract({ ...input(), events: [event("user_correction")] }, allowance, new AbortController().signal);

  assert.equal(userAcceptance.kind, "waiting");
  assert.equal(fx.forks(), 0, "current user text cannot masquerade as an independently checked demonstration");
});

test("invented steps, checks, disclosure and model-authored outcome are refused", async () => {
  const invalid = [
    { ...answer(), steps: [{ text: "fabricated", sourceSequences: [3] }, answer().steps[1]] },
    { ...answer(), checks: [{ label: "parser assertions", eventIds: ["invented"] }] },
    { ...answer(), steps: [{ text: "Use token=PRIVATE", sourceSequences: [5] }, answer().steps[1]] },
    { ...answer(), outcome: "success" },
  ];
  for (const raw of invalid) {
    const fx = harness(JSON.stringify(raw));
    const result = await createSkillTaskModel({ provider: fx.provider, model: "model", collection: () => "enabled" }).extract(input(), allowance, new AbortController().signal);
    assert.equal(result.kind, "failed");
  }
});

test("true execution failure remains negative despite model normalization", async () => {
  const negative = { ...answer(), failureMode: "Parser assertions rejected the output", checks: [{ label: "parser output mismatch", eventIds: ["tool:error"] }] };
  const fx = harness(JSON.stringify(negative));
  const result = await createSkillTaskModel({ provider: fx.provider, model: "model", collection: () => "enabled" }).extract({ ...input(),
    qualification: { kind: "execution_failure", ref: "tool:error", outcome: "failure", failureMode: "parser output mismatch" } }, allowance, new AbortController().signal);
  assert.equal(result.kind, "experience");
  if (result.kind === "experience") {
    assert.equal(result.experience.episode.outcome, "failure");
    assert.equal(result.experience.qualification.kind, "execution_failure");
  }
});

test("one real run can retain failed and passed checks without inventing a second successful run", async () => {
  const positive = harness(JSON.stringify(answer()));
  const passed = await createSkillTaskModel({ provider: positive.provider, model: "model", collection: () => "enabled" })
    .extract({ ...input(), expectedFamily: family }, allowance, new AbortController().signal);
  const negative = harness(JSON.stringify({ ...answer(), failureMode: "parser assertions failed" }));
  const failed = await createSkillTaskModel({ provider: negative.provider, model: "model", collection: () => "enabled" })
    .extract({ ...input(), expectedFamily: family, qualification: { kind: "external_check", ref: "checker:earlier-failure", outcome: "failure", checks: [{ label: "parser assertions", eventId: "check-1" }] } }, allowance, new AbortController().signal);

  assert.equal(passed.kind, "experience");
  assert.equal(failed.kind, "experience");

  if (passed.kind === "experience" && failed.kind === "experience") {
    assert.notEqual(passed.experience.episode.id, failed.experience.episode.id);
    assert.equal(passed.experience.runId, failed.experience.runId);
    assert.equal([passed.experience, failed.experience].filter(item => item.episode.outcome === "success").length, 1);
  }

  const renamed = harness(JSON.stringify({ ...answer(), taskFamily: { ...family, id: "different-family" } }));
  const mismatch = await createSkillTaskModel({ provider: renamed.provider, model: "model", collection: () => "enabled" })
    .extract({ ...input(), expectedFamily: family }, allowance, new AbortController().signal);

  assert.equal(mismatch.kind, "failed");

  if (mismatch.kind === "failed") assert.equal(mismatch.reason, "skill_extraction_condition_mismatch");
});

test("explicit correction preserves exact scope and target without claiming a successful replacement", async () => {
  const fx = harness("must not be called"), target: SkillEpisode = { id: "prior-success", taskFamily: family,
    outcome: "success", steps: ["old action", "old check"], checks: ["parser assertions"], trajectory: { nodeIds: ["old-1", "old-2"], stepCount: 2, hadFailureRecovery: false, hadChecks: true } };
  const correction = { targetEpisodeIds: [target.id], scope: "task" as const, reason: "Only this task needs a different order" };
  const result = await createSkillTaskModel({ provider: fx.provider, model: "model", collection: () => "enabled" }).extract({ ...input(), transcript: [], priorEpisodes: [target],
    qualification: { kind: "explicit_correction", ref: "user_explicit:input-2", outcome: "failure", correction } }, allowance, new AbortController().signal);

  assert.equal(result.kind, "experience");
  assert.equal(fx.forks(), 0);

  if (result.kind === "experience") {
    assert.deepEqual(result.experience.episode.correction, correction);
    assert.equal(result.experience.episode.outcome, "failure");
  }
});

test("offered families need exact runtime conditions; unknown or contradictory facts do not broaden use", async () => {
  const response = JSON.stringify({ familyId: "family-a", evidence: [{ field: "intentClass", quote: "Fix the parser" }] });
  const fx = harness(response), model = createSkillTaskModel({ provider: fx.provider, model: "model", collection: () => "enabled" });
  const selection = { workspaceId: "workspace", currentTaskText: "Fix the parser", candidates: [{ familyId: "family-a", taskFamily: family }] };
  const unknown = await model.select(selection, allowance, new AbortController().signal);

  assert.equal(unknown.kind, "none");
  const wrong = await model.select({ ...selection, facts: { language: "rust" } }, allowance, new AbortController().signal);

  assert.equal(wrong.kind, "none");
  assert.equal(wrong.usage.calls, 0);
  const applicable = await model.select({ ...selection, facts: { language: "typescript", checkKind: "unit_test", checkSchema: "node-assert-v1" } }, allowance, new AbortController().signal);

  assert.equal(applicable.kind, "selected");
  const invented = harness(JSON.stringify({ familyId: "not-offered", evidence: [] }));

  assert.equal((await createSkillTaskModel({ provider: invented.provider, model: "model", collection: () => "enabled" })
    .select(selection, allowance, new AbortController().signal)).kind, "failed");
});

test("snapshot and delta usage are combined; missing usage is unknown, never zero", async () => {
  const fx = harness("", async function* () { yield { type: "text_delta", blockId: "text", text: JSON.stringify(answer()) };
  yield usage;
    yield { type: "usage", usage: { mode: "delta", inputTokens: 2, outputTokens: 3, totalTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };
  yield finish; });
  const result = await createSkillTaskModel({ provider: fx.provider, model: "model", collection: () => "enabled" }).extract(input(), allowance, new AbortController().signal);

  assert.equal(result.usage.totalTokens, 20);
  assert.equal(result.usage.inputTokens, 12);
  assert.equal(result.usage.outputTokens, 8);
  const missing = harness("", async function* () {
    yield { type: "text_delta", blockId: "text", text: JSON.stringify(answer()) };
    yield finish;
  });
  const noUsage = await createSkillTaskModel({ provider: missing.provider, model: "model", collection: () => "enabled" }).extract(input(), allowance, new AbortController().signal);

  assert.equal(noUsage.kind, "experience");
  assert.equal(noUsage.usage.usageStatus, "missing");
  assert.equal(noUsage.usage.totalTokens, undefined);
});

test("zero allocation, oversized input, disabled collection and cancelled work make no provider call", async () => {
  const fx = harness(JSON.stringify(answer())), model = createSkillTaskModel({ provider: fx.provider, model: "model", collection: () => "enabled" });

  assert.equal((await model.extract(input(), { ...allowance, maxModelCalls: 0 }, new AbortController().signal)).kind, "waiting");
  assert.equal((await model.extract(input(), { ...allowance, maxInputBytes: 5 }, new AbortController().signal)).kind, "waiting");
  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal((await model.extract(input(), allowance, cancelled.signal)).kind, "cancelled");
  const disabled = createSkillTaskModel({ provider: fx.provider, model: "model", collection: () => "disabled" });

  assert.equal((await disabled.extract(input(), allowance, new AbortController().signal)).kind, "disabled");
  assert.equal(fx.forks(), 0);
});

test("provider tools, missing isolation and truncated streams cannot become experience", async () => {
  const tool = harness("", async function* () {
    yield { type: "tool_call", toolCallId: "unsafe", name: "run_shell", arguments: {} };
    yield finish;
  });
  assert.equal((await createSkillTaskModel({ provider: tool.provider, model: "model", collection: () => "enabled" }).extract(input(), allowance, new AbortController().signal)).kind, "failed");
  const eof = harness("", async function* () { yield { type: "text_delta", blockId: "text", text: JSON.stringify(answer()) }; });
  assert.equal((await createSkillTaskModel({ provider: eof.provider, model: "model", collection: () => "enabled" }).extract(input(), allowance, new AbortController().signal)).kind, "failed");
  const provider: ProviderPort = { async *stream() { throw new Error("must remain unused"); } };
  assert.equal((await createSkillTaskModel({ provider, model: "model", collection: () => "enabled" }).extract(input(), allowance, new AbortController().signal)).kind, "failed");
});

test("cancellation and output budgets preserve measured spend but discard partial text", async () => {
  const controller = new AbortController();
  const cancelled = harness("", async function* () {
    yield usage;
    controller.abort();
    yield { type: "text_delta", blockId: "t", text: JSON.stringify(answer()) };
  });
  const result = await createSkillTaskModel({ provider: cancelled.provider, model: "model", collection: () => "enabled" }).extract(input(), allowance, controller.signal);

  assert.equal(result.kind, "cancelled");
  assert.equal(result.usage.totalTokens, 15);
  const overspent = harness("", async function* () {
    yield { ...usage, usage: { ...usage.usage, outputTokens: 2048 } };
    yield finish;
  });
  const capped = await createSkillTaskModel({ provider: overspent.provider, model: "model", collection: () => "enabled" }).extract(input(), allowance, new AbortController().signal);

  assert.equal(capped.kind, "failed");
  assert.equal(capped.usage.outputTokens, 2048);
});

test("correction interpretation returns grounded suggestions with explicit task/condition/family scope", async () => {
  const prior: SkillEpisode = { id: "prior", taskFamily: family, steps: ["inspect", "check"], checks: ["assert"], outcome: "success",
    trajectory: { nodeIds: ["a", "b"], stepCount: 2, hadChecks: true, hadFailureRecovery: false } };
  for (const [scope, text] of [["task", "这次只调整这个任务的顺序，先检查再修改"],
    ["condition", "以后这类解析任务先检查再修改"], ["family", "从现在起解析任务一律先检查再修改"]] as const) {
    const fx = harness(JSON.stringify({ scope, quote: text, targetEpisodeIds: [prior.id], reason: "先检查再修改" }));
    const result = await createSkillTaskModel({ provider: fx.provider, model: "model", collection: () => "enabled" })
      .interpretCorrection({ workspaceId: "workspace", currentUserText: text, priorEpisodes: [prior] }, allowance, new AbortController().signal);
    assert.equal(result.kind, "correction");
    if (result.kind === "correction") {
      assert.equal(result.quote, text);
      assert.equal(result.correction.scope, scope);
      assert.deepEqual(result.correction.targetEpisodeIds, [prior.id]);
    }
    assert.equal("qualification" in result, false, "interpretation cannot issue user evidence or success");
  }
});

test("unclear scope, broadening a one-time exception, invented quote or unoffered correction target is refused", async () => {
  const prior: SkillEpisode = { id: "prior", taskFamily: family, steps: ["inspect", "check"], checks: ["assert"], outcome: "success",
    trajectory: { nodeIds: ["a", "b"], stepCount: 2, hadChecks: true, hadFailureRecovery: false } };
  const text = "这次先检查再修改";

  for (const answer of [{ scope: "family", quote: text, targetEpisodeIds: [prior.id], reason: "先检查" },
    { scope: "task", quote: "没有说过的话", targetEpisodeIds: [prior.id], reason: "先检查" },
    { scope: "task", quote: text, targetEpisodeIds: ["unoffered"], reason: "先检查" },
    { scope: "task", quote: "先检查", targetEpisodeIds: [prior.id], reason: "先检查" }]) {
    const fx = harness(JSON.stringify(answer));
    const result = await createSkillTaskModel({ provider: fx.provider, model: "model", collection: () => "enabled" })
      .interpretCorrection({ workspaceId: "workspace", currentUserText: text, priorEpisodes: [prior] }, allowance, new AbortController().signal);
    assert.notEqual(result.kind, "correction");
  }
});

test("an unresponsive provider cannot outlive the learning deadline", async () => {
  const fx = harness("", async function* () {
    await new Promise<void>(() => { /* Deliberately unresponsive transport. */ });
    yield finish;
  });
  const result = await createSkillTaskModel({ provider: fx.provider, model: "model", collection: () => "enabled", timeoutMs: 1 })
    .extract(input(), allowance, new AbortController().signal);
  assert.equal(result.kind, "failed");
  if (result.kind === "failed") assert.equal(result.reason, "skill_model_timeout");
  assert.equal(result.usage.usageStatus, "missing");
  assert.equal(result.usage.totalTokens, undefined);
});

test("collection revoked during a model call discards partial material while preserving reported cost", async () => {
  let enabled = true;
  const fx = harness("", async function* () {
    yield usage;
    enabled = false;
    yield { type: "text_delta", blockId: "text", text: JSON.stringify(answer()) };
    yield finish;
  });
  const result = await createSkillTaskModel({ provider: fx.provider, model: "model", collection: () => enabled ? "enabled" : "disabled" })
    .extract(input(), allowance, new AbortController().signal);
  assert.equal(result.kind, "disabled");
  assert.equal(result.usage.totalTokens, 15);
  assert.equal("experience" in result, false);
});
