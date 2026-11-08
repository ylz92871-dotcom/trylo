import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { createSkillExperienceFile } from "../../integration/skill-learning/experience-file.js";
import { createSkillTaskModel } from "../../integration/skill-learning/model-task.js";
import { createSkillTaskQueue, SKILL_TASK_QUEUE_LOCK, type SkillTaskQueueInput } from "../../integration/skill-learning/task-queue.js";
import type { SkillTaskExtractionInput, SkillTaskExtractionResult } from "../../integration/skill-learning/task-contract.js";
import { contentHashOf, sha256Hex } from "../../learning/control/hash.js";
import type { ProviderPort } from "../../ports/provider.js";
import type { Envelope, JsonObject } from "../../protocol/envelope.js";
import type { Transcript } from "../../protocol/transcript.js";
import type { CliContext } from "./context.js";
import { qualifySkillTasks, type SkillDailyCheck } from "./skill-daily-checks.js";
import { processSkillTaskIntake } from "./skill-daily-intake.js";
import { sessionPath } from "./session-paths.js";

const AT = "2026-11-03T00:00:00.000Z", SESSION = "session-source", TURN = "turn-source", WORKSPACE = "workspace-source";
const FAMILY = { id: "json-report", intentClass: "normalize_report", checkKind: "acceptance" as const, language: "json", checkSchema: "report-v1" };
const CHECKER = "assert.deepEqual(actual, expected)";
const PROMPT = "Normalize this report while retaining zero-valued rows";
const USED = { versionId: "used-version", variantId: "used-variant", contentHash: contentHashOf("actual loaded method") };

function event(id: string, callId: string, outcome: "succeeded" | "failed", sequence: number): Envelope {
  return { protocolVersion: "0.0", eventId: id, sequence, timestamp: AT, sessionId: SESSION, turnId: TURN,
    producerId: "execution-owner", producerSequence: sequence, kind: "tool_result", payload: { toolCallId: callId, name: "run_shell", status: outcome,
      ...(outcome === "succeeded" ? { value: { exitCode: 0 }, output: "exact rows pass", truncated: false } : { message: "shell_nonzero_exit:1\nrow was lost" }) } };
}

function transcript(): Transcript {
  return [
    { kind: "user", sequence: 0, text: PROMPT },
    { kind: "tool_call", sequence: 1, name: "read_file", toolCallId: "read", arguments: { path: "input.json" } },
    { kind: "tool_result", sequence: 2, name: "read_file", toolCallId: "read", output: "rows", outcome: "succeeded", truncated: false },
    { kind: "tool_call", sequence: 3, name: "run_shell", toolCallId: "check-fail", arguments: { command: "node check.mjs" } },
    { kind: "tool_result", sequence: 4, name: "run_shell", toolCallId: "check-fail", output: "shell_nonzero_exit:1\nrow was lost", outcome: "failed", truncated: false },
    { kind: "tool_call", sequence: 5, name: "write_file", toolCallId: "repair", arguments: { path: "report.json", content: "repaired rows" } },
    { kind: "tool_result", sequence: 6, name: "write_file", toolCallId: "repair", output: "written", outcome: "succeeded", truncated: false },
    { kind: "tool_call", sequence: 7, name: "run_shell", toolCallId: "check-pass", arguments: { command: "node check.mjs" } },
    { kind: "tool_result", sequence: 8, name: "run_shell", toolCallId: "check-pass", output: "exact rows pass", outcome: "succeeded", truncated: false },
  ];
}

const EVENTS = [event("canonical-result-failure", "check-fail", "failed", 1), event("canonical-result-success", "check-pass", "succeeded", 2)];

function json(value: unknown): JsonObject { return JSON.parse(JSON.stringify(value)) as JsonObject; }

