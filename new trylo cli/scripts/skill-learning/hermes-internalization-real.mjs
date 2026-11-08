// One synthetic source -> funded implicit Hermes review -> isolated approval
// -> unrelated-data reuse check. Explicit execution/provider/build/output only.
// This is a mechanism observation, not a benchmark or an effectiveness claim.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createMechanismMeter, mechanismFailure as fail } from "./hermes-internalization-real-meter.mjs";

const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const sha = value => createHash("sha256").update(value).digest("hex");
const load = (build, relative) => import(pathToFileURL(path.join(build, `${relative}.js`)).href);
const SOURCE_ROWS = [
  { id: "a1", group: "cedar", delta: 5, state: "posted" }, { id: "b1", group: "maple", delta: 4, state: "posted" },
  { id: "b1", group: "maple", delta: 7, state: "posted" }, { id: "c1", group: "cedar", delta: 9, state: "void" },
  { id: "a2", group: "cedar", delta: -2, state: "posted" },
];
const REUSE_ROWS = [
  { id: "a1", group: "ash", delta: 8, state: "posted" }, { id: "a1", group: "ash", delta: 3, state: "posted" },
  { id: "m1", group: "maple", delta: -5, state: "posted" }, { id: "z1", group: "cedar", delta: 8, state: "void" },
  { id: "m2", group: "maple", delta: 2, state: "posted" },
];
const EXPECTED = {
  source: { groups: [{ group: "cedar", count: 2, total: 3 }, { group: "maple", count: 1, total: 7 }, { group: "ash", count: 0, total: 0 }] },
  reuse: { groups: [{ group: "ash", count: 1, total: 3 }, { group: "cedar", count: 0, total: 0 }, { group: "maple", count: 2, total: -3 }] },
};

function seedTask(directory, rows, groups) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "rows.ndjson"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  writeFileSync(path.join(directory, "task.json"), JSON.stringify({
    input: "rows.ndjson", output: "result.json", groupOrder: groups,
    rules: ["Deduplicate by id, keeping the last occurrence in input order before applying state filtering.",
      "Keep only records whose state is posted.", "Count surviving records and sum signed delta per group.",
      "Emit every group in groupOrder, preserving its exact order and using count 0 and total 0 for missing groups."],
    outputShape: { groups: [{ group: "group name", count: "integer record count", total: "signed integer sum" }] },
  }, null, 2) + "\n");
}

function checkResult(directory, expected) {
  let actual;

  try { actual = JSON.parse(readFileSync(path.join(directory, "result.json"), "utf8")); }
  catch { return { passed: false, reason: "result_missing_or_invalid_json", expected }; }

  const passed = actual !== null && typeof actual === "object" && !Array.isArray(actual) && Object.keys(actual).length === 1
    && Array.isArray(actual.groups) && actual.groups.length === expected.groups.length
    && expected.groups.every((row, i) => {
      const item = actual.groups[i];
      return item !== null && typeof item === "object" && Object.keys(item).length === 3
        && item.group === row.group && item.count === row.count && item.total === row.total;
    });

  return { passed, actual, expected, checker: "Fixed independently written expected objects; no model verdict." };
}

function taskInputHashes(directory) {
  return { task: sha(readFileSync(path.join(directory, "task.json"))), rows: sha(readFileSync(path.join(directory, "rows.ndjson"))) };
}

function isolatedEnvironment(base, out, python) {
  const env = {};

  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "PATH", "Path", "PATHEXT", "COMSPEC", "ComSpec"]) {
    if (base[key] !== undefined) env[key] = base[key];
  }

  const home = path.join(out, "home"), profile = path.join(out, "profile"), storage = path.join(out, "hermes-storage"), temp = path.join(out, "tmp");

  for (const directory of [home, profile, storage, temp, path.join(home, "appdata"), path.join(home, "localappdata")]) mkdirSync(directory, { recursive: true });

  return { ...env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, "appdata"), LOCALAPPDATA: path.join(home, "localappdata"),
    TEMP: temp, TMP: temp, TRYLO_HOME: profile, TRYLO_HERMES_STORAGE_ROOT: storage, HERMES_PYTHON: python,
    TRYLO_NODE_BINARY: process.execPath, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
}

