import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// This is a real-provider acceptance runner, never part of the production graph.
// The only private input read is the configured provider credential; it goes
// directly to the existing adapter and is excluded from every recorded value.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const buildDir = path.resolve(root, arg("build-dir") ?? "dist");
const runId = new Date().toISOString().replaceAll(/[:.]/g, "-");
const evidence = path.resolve(arg("out") ?? path.join(root,
  "docs/02-分期工程产出/P05-Experience-Learning-V0.3/evidence/2026-11-03-collaboration-learning/real", runId));

mkdirSync(evidence, { recursive: true });

const save = (name, value) => {
  const target = path.join(evidence, name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
};
const digest = value => createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();
const load = name => import(pathToFileURL(path.join(buildDir, "internal", `${name}.js`)).href);
const modules = await Promise.all([
  load("adapters/credentials/compose"), load("adapters/provider/openai-compatible"),
  load("adapters/tools/index"), load("adapters/sandbox/index"), load("surface/cli/wiring-subagent"),
  load("learning/domains/collaboration/index"), load("integration/collaboration-learning/board-port"),
  load("integration/collaboration-learning/runtime"), load("protocol/subagent-handoff"),
]);
const [{ createCredentialPort }, { createOpenAiCompatibleProvider }, { createWorkspaceTools },
  { createWorkspaceSandbox }, { buildSubagentPorts }, { createCollaborationLearning },
  { createFileCollaborationBoard }, { createCollaborationRuntime }, { isSubagentHandoff }] = modules;

async function providerFor() {
  const profile = process.env.TRYLO_ACCEPTANCE_HOME ?? path.join(homedir(), ".trylo");
  const declarations = JSON.parse(readFileSync(path.join(profile, "providers.json"), "utf8"));
  const declared = declarations.providers.find(value => value.id === declarations.selected);

  assert.equal(declared?.kind, "openai-compatible", "acceptance requires a configured Chat-compatible provider");
  const credentials = createCredentialPort({ homeDir: profile, projectDir: root, env: process.env, now });
  const resolved = credentials.getAccount({ providerId: "openai-compatible", accountId: declared.accountId });

  assert.ok(resolved.ok, "the configured account must resolve through CredentialPort");
  const model = arg("model") ?? declared.model;
  const provider = createOpenAiCompatibleProvider({ endpoint: declared.endpoint, model,
    apiKey: resolved.value.secret, maxAttemptsBeforeHeaders: 3, baseRetryDelayMs: 1000 });

  save("provider.json", { provider: declared.id, origin: new URL(declared.endpoint).origin,
    configuredModel: declared.model, model, modelOverride: model !== declared.model, credentialLayer: resolved.value.layer });
  const events = [];

  for await (const event of provider.stream({ attemptId: "collaboration-acceptance-preflight", model,
    messages: [{ role: "user", content: "Reply READY only." }], tools: [], maxOutputTokens: 512 }, AbortSignal.timeout(60_000))) {
    if (event.type === "error" || event.type === "text_delta" || event.type === "finish") events.push(event);
  }

  save("preflight.json", events);
  assert.ok(events.filter(event => event.type === "text_delta").map(event => event.text).join("").includes("READY"), "real provider preflight failed");

  return { provider, model };
}

const permission = {
  inheritance: {
    canUseTool: name => ["read_file", "write_file"].includes(name),
    decide: action => ({ resolution: ["read_file", "write_file"].includes(action.name) ? "approved" : "denied", scope: "once" }),
  },
  request: async action => ({ ticketId: action.toolCallId, toolCallId: action.toolCallId }),
  awaitDecision: async () => ({ resolution: "denied", scope: "once" }),
};
const rolePrompt = {
  architect: "You prepare an accurate handoff for a dependent implementation member. Read the supplied acceptance brief. Return only JSON with scope, artifacts[], evidence[], pending[], blockers[]. Never modify files.",
  worker: "Implement only the assigned declarative mapping JSON using read_file and write_file. The file has exactly sourceField, targetField and scale. Use the source and target field names specified in the task. Follow a supplied collaboration procedure when one exists. Otherwise use the fast lane: unstated unit scale defaults to 1 and do not interrupt the pipeline for clarification. If the collaboration procedure requires missing handoff context, report NEED_HANDOFF before writing. Do not explore or guess filenames; read only the paths supplied by the task or handoff. Finish with a short result after writing. Do not invent verification evidence.",
  reviewer: "Independently read the given mapping, source and acceptance brief. Check the numeric result and handoff completeness. Report PASS or FAIL with the observed values. Never edit files or approve yourself.",
};

function teamFor(id) {
  return { runId: id, surface: "code", members: ["architect", "worker", "reviewer"].map(role => ({
    memberId: role, baseRole: role, displayName: role,
    role: { name: role, description: role, prompt: rolePrompt[role], allowedTools: role === "worker"
      ? ["read_file", "write_file"] : ["read_file"] },
  })) };
}

function makeCase(id, sourceField, targetField, raw, scale) {
  const dir = path.join(evidence, "workspaces", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "source.json"), JSON.stringify({ [sourceField]: raw }));
  writeFileSync(path.join(dir, "acceptance-brief.json"), JSON.stringify({ sourceField, targetField, scale,
    expected: raw * scale, reason: "The producer's acceptance brief fixes units; the raw export does not encode units." }));
  return { id, dir, sourceField, targetField, raw, scale, expected: raw * scale };
}