async function fixture(t: { after(fn: () => void): void }, options: { journal?: boolean; terminal?: boolean; fingerprintWorkspace?: string; events?: readonly Envelope[] } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-skill-intake-host-"));

  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("trylo-skill-intake-host-"));
    rmSync(root, { recursive: true, force: true });
  });
  const ctx: CliContext = { cwd: root, homeDir: root, env: { TRYLO_HOME: path.join(root, "profile") }, nodeVersion: "v24", stdinIsTty: false,

    readFile: file => { try { return readFileSync(file, "utf8"); } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    } },

    isDirectory: file => existsSync(file), readDir: () => [], writeFile: () => false,
    readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined, stdout: () => {}, stderr: () => {}, now: () => 0, newId: prefix => `${prefix}-fixed` };

  writeFileSync(path.join(root, "check.mjs"), CHECKER, "utf8");
  const check: SkillDailyCheck = { id: "report-check", label: "exact report assertions", command: "node check.mjs", taskFamily: FAMILY, verifierFiles: { "check.mjs": sha256Hex(CHECKER) } };
  const events = options.events ?? EVENTS;
  const qualified = qualifySkillTasks(ctx, root, transcript(), [check], 0, EVENTS);

  assert.equal(qualified.length, 2);
  const metadata = qualified.map(task => ({ workspaceId: WORKSPACE, sessionId: SESSION, turnId: TURN, fromSequence: 0,
    sourceSequence: task.sourceSequence, qualification: task.qualification, expectedFamily: FAMILY,
    checker: { id: check.id, command: check.command, verifierFiles: check.verifierFiles } } satisfies SkillTaskQueueInput));

  if (options.journal !== false) {
    const store = createNdjsonSessionStore({ path: sessionPath(ctx.homeDir, ctx.env, SESSION) });

    assert.ok((await store.start({ sessionId: SESSION, createdAt: AT, fingerprint: { schemaVersion: "1", providerId: "inert", model: "inert", toolCatalogHash: "tools", workspaceId: options.fingerprintWorkspace ?? WORKSPACE } })).ok);

    try {
      assert.ok((await store.append({ type: "turn_start", sessionId: SESSION, turnId: TURN, at: AT, payload: {} })).ok);
      for (const item of transcript()) assert.ok((await store.append({ type: "transcript_item", sessionId: SESSION, turnId: TURN, at: AT, payload: json(item) })).ok);
      for (const envelope of events) assert.ok((await store.append({ type: "envelope", sessionId: SESSION, turnId: TURN, at: AT, payload: { envelope: json(envelope) } })).ok);
      if (options.terminal !== false) assert.ok((await store.append({ type: "terminal", sessionId: SESSION, turnId: TURN, at: AT, payload: { reason: "completed" } })).ok);
    } finally { await store.release(); }
  }

  const factsRoot = path.join(root, "facts");
  const queue = createSkillTaskQueue({ root: factsRoot, workspaceId: WORKSPACE, collection: () => "enabled" });
  const history = createSkillExperienceFile({ root: factsRoot, workspaceId: WORKSPACE, collection: () => "enabled", retention: "segmented" });
  const captured: SkillTaskExtractionInput[] = [];
  const provider: ProviderPort = { async *stream() { throw new Error("inert provider must never execute"); } };
  const base = createSkillTaskModel({ provider, model: "inert", collection: () => "enabled" });
  let extract = async (input: SkillTaskExtractionInput): Promise<SkillTaskExtractionResult> => factResult(input);
  const model = () => ({ ...base, extract: async (input: SkillTaskExtractionInput) => {
    captured.push(input);
    return extract(input);
  } });

  return { root, ctx, factsRoot, queue, history, metadata, captured, setExtract: (fn: typeof extract) => { extract = fn; },
    run: (revision: string, options: { calls?: number; signal?: AbortSignal; onExtracted?: Parameters<typeof processSkillTaskIntake>[0]["onExtracted"] } = {}) => processSkillTaskIntake({
      ctx, root: factsRoot, workspaceId: WORKSPACE, revision, model, allowance: () => ({ maxModelCalls: options.calls ?? 1, maxInputBytes: 64000, maxOutputTokens: 1024 }),
      account: () => {}, maxTasks: 4, signal: options.signal ?? new AbortController().signal,
      ...(options.onExtracted === undefined ? {} : { onExtracted: options.onExtracted }),
    }) };
}