async function main() {
  const providerId = option("provider"), buildArg = option("build-dir"), outArg = option("out");
  const sourceMode = process.argv.includes("--source");

  if (!process.argv.includes("--execute") || !["amd", "qianwen-ai-backup"].includes(providerId) || !buildArg || !outArg) {
    throw fail("requires_execute_explicit_provider_build_and_new_out");
  }

  const build = path.resolve(buildArg), out = path.resolve(outArg);
  if (!path.isAbsolute(buildArg) || !path.isAbsolute(outArg) || existsSync(out)) throw fail("absolute_build_and_unused_absolute_out_required");

  const entry = path.join(build, `cmd/trylo/main.${sourceMode ? "ts" : "js"}`);
  if (!existsSync(entry)) throw fail(sourceMode ? "explicit_source_candidate_missing" : "candidate_build_missing");

  // Only the explicit source route installs hooks. The caller supplies Node's
  // --experimental-transform-types flag; transpilation is not a typecheck.
  if (sourceMode) await import("./source-loader.mjs");

  mkdirSync(out, { recursive: true });
  const report = { status: "preparing", requestedProvider: providerId, startedAt: new Date().toISOString(),
    candidateMode: sourceMode ? "typescript-source" : "compiled", candidateEntrySha256: sha(readFileSync(entry)),
    typeValidation: { status: "not_performed_by_this_script", note: "Type diagnostics remain separate from this bounded behavior observation; source execution does not waive type gates." },
    scope: "One bounded synthetic mechanism observation. No success-rate or improvement claim.",
    learningMode: "Actual source task report -> explicit synthetic v2 central funding -> runFocused implicit background review.",
    ownershipLimit: "Implicit background_review origin is checked before isolated approval; native agent-create provenance follows the approved replay boundary. Subsequent corrective revision and durable improvement are not demonstrated by this one observation.",
    sourceLimit: "The opportunity override contains the actual provider source transcript. The separate fixture covers canonical journal recovery and terminal-prefix attribution.",
    limits: { sourceCalls: 4, learnCalls: 6, reuseCalls: 4, totalCalls: 14, outputTokensPerStage: 8192 },
    productionDefaultsModified: false, credentialsOrConfigurationExported: false, generated: false, approvedInIsolatedStore: false,
    approvalKind: "Explicit synthetic harness simulation of a human action, never a production approval.",
    discovery: { indexPresent: false, skillReadObserved: false }, checks: {}, stages: [],
  };
  let owned, runtime, meter, savedEnvironment, redact = value => value, selectedSecret;
  const save = () => writeFileSync(path.join(out, "report.json"), redact(JSON.stringify(report, null, 2)) + "\n");

  try {
    const [{ createProcessContext }, { resolveConnectionSettings }, { runCredentialFor }, { redactText }] = await Promise.all([
      load(build, "cmd/trylo/main"), load(build, "internal/surface/cli/connection-settings"),
      load(build, "internal/surface/cli/provider-selection"), load(build, "internal/credentials/redact"),
    ]);

    owned = createProcessContext();
    const lookup = { ...Object.fromEntries(["env", "homeDir", "cwd", "nodeVersion", "platform", "stdinIsTty", "readFile", "readDir", "isDirectory", "now", "newId"].map(key => [key, owned[key]])),
      stdout: () => {}, stderr: () => {} };
    // These are the normal owning APIs. Do not inspect, copy or serialize the ledger.
    const connection = resolveConnectionSettings(lookup, { message: [], readStdin: false, provider: providerId });
    if ("exitCode" in connection || connection.provider.providerId !== providerId || connection.provider.requestedBy !== "flag") throw fail("explicit_provider_configuration_unavailable");

    const selected = connection.provider;
    if (!["openai-compatible", "openai-responses"].includes(selected.kind)) throw fail("real_keyed_provider_required");

    const credential = runCredentialFor(lookup, selected.kind, selected.accountId);
    if ("exitCode" in credential || !credential.apiKey || credential.tokenManager !== undefined) throw fail("read_only_keyed_credential_unavailable");

    selectedSecret = credential.apiKey;
    redact = value => redactText(value, [selectedSecret]);
    const endpoint = new URL(selected.endpoint);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw fail("provider_endpoint_not_supported");

    const require = createRequire(import.meta.url);
    const python = require(path.join(build, "internal/learning/agent/subsystems/skill/vendor/legacy/hermes-python-resolver.js")).resolveHermesPython();
    const env = isolatedEnvironment(owned.env, out, python), sourceRoot = path.join(out, "workspace-source"), reuseRoot = path.join(out, "workspace-reuse");

    seedTask(sourceRoot, SOURCE_ROWS, ["cedar", "maple", "ash"]);
    seedTask(reuseRoot, REUSE_ROWS, ["ash", "cedar", "maple"]);
    const frozenInputs = { source: taskInputHashes(sourceRoot), reuse: taskInputHashes(reuseRoot) };

    savedEnvironment = { ...process.env };

    for (const key of Object.keys(process.env)) delete process.env[key];

    Object.assign(process.env, env);
    const [{ executeTurn, isTurnFailure }, { createHermesSkillRuntime }, { opportunityFromTranscript }, { workspaceIdentity },
      { createRunExecution }, { permissionFor }, { hermesProfileRegistry }, { hermesProfileClientFor }, { hermesSkillRead },
      { buildProvider }, { mergeUsage, emptyUsage }, { skillTaskReport }] = await Promise.all([
      load(build, "internal/surface/cli/host"), load(build, "internal/surface/cli/hermes-skill-runtime"),
      load(build, "internal/learning/agent/subsystems/skill/host/journal-opportunity"), load(build, "internal/surface/cli/wiring-catalog"),
      load(build, "internal/surface/cli/run-execution-wiring"), load(build, "internal/surface/cli/permission-for-run"),
      load(build, "internal/learning/agent/subsystems/skill/host/mcp-profile"), load(build, "internal/learning/agent/subsystems/skill/host/mcp-client-for"),
      load(build, "internal/learning/agent/subsystems/skill/skill-read"), load(build, "internal/surface/cli/provider-build"), load(build, "internal/ports/provider"),
      load(build, "internal/learning/agent/subsystems/skill/control/task-report"),
    ]);
    const warnings = [];
    const ctx = { env, homeDir: env.HOME, cwd: sourceRoot, nodeVersion: owned.nodeVersion, nodeExecutable: process.execPath, platform: owned.platform,
      stdinIsTty: false, now: owned.now, newId: owned.newId, readFile: owned.readFile, readDir: owned.readDir, isDirectory: owned.isDirectory,
      writeFile: owned.writeFile, readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined,
      stdout: () => {}, stderr: text => {
        const code = /^warning: ([a-z_]+)\s*$/.exec(text)?.[1];
        if (code) warnings.push(code);
      } };
    const facts = { providerId: selected.providerId, providerKind: selected.kind, model: selected.model, endpoint: selected.endpoint, apiKey: selectedSecret,
      ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }) };

    meter = createMechanismMeter({ origin: endpoint.origin, mergeUsage, emptyUsage });
    const signal = AbortSignal.timeout(180_000);
    const sink = { stdout: () => {}, stderr: () => {} };
    const runTask = async (stage, workspaceRoot, normal) => {
      meter.begin(stage);
      const tools = ["read_file", "write_file", ...(normal?.profile.allowedTools ?? [])];
      const execution = createRunExecution(workspaceRoot, { homeDir: ctx.homeDir, env, shellIsolation: "host", fileAccess: "workspace" });

      try {
        const result = await executeTurn({ ...facts, text: "Read task.json and rows.ndjson, apply the supplied JSON row-summary contract, and write result.json. "
          + "Use the supplied local tools; all inputs are synthetic. Do not run commands or install anything. Give a short final report of what you produced.",
          sessionId: ctx.newId(`real-${stage}-session`), turnId: ctx.newId(`real-${stage}-turn`), correlationId: ctx.newId("real-correlation"),
          workspaceRoot, workspaceId: workspaceIdentity(workspaceRoot), checkpointRoot: path.join(out, `checkpoints-${stage}`),
          permission: permissionFor("non_interactive", ctx, { allowTools: tools }, workspaceRoot), format: "stream-json", sink,
          now: ctx.now, cancelSignal: signal, execution, providerGuard: meter.guard, toolSelection: tools, maxIterations: 4, maxTokens: 8192,
          systemPrompt: { mode: "replace", text: "You are a local task assistant. Use only the mounted tools and follow the current task contract. "
            + "Do not access anything outside this synthetic workspace or claim checks you did not perform." },
          ...(normal === undefined ? {} : { systemPromptAppend: normal.prompt,
            mcp: { registry: hermesProfileRegistry(normal.profile), cwd: workspaceRoot,
              clientFor: hermesProfileClientFor(normal.profile, undefined, normal.observer) } }),
        });

        meter.assertHealthy();

        if (isTurnFailure(result) || result.result.status !== "completed") throw fail(`${stage}_execution_not_completed`);

        if (result.transcript.some(item => item.kind === "tool_result" && item.outcome !== "succeeded")) throw fail(`${stage}_tool_failed`);

        writeFileSync(path.join(out, `${stage}-transcript.json`), redact(JSON.stringify(result.transcript.filter(item => item.kind !== "assistant_reasoning"), null, 2)) + "\n");
        let currentInputs;

        try { currentInputs = taskInputHashes(workspaceRoot); }
        catch { throw fail(`${stage}_inputs_missing`); }

        const unchanged = Object.keys(frozenInputs[stage]).every(key => currentInputs[key] === frozenInputs[stage][key]);

        report.checks[`${stage}Inputs`] = { passed: unchanged, frozenHashes: frozenInputs[stage], actualHashes: currentInputs };

        if (!unchanged) throw fail(`${stage}_inputs_modified`);

        report.stages.push({ stage, execution: "completed", calls: meter.snapshot().stages.find(item => item.name === stage).calls });

        return result;
      } finally { await execution.close(); }
    };

    report.status = "running";
    save();
    const source = await runTask("source", sourceRoot);

    report.checks.source = checkResult(sourceRoot, EXPECTED.source);
    save();

    if (!report.checks.source.passed) throw fail("source_result_check_failed");

    const opportunity = { ...opportunityFromTranscript({ workspaceRoot: sourceRoot, sessionId: source.result.sessionId, turnId: source.result.turnId, transcript: source.transcript }),
      verification: ["An independent deterministic result check passed against a fixed expected JSON object."],
    };
    const scaffold = { ...facts, format: "stream-json", workspaceRoot: sourceRoot, workspaceId: workspaceIdentity(sourceRoot),
      checkpointRoot: path.join(out, "checkpoints-learn"), sessionId: "real-learning-scaffold", shellIsolation: "host" };
    const learningProvider = buildProvider({ ...facts, workspaceRoot: sourceRoot, providerGuard: meter.guard });
    if ("code" in learningProvider) throw fail("learning_provider_build_failed");

    runtime = createHermesSkillRuntime(ctx, scaffold, { provider: learningProvider, opportunity: async () => opportunity });
    meter.begin("learn");
    const taskReport = skillTaskReport({ sessionId: source.result.sessionId, turnId: source.result.turnId,
      transcript: source.transcript, userAttribution: "unverified" });
    if (!taskReport) throw fail("source_task_report_unavailable");

    const reported = await runtime.coordination.report(taskReport);
    if (!reported.ok) throw fail("source_task_report_failed");

    report.central = { sourceRef: taskReport.sourceRef, issueId: reported.issue.issueId, scope: sourceRoot };
    save();
    const allowance = { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 48_000,
      maxCalls: 6, maxSteps: 6, maxPromptChars: 40_000 };
    const focused = await runtime.coordination.focus({ issueId: reported.issue.issueId, expectedRevision: reported.issue.revision,
      reason: "Explicit isolated synthetic allocation for one implicit review of the observed task; no production grant is modified.",
      sourceRefs: [taskReport.sourceRef], allowance });
    if (!focused.ok) throw fail("source_task_focus_failed");

    Object.assign(report.central, { grantId: focused.grant.grantId, allowance });
    save();
    const learned = await runtime.runFocused(focused.issue.issueId, signal);

    report.central.result = learned;
    report.stages.push({ stage: "learn", status: learned.ok ? learned.status : "failed", result: learned,
      usage: meter.snapshot().stages.find(item => item.name === "learn").usage });
    save();
    meter.assertHealthy();

    if (!learned.ok || learned.status !== "completed" || learned.result?.kind !== "completed") throw fail("native_learning_failed");

    const refs = learned.result.resultRefs;
    if (!Array.isArray(refs) || refs.some(ref => typeof ref !== "string")) throw fail("native_learning_result_refs_missing");

    const prefix = "hermes-pending:skills:";
    const ids = [...new Set(refs.filter(ref => ref.startsWith(prefix)).map(ref => ref.slice(prefix.length)))];
    if (ids.some(id => !id)) throw fail("native_pending_identity_missing");

    report.central.pendingIds = ids;

    if (!ids.length) {
      report.status = "learning_produced_no_asset";
      return;
    }

    report.generated = true;

    for (const id of ids) {
      const detail = await runtime.compatibility("pendingDetail", { subsystem: "skills", id }, { signal });
      const expectedHash = detail?.detail?.payloadHash;
      if (detail?.ok !== true || typeof expectedHash !== "string" || !expectedHash) throw fail("pending_review_hash_unavailable");

      if (detail.detail.origin !== "background_review") throw fail("implicit_pending_origin_missing");

      const applied = await runtime.compatibility("pendingApply", { subsystem: "skills", id, expectedHash,
        reason: "Explicit isolated synthetic harness simulation of a human approval; no production asset is modified." }, { signal });

      report.stages.push({ stage: "isolated-simulated-approval", pendingId: id, reviewedPayloadHash: expectedHash,
        nativeOrigin: typeof detail.detail.origin === "string" ? detail.detail.origin : null, committed: applied?.ok === true });
      save();

      if (applied?.ok !== true) throw fail("isolated_approval_not_committed");
    }

    report.approvedInIsolatedStore = true;
    const normal = await runtime.normalContext(signal);
    if (!normal) throw fail("normal_context_unavailable");

    report.discovery.indexPresent = normal.prompt.includes("<available_skills>");
    report.discovery.indexHash = sha(normal.prompt);
    const reused = await runTask("reuse", reuseRoot, normal);
    const calls = new Map(reused.transcript.filter(item => item.kind === "tool_call").map(item => [item.toolCallId, item]));

    report.discovery.reads = reused.transcript.flatMap(item => {
      const call = item.kind === "tool_result" ? calls.get(item.toolCallId) : undefined;
      if (!call || item.outcome !== "succeeded" || item.truncated) return [];
      const read = hermesSkillRead(call, item.output);
      return read ? [{ ...read, toolCallId: item.toolCallId, sequence: item.sequence }] : [];
    });
    report.discovery.skillReadObserved = report.discovery.reads.length > 0;
    report.checks.reuse = checkResult(reuseRoot, EXPECTED.reuse);
    report.status = !report.checks.reuse.passed ? "reuse_result_check_failed"
      : report.discovery.skillReadObserved ? "mechanism_observed" : "generation_approved_but_reuse_not_observed";

    if (!report.checks.reuse.passed) process.exitCode = 1;

    report.readInterpretation = report.discovery.skillReadObserved
      ? "A native instruction read was observed. This does not establish causality or improvement."
      : "No native instruction read was observed; generation/approval/indexing alone do not establish reuse.";
    report.warnings = warnings;
  } catch (error) {
    report.status = "failed";
    report.failure = typeof error?.safeCode === "string" ? error.safeCode : "mechanism_check_failed";
    process.exitCode = 1;
  } finally {
    runtime?.close();

    if (meter) {
      report.metering = meter.snapshot();
      meter.close();
    }

    if (savedEnvironment) {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, savedEnvironment);
    }

    owned?.close();
    report.finishedAt = new Date().toISOString();
    save();
    process.stdout.write(`${JSON.stringify({ status: report.status, requestedProvider: providerId, evidence: path.join(out, "report.json"),
      calls: report.metering?.totalCalls ?? 0, generated: report.generated, approved: report.approvedInIsolatedStore,
      skillReadObserved: report.discovery.skillReadObserved, sourceCheck: report.checks.source?.passed ?? false,
      reuseCheck: report.checks.reuse?.passed ?? null })}\n`);
    selectedSecret = undefined;
  }
}

try { await main(); }
catch (error) {
  process.stderr.write(`${JSON.stringify({ status: "failed", code: typeof error?.safeCode === "string" ? error.safeCode : "mechanism_setup_failed" })}\n`);
  process.exitCode = 1;
}