function checkMapping(item, stage) {
  const file = path.join(item.dir, "mapping.json");
  let mapping, parseError;

  if (existsSync(file)) {
    try { mapping = JSON.parse(readFileSync(file, "utf8")); }
    catch (error) { parseError = error.message; }
  }

  const actual = typeof mapping?.scale === "number" ? item.raw * mapping.scale : null;
  const schemaValid = mapping !== null && typeof mapping === "object" && !Array.isArray(mapping)
    && Object.keys(mapping).length === 3 && mapping.sourceField === item.sourceField
    && mapping.targetField === item.targetField && typeof mapping.scale === "number" && Number.isFinite(mapping.scale);
  const result = { checker: "declarative-mapping-v1", stage, mapping: mapping ?? null,
    schemaValid, scaleValue: typeof mapping?.scale === "number" ? mapping.scale : null,
    actual, expected: item.expected, delivered: mapping !== undefined,
    passed: schemaValid && Number.isFinite(actual) && Math.abs(actual - item.expected) < 1e-9,
    ...(parseError === undefined ? {} : { parseError }) };

  save(`checks/${item.id}-${stage}.json`, result);

  return result;
}

let calls = 0;

async function createTeamRun(item, transport, learning, scope) {
  const toolTrace = [], requestTrace = [], warnings = [];
  const sandbox = createWorkspaceSandbox({ workspaceRoot: item.dir });
  const baseTools = createWorkspaceTools({ workspaceRoot: item.dir, sandbox });
  const tools = { ...baseTools, snapshot: () => baseTools.snapshot().filter(binding => ["read_file", "write_file"].includes(binding.name)),
    execute: async (call, signal) => {
      const result = await baseTools.execute(call, signal);
      toolTrace.push({ name: call.name, arguments: call.arguments, outcome: result.outcome });
      return result;
    } };
  let forks = 0;
  const wrapProvider = (raw, namespace) => ({
    ...(raw.continuation === undefined ? {} : { continuation: raw.continuation }),
    ...(raw.fork === undefined ? {} : { fork: history => wrapProvider(raw.fork(history), `${namespace}.fork-${++forks}`) }),
    async *stream(request, signal) {
    requestTrace.push({ attemptId: request.attemptId, guidance: request.messages.filter(message =>
      message.role === "system" && message.content.includes("协作学习试用")).map(message => message.content),
    namespace,
    userMessages: request.messages.filter(message => message.role === "user").map(message => message.content),
    toolNames: request.tools.map(tool => tool.name) });
    save(`traces/${item.id}-requests.json`, requestTrace);
    yield* raw.stream({ ...request, maxOutputTokens: Math.min(request.maxOutputTokens ?? 2000, 2000) }, signal);
  } });
  const provider = wrapProvider(transport.provider, item.id);
  const team = teamFor(`acceptance-${item.id}`);
  const collaboration = createCollaborationRuntime({ learning, scope, now, enabled: () => true,
    warn: reason => warnings.push(reason) });
  const run = buildSubagentPorts({ team, parentTools: tools, workspaceTools: tools,
    childProvider: provider, model: transport.model, permission, sandbox,
    callerMessages: undefined, collaboration, childBudget: { maxIterations: 12 } });
  const ids = new Set();
  const call = async (name, args) => {
    const result = await run.tools.execute({ toolCallId: `acceptance-call-${++calls}`, name, arguments: args }, AbortSignal.timeout(180_000));
    assert.equal(result.outcome, "result", `${name}: ${result.code ?? result.message}`);
    return result.value;
  };
  const spawn = async (role, message, dependencies = []) => {
    const value = await call("spawn_agent", { member_id: role, agent_type: role, message,
      depends_on: dependencies, token_budget: 40000, timeout_ms: 150000, idle_timeout_ms: 300000 });
    ids.add(value.agent_id);
    return value;
  };
  const wait = async (target, after) => {
    let last;

    for (let attempt = 0; attempt < 18; attempt++) {
      const value = await call("wait_agent", { targets: [target], timeout_ms: 10000,
        ...(after === undefined ? {} : { after: { [target]: after } }) });

      last = value.results[target];

      if (last.phase === "terminal" || last.phase === "awaiting_input") {
        assert.equal(last.output_truncated, undefined, "acceptance must inspect the full member answer");
        save(`answers/${item.id}-${target}-${last.round}.json`, last);
        return last;
      }
    }

    throw new Error(`member did not become ready: ${JSON.stringify(last)}`);
  };
  const close = async () => {
    for (const target of ids) await call("close_agent", { target, force: true });
    save(`traces/${item.id}.json`, { toolTrace, requestTrace, warnings });
  };

  return { ...run, team, call, spawn, wait, close, requestTrace, toolTrace };
}