function factResult(input: SkillTaskExtractionInput): SkillTaskExtractionResult {
  const qualification = input.qualification;
  assert.ok(qualification);
  const id = `skill-episode:${contentHashOf([input.workspaceId, input.sessionId, input.turnId, qualification.kind, qualification.ref]).slice(0, 24)}`;

  return { kind: "experience", usage: { calls: 1, inputBytes: 1000, usageStatus: "reported", inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    experience: { workspaceId: input.workspaceId, runId: `${input.sessionId}:${input.turnId}`, sourceRef: `execution:${input.sessionId}:${input.turnId}#${qualification.ref}`,
      qualification: { kind: qualification.kind, ref: qualification.ref }, ...(input.usedSkill === undefined ? {} : { usedSkill: input.usedSkill }),
      episode: { id, outcome: qualification.outcome, taskFamily: input.expectedFamily ?? FAMILY,
        trajectory: { nodeIds: ["inspect", "check"], stepCount: 2, hadChecks: true, hadFailureRecovery: false },
        steps: ["inspect structured input", "run the existing exact checker"], checks: ["exact report assertions"],
        ...(qualification.outcome === "failure" ? { failureMode: "zero-valued row was lost" } : {}) } },
    derivation: { inputDigest: contentHashOf([input.fromSequence, qualification.ref]), stepSources: [{ step: "inspect structured input", sequences: [1] }],
      checkSources: qualification.kind === "external_check" ? qualification.checks.map(check => ({ check: check.label, eventIds: [check.eventId] })) : [] } };
}

test("real session journals restore distinct failure/success facts with canonical check events and exact usage", async t => {
  const fx = await fixture(t);

  for (const task of fx.metadata) assert.ok(fx.queue.enqueue(task).ok);

  assert.equal(fx.metadata[0]?.qualification.kind, "external_check");
  const result = await fx.run("grant-1");

  assert.equal(result.processed, 2);
  assert.equal(result.failed, 0);
  assert.equal(fx.captured.length, 2);
  assert.deepEqual(fx.captured.map(input => input.taskText), [PROMPT, PROMPT]);
  assert.deepEqual(fx.captured.map(input => input.transcript.at(-1)?.sequence), [4, 8]);
  assert.equal(fx.captured[0]?.usedSkill, undefined, "a checker result without a real earlier skill call has no skill attribution");
  assert.deepEqual(fx.captured[1]?.expectedFamily, FAMILY);
  const facts = fx.history.read("verify");
  assert.ok(facts.ok);
  assert.equal(facts.opportunity.experiences.length, 2);
  assert.equal(facts.opportunity.experiences[0]?.runId, facts.opportunity.experiences[1]?.runId);
  assert.notEqual(facts.opportunity.experiences[0]?.episode.id, facts.opportunity.experiences[1]?.episode.id);
  assert.deepEqual(facts.opportunity.experiences.map(fact => fact.episode.outcome), ["failure", "success"]);

  for (const input of fx.captured) {
    assert.ok(input.qualification?.kind === "external_check");
    assert.ok(input.qualification.checks.every(check => check.eventId.startsWith("canonical-result-")));
  }
});

for (const failure of ["missing-journal", "wrong-workspace", "missing-terminal", "wrong-turn", "invalid-schema", "tool-call-id-instead-of-event-id", "wrong-qualification-ref", "readiness-not-check-exit"] as const) {
  test(`journal recovery refuses ${failure} before calling the model`, async t => {
    const events = failure === "invalid-schema" ? EVENTS.map(item => ({ ...item, protocolVersion: "unrecognized" }))
      : failure === "readiness-not-check-exit" ? EVENTS.map(item => ({ ...item, payload: { toolCallId: item.payload.toolCallId!, status: "failed", message: "isolation_broken: command was not run" } })) : EVENTS;
    const fx = await fixture(t, { events, ...(failure === "missing-journal" ? { journal: false } : {}),
      ...(failure === "missing-terminal" ? { terminal: false } : {}), ...(failure === "wrong-workspace" ? { fingerprintWorkspace: "other-workspace" } : {}) });
    let task = fx.metadata[1]!;

    if (failure === "wrong-turn") task = { ...task, turnId: "unsettled-other-turn" };

    if (failure === "wrong-qualification-ref") task = { ...task, qualification: { ...task.qualification, ref: "execution:check:unrelated-call" } };

    if (failure === "tool-call-id-instead-of-event-id" && task.qualification.kind === "external_check") task = { ...task,
      qualification: { ...task.qualification, checks: [{ label: "exact report assertions", eventId: "check-pass" }] } };

    const queued = fx.queue.enqueue(task);

    assert.ok(queued.ok, JSON.stringify(queued));
    const result = await fx.run("grant-1");
    assert.equal(result.failed, 1);
    assert.equal(result.processed, 0);
    assert.equal(fx.captured.length, 0);
  });
}

test("journal recovery refuses an envelope carrying another session or turn", async t => {
  const fx = await fixture(t, { events: EVENTS.map(item => ({ ...item, sessionId: "foreign-session", turnId: "foreign-turn" })) });
  assert.ok(fx.queue.enqueue(fx.metadata[1]!).ok);
  const result = await fx.run("grant-1");
  assert.equal(result.failed, 1);
  assert.equal(result.processed, 0);
  assert.equal(fx.captured.length, 0);
});

async function factBeforeAck(t: { after(fn: () => void): void }, maxAttempts = 3) {
  const fx = await fixture(t);

  assert.ok(createSkillTaskQueue({ root: fx.factsRoot, workspaceId: WORKSPACE, collection: () => "enabled", maxAttempts }).enqueue(fx.metadata[1]!).ok);
  const lock = path.join(fx.factsRoot, SKILL_TASK_QUEUE_LOCK);

  await assert.rejects(fx.run("grant-before-crash", { onExtracted: () => writeFileSync(lock, "simulate ack writer unavailable", "utf8") }), /task_intake_locked/);
  unlinkSync(lock);
  const facts = fx.history.read("after-crash");
  assert.ok(facts.ok);
  assert.equal(facts.opportunity.experiences.length, 1);

  return fx;
}

test("a source fact committed before acknowledgement is recovered without another extraction", async t => {
  const fx = await factBeforeAck(t), before = fx.captured.length;
  fx.setExtract(async () => { throw new Error("a persisted source fact must not be extracted again"); });
  const result = await fx.run("grant-after-crash");
  assert.equal(result.processed, 1);
  assert.equal(fx.captured.length, before);
  const remaining = fx.queue.pending({ limit: 4, retryRevision: "another-grant" });
  assert.ok(remaining.ok);
  assert.equal(remaining.totalPending, 0);
});

test("recovery refuses a pre-existing source fact whose actual usage attribution disagrees with queued metadata", async t => {
  const fx = await fixture(t), task = { ...fx.metadata[1]!, usedSkill: USED };
  const enqueued = fx.queue.enqueue(task);
  assert.ok(enqueued.ok);
  assert.ok(enqueued.key);
  assert.ok(fx.queue.claim(enqueued.key, { retryRevision: "grant-before-crash" }).ok);
  const produced = factResult({ ...task, taskText: PROMPT, transcript: transcript(), events: EVENTS });
  assert.equal(produced.kind, "experience");

  if (produced.kind !== "experience") return;

  const { usedSkill, ...lostAttribution } = produced.experience;
  assert.ok(usedSkill);
  assert.ok(fx.history.append(lostAttribution).ok);
  await assert.rejects(fx.run("recovery-with-mismatch", { calls: 0 }), /task_fact_recovery_mismatch/);
  assert.equal(fx.captured.length, 0, "a conflict must neither be silently accepted nor trigger another extraction");
});

test("a queued usage claim with no successful canonical skill result is refused before model extraction", async t => {
  const fx = await fixture(t);
  assert.ok(fx.queue.enqueue({ ...fx.metadata[1]!, usedSkill: USED }).ok);
  const result = await fx.run("unproven-skill-use");
  assert.equal(result.processed, 0);
  assert.equal(result.failed, 1);
  assert.equal(fx.captured.length, 0);
});

test("reconciling a committed source fact needs no fresh model allowance", async t => {
  const fx = await factBeforeAck(t), before = fx.captured.length;
  const result = await fx.run("zero-model-recovery", { calls: 0 });
  assert.equal(result.processed, 1);
  assert.equal(fx.captured.length, before);
});

test("a fact committed on the final permitted attempt still reconciles after restart without a model call", async t => {
  const fx = await factBeforeAck(t, 1), before = fx.captured.length;
  const result = await fx.run("last-attempt-recovery", { calls: 0 });
  assert.equal(result.processed, 1);
  assert.equal(fx.captured.length, before);
});

test("abort while extraction is awaited prevents a late experience from being written", async t => {
  const fx = await fixture(t);
  assert.ok(fx.queue.enqueue(fx.metadata[1]!).ok);
  const controller = new AbortController();
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });

  fx.setExtract(async input => {
    entered();
    await wait;
    return factResult(input);
  });
  const running = fx.run("cancelled-grant", { signal: controller.signal });

  await ready;
  controller.abort();
  release();
  await running;
  const facts = fx.history.read("after-abort");
  assert.ok(facts.ok);
  assert.equal(facts.opportunity.experiences.length, 0);
});