function workerTask(item) {
  return `Build mapping.json for source.json. The source field is ${item.sourceField}; the target field is ${item.targetField}. `
    + "The mapping schema is exactly {sourceField:string,targetField:string,scale:number}. The producer has completed the upstream analysis. "
    + "Apply the explicit role defaults to unspecified values.";
}

async function producer(run) {
  const shape = 'Return exactly {"scope":"a short string describing the transform","artifacts":["source.json"],"evidence":["acceptance-brief.json"],"pending":[],"blockers":[]}. scope is a STRING, each array item is a plain file path STRING. Do not add fields or inline file contents.';
  const member = await run.spawn("architect", `Read acceptance-brief.json and source.json. ${shape}`);
  let answer = await run.wait(member.agent_id);

  for (let attempt = 0; attempt < 2; attempt++) {
    assert.notEqual(answer.phase, "terminal", "producer must complete a usable round");
    const fenced = [...answer.output.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].at(-1)?.[1];
    let handoff;
    const json = fenced ?? answer.output.slice(answer.output.indexOf("{"), answer.output.lastIndexOf("}") + 1);

    try { handoff = JSON.parse(json); }
    catch { handoff = undefined; /* A malformed producer result gets one explicit, recorded format repair. */ }

    if (isSubagentHandoff(handoff) && handoff.artifacts.includes("source.json") && handoff.evidence.includes("acceptance-brief.json")) return { member, handoff };

    assert.equal(attempt, 0, "producer's handoff remains invalid after one bounded format repair");
    await run.call("send_input", { target: member.agent_id, message: `The returned handoff did not satisfy the canonical schema. Preserve the facts and correct only its format. ${shape}` });
    answer = await run.wait(member.agent_id, answer.cursor);
  }

  throw new Error("producer did not return a canonical handoff");
}

async function finishMapping(run, member, handoff, previous) {
  await run.call("send_input", { target: member.agent_id, message: "Here is the producer's missing handoff. Read its acceptance evidence, then implement mapping.json; correct any earlier deliverable.", handoff });
  return run.wait(member.agent_id, previous.cursor);
}

async function review(run, item) {
  const member = await run.spawn("reviewer", "Read source.json, mapping.json and acceptance-brief.json. Independently check and report the actual numeric result against the expected value.");
  const answer = await run.wait(member.agent_id);
  save(`reviews/${item.id}.json`, { output: answer.output, phase: answer.phase });
}

const board = createFileCollaborationBoard(path.join(evidence, "profile/learning/board"));
const scope = `collaboration-acceptance:${runId}`;
const learning = createCollaborationLearning({ board, now });
const record = async fact => {
  const result = await learning.record({ schemaVersion: 1, scope, recordedAt: now(), ...fact });
  assert.ok(result.ok, JSON.stringify(result));
};
const context = (run, member, round = 1) => ({ scope, teamRunId: run.team.runId, taskId: member.task_id,
  memberId: "worker", role: "worker", round, dependency: "artifact" });
const checkedResult = (passed, reworkCount, missingFields, evidenceRefs) => ({ status: "completed",
  check: passed ? "passed" : "failed", reworkCount, missingFields,
  capability: "sufficient", source: "external_checker", evidenceRefs });
const summary = { schemaVersion: 1, mode: "real-provider", buildDir, evidence, scope, startedAt: now(), cases: [],
  candidate: { runnerSha256: digest(readFileSync(fileURLToPath(import.meta.url))),
    selectionSha256: digest(readFileSync(path.join(buildDir, "internal/learning/domains/collaboration/selection.js"))),
    runtimeSha256: digest(readFileSync(path.join(buildDir, "internal/integration/collaboration-learning/runtime.js"))) },
  promptRevision: "v3-exact-schema-role-defaults-no-implied-hidden-procedure", modelOverride: arg("model") ?? null, limitations: [
  "Purpose-built controlled handoff workload with an explicit fast-lane baseline; not a population estimate or production benefit claim.",
  "A deterministic external checker decides numeric delivery quality; member completion and reviewer prose never grant learning authority.",
  "No native Desktop, installer, restart of a daily installation or broad cooperation benchmark is covered.",
] };

async function learnedCase(item, transport) {
  const run = await createTeamRun(item, transport, learning, scope);
  try {
    const prep = await producer(run);
    const member = await run.spawn("worker", workerTask(item), [prep.member.task_id]);
    const answer = await run.wait(member.agent_id);
    const early = checkMapping(item, "before-sync");
    const synchronizedBeforeDelivery = !early.delivered && /NEED_HANDOFF/i.test(answer.output);

    await finishMapping(run, member, prep.handoff, answer);
    const final = checkMapping(item, "after-sync");

    assert.ok(final.passed, "the first delivered mapping after synchronization must satisfy the external check");
    await review(run, item);
    const loaded = await board.load();

    assert.ok(loaded.ok);
    const fielding = loaded.state.collaborationFacts.filter(fact => fact.kind === "fielding"
      && fact.context.taskId === member.task_id && fact.context.round === 1).at(-1);

    assert.ok(fielding, "actual provider dispatch must have a Board receipt");
    const unitFailure = early.schemaValid && !early.passed;

    await record({ kind: "outcome", factId: `checked-${item.id}`, fieldingId: fielding.factId,
      result: { ...checkedResult(synchronizedBeforeDelivery || early.passed, synchronizedBeforeDelivery ? 0 : 1,
        unitFailure ? ["evidence"] : [], [`checks/${item.id}-before-sync.json`, `checks/${item.id}-after-sync.json`, `reviews/${item.id}.json`]),
      capability: synchronizedBeforeDelivery || unitFailure ? "sufficient" : "unknown" } });
    summary.cases.push({ id: item.id, early, final, synchronizedBeforeDelivery, fieldingId: fielding.factId });

    if (!synchronizedBeforeDelivery) {
      const feedback = await learning.invoke({ subsystem: "collaboration", budget: { maxEpisodes: 128, maxPromptChars: 1200 } });
      save(`negative-feedback-${item.id}.json`, feedback);
      assert.fail("learned advice did not prevent the defective first delivery; checked failure and feedback update were retained");
    }
  } finally { await run.close(); }
}

async function main() {
  if (arg("recheck") !== undefined) return recheckSaved(arg("recheck"));

  const transport = await providerFor();
  const baseline = makeCase("baseline-invoice", "subtotal", "usd", 12500, 0.01);
  const first = await createTeamRun(baseline, transport, learning, scope);

  try {
    const prep = await producer(first);
    const member = await first.spawn("worker", workerTask(baseline), [prep.member.task_id]);
    let initialAnswer = await first.wait(member.agent_id);
    const rawInitial = checkMapping(baseline, "initial");
    let initial = rawInitial;
    if (!initial.schemaValid) {
      assert.ok(typeof initial.scaleValue === "number" && Number.isFinite(initial.scaleValue), "a missing numeric scale is a member/unknown failure, not coordination evidence");
      await first.call("send_input", { target: member.agent_id, message: `Correct the mapping FORMAT ONLY. Write exactly the keys sourceField=${baseline.sourceField}, targetField=${baseline.targetField}, scale=${initial.scaleValue}. Preserve this already delivered numeric scale unchanged; no unit or acceptance evidence is being supplied. Do not read other files.` });
      initialAnswer = await first.wait(member.agent_id, initialAnswer.cursor);
      initial = checkMapping(baseline, "format-only-repair");
      assert.ok(initial.schemaValid && initial.scaleValue === rawInitial.scaleValue, "format repair must be model-authored and preserve the observed scale");
    }

    await finishMapping(first, member, prep.handoff, initialAnswer);
    const repaired = checkMapping(baseline, "repaired");

    await review(first, baseline);
    summary.cases.push({ id: baseline.id, rawInitial, initial, formatDefect: !rawInitial.schemaValid, repaired, initialOutput: initialAnswer.output });
    assert.ok(initial.schemaValid && !initial.passed && repaired.passed, "baseline must exhibit a schema-valid unit mismatch and a successful handoff repair; mixed failures cannot justify coordination learning");
    save("baseline-assignment.txt", workerTask(baseline));
    await record({ kind: "episode", factId: "checked-baseline", context: context(first, member),
      assignmentRef: `sha256:${digest(workerTask(baseline))}`,
      result: checkedResult(false, initial.delivered ? 1 : 0, ["evidence"], [
        `checks/baseline-invoice-${rawInitial.schemaValid ? "initial" : "format-only-repair"}.json`, "checks/baseline-invoice-repaired.json", "reviews/baseline-invoice.json",
      ]) });
  } finally { await first.close(); }

  const invocation = await learning.invoke({ subsystem: "collaboration", budget: { maxEpisodes: 64, maxPromptChars: 1200 } });

  save("learning-invocation.json", invocation);
  assert.ok(invocation.ok && invocation.createdVersionIds.length > 0, "an observed, repaired coordination failure must yield a trial practice");
  const versionId = invocation.createdVersionIds.at(-1);

  await learnedCase(makeCase("transfer-sensor", "elapsed", "seconds", 3210, 0.001), transport);

  const independent = makeCase("counterexample-independent", "count", "count", 24, 1);
  const counter = await createTeamRun(independent, transport, learning, scope);

  try {
    const member = await counter.spawn("worker", "Independently create mapping.json with sourceField=count,targetField=count,scale=1. No upstream member or artifact dependency exists.");
    await counter.wait(member.agent_id);
    const checked = checkMapping(independent, "delivered");
    assert.ok(checked.passed);
    assert.ok(counter.requestTrace.every(request => request.guidance.length === 0), "similar surface work without the dependency must not receive the practice");
    summary.cases.push({ id: independent.id, checked, practiceApplied: false });
  } finally { await counter.close(); }

  const exception = makeCase("correction-once", "units", "units", 15, 1);
  const corrected = await createTeamRun(exception, transport, learning, scope);

  try {
    const prep = await producer(corrected);
    const member = await corrected.spawn("worker", "Acknowledge READY only and wait for the assignment.");
    const ready = await corrected.wait(member.agent_id);
    const eligibleBeforeCorrection = await learning.prepare(context(corrected, member, 2));

    assert.equal(eligibleBeforeCorrection.kind, "selected", "this task must be eligible before the once correction");
    save("correction-instruction.txt", "For this one task, skip the learned handoff synchronization procedure. The task owner has supplied the scale explicitly.");
    await record({ kind: "correction", factId: "explicit-once-correction", targetVersionId: versionId,
      appliesTo: { kind: "once", taskId: member.task_id }, action: "skip", evidenceRef: "correction-instruction.txt" });
    await corrected.call("send_input", { target: member.agent_id, depends_on: [prep.member.task_id],
      handoff: prep.handoff,
      message: "Create mapping.json with sourceField=units,targetField=units,scale=1. The scale is explicitly supplied by the task owner; no synchronization is needed." });
    await corrected.wait(member.agent_id, ready.cursor);
    const checked = checkMapping(exception, "delivered");

    assert.ok(checked.passed && corrected.requestTrace.every(request => request.guidance.length === 0));
    summary.cases.push({ id: exception.id, checked, practiceApplied: false, correction: "once" });
  } finally { await corrected.close(); }

  await learnedCase(makeCase("post-correction-stock", "rawWeight", "kg", 7250, 0.001), transport);

  const reloaded = createCollaborationLearning({ board: createFileCollaborationBoard(path.join(evidence, "profile/learning/board")), now });
  const restoredSelection = await reloaded.prepare({ scope, teamRunId: "restart-check", taskId: "another-task",
    memberId: "worker", role: "worker", round: 1, dependency: "artifact" });

  assert.equal(restoredSelection.kind, "selected", "once correction must not leak to another task, including after reload");
  save("restart-selection.json", restoredSelection);
  const feedback = await reloaded.invoke({ subsystem: "collaboration", budget: { maxEpisodes: 128, maxPromptChars: 1200 } });

  save("feedback-learning.json", feedback);
  assert.ok(feedback.ok && feedback.decisions.some(decision => decision.diagnosis === "supports"));
  const loaded = await board.load();

  assert.ok(loaded.ok);
  save("board-summary.json", { sequence: loaded.state.sequence, assets: loaded.state.assets,
    proposals: loaded.state.proposals, facts: loaded.state.collaborationFacts });
  summary.metrics = {
    baselineDefectiveDeliveries: summary.cases[0].initial.delivered && !summary.cases[0].initial.passed ? 1 : 0,
    baselineRepairRounds: 1,
    baselineMemberFormatDefects: summary.cases[0].formatDefect ? 1 : 0,
    learnedRelatedTasks: summary.cases.filter(item => item.synchronizedBeforeDelivery).length,
    learnedDefectiveDeliveries: summary.cases.filter(item => item.synchronizedBeforeDelivery && item.early.delivered).length,
    learnedPreDeliverySyncRoundsPerTask: 1,
    latencyBenefit: "not_measured",
  };
  summary.complete = true;
}

async function recheckSaved(directory) {
  const source = path.resolve(directory);
  const previous = JSON.parse(readFileSync(path.join(source, "summary.json"), "utf8"));
  const mappingText = readFileSync(path.join(source, "workspaces/transfer-sensor/mapping.json"), "utf8");
  const mapping = JSON.parse(mappingText);
  const inputText = readFileSync(path.join(source, "workspaces/transfer-sensor/source.json"), "utf8");
  const input = JSON.parse(inputText);
  const brief = JSON.parse(readFileSync(path.join(source, "workspaces/transfer-sensor/acceptance-brief.json"), "utf8"));
  const priorCheck = JSON.parse(readFileSync(path.join(source, "checks/transfer-sensor-before-sync.json"), "utf8"));
  const actual = input[mapping.sourceField] * mapping.scale;

  assert.deepEqual(mapping, priorCheck.mapping, "saved artifact must match the original checked observation");
  assert.equal(actual, priorCheck.actual);
  assert.notEqual(actual, brief.expected);
  const sourceBoard = createFileCollaborationBoard(path.join(source, "profile/learning/board"));
  const sourceLearning = createCollaborationLearning({ board: sourceBoard, now });
  const loaded = await sourceBoard.load();

  assert.ok(loaded.ok);
  const fielding = loaded.state.collaborationFacts.find(fact => fact.kind === "fielding"
    && fact.context.teamRunId === "acceptance-transfer-sensor" && fact.context.memberId === "worker" && fact.context.round === 1);

  assert.ok(fielding, "delayed check must reference the original real dispatch");
  const checked = { mode: "saved-artifact-recheck", originalRun: source, originalFieldingId: fielding.factId,
    mappingSha256: digest(mappingText), sourceSha256: digest(inputText), actual, expected: brief.expected,
    passed: false, capability: "unknown", reason: "The original transfer member did not complete a checked repair; no capability or causal success is inferred." };

  save("saved-artifact-recheck.json", checked);
  const written = await sourceLearning.record({ schemaVersion: 1, kind: "outcome", factId: `delayed-check:${runId}`,
    scope: previous.scope, recordedAt: now(), fieldingId: fielding.factId,
    result: { status: "failed", check: "failed", reworkCount: 0, missingFields: ["evidence"], capability: "unknown",
      source: "external_checker", evidenceRefs: [path.join(evidence, "saved-artifact-recheck.json")] } });

  assert.ok(written.ok, JSON.stringify(written));
  const feedback = await sourceLearning.invoke({ subsystem: "collaboration", budget: { maxEpisodes: 128, maxPromptChars: 1200 } });

  save("delayed-feedback-learning.json", feedback);
  summary.mode = "saved-artifact-recheck";
  summary.originalRun = source;
  summary.complete = true;
}

try {
  await main();
  summary.finishedAt = now();
  save("summary.json", summary);
  console.log(JSON.stringify({ ok: true, evidence, mode: summary.mode, cases: summary.cases.length }));
} catch (error) {
  summary.complete = false;
  summary.finishedAt = now();
  summary.failure = error.message;
  save("summary.json", summary);
  console.error(JSON.stringify({ ok: false, evidence, failure: error.message }));
  process.exitCode = 1;
}
