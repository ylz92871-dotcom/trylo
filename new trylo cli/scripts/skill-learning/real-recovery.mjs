import { relocatedRecordPath } from "../../../scripts/workspace-record-locations.mjs";
import { artifactPath, taskPath } from "../../../scripts/workspace-paths.mjs";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { loadRealModule, resolveRealConnection } from "./real-connection.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), repo = path.resolve(root, "..");
const fixture = taskPath("legacy-work", "skill-daily-20261103/evidence/fixtures");
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const digest = text => createHash("sha256").update(text).digest("hex");
const save = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
};
const failure = code => Object.assign(new Error(code), { safeCode: code });
let secret, scrub = value => String(value);
const safe = value => scrub(String(value).replaceAll(secret || "__NO_SECRET__", "[secret]"));

async function main() {
  if (!process.argv.includes("--execute")) {
    process.stdout.write(JSON.stringify({ status: "prepared", networkRequests: 0, executionRequires: "--execute --sequence-dir=<passed-eight-stage-evidence>",
      mechanism: "A real ordinary task receives only 1 learning call / 1 output token; settled canonical task journals remain pending. A new process explicitly grants 16 calls / 18000 output tokens and recovers each source into exactly one fact.",
      noCrashClaim: true, noSeededFactsOrReceipts: true }) + "\n");
    return;
  }

  if (!option("sequence-dir")) throw failure("passed_sequence_directory_required");

  const previousDir = relocatedRecordPath(option("sequence-dir")), previous = JSON.parse(readFileSync(path.join(previousDir, "sequence-report.json"), "utf8"));
  const names = ["train-1", "train-2", "transfer-3", "counterexample-4", "correction-5", "after-correction-6", "restart-7", "withdraw-8"];
  if (previous.status !== "passed" || names.some(name => !previous.stages.some(stage => stage.name === name && stage.accepted))) throw failure("eight_actual_stages_must_pass_first");

  const { model } = previous;
  const build = relocatedRecordPath(previous.build), profile = relocatedRecordPath(previous.profile), workspace = relocatedRecordPath(previous.workspace);

  for (const owned of [profile, workspace]) if (path.relative(previousDir, path.resolve(owned)).startsWith("..")) throw failure("recovery_workspace_not_owned");

  const out = artifactPath("skill-learning-real", "recovery", path.basename(previousDir));
  if (existsSync(path.join(out, "recovery-report.json"))) throw failure("recovery_evidence_exists_no_rerun");

  const resolved = await resolveRealConnection({ build, workspaceRoot: repo, modelOverride: model });
  secret = resolved.apiKey;
  scrub = (await loadRealModule(build, "compaction/disclosure")).scrubDisclosure;
  const [{ createBoardReader }, { createSkillExperienceFile }, { createSkillTaskQueue }, { skillDailyManagementPaths }, { createNdjsonSessionStore }, { sessionPath }] = await Promise.all([
    loadRealModule(build, "adapters/learning-store/file-event-store"), loadRealModule(build, "integration/skill-learning/experience-file"),
    loadRealModule(build, "integration/skill-learning/task-queue"), loadRealModule(build, "surface/cli/skill-daily-management"),
    loadRealModule(build, "adapters/session-store/ndjson"), loadRealModule(build, "surface/cli/session-paths"),
  ]);

  process.env.TRYLO_REAL_SEQUENCE_LIBRARY_ONLY = "1";
  const { auditLearningCosts } = await import("./real-sequence.mjs");
  delete process.env.TRYLO_REAL_SEQUENCE_LIBRARY_ONLY;
  const paths = skillDailyManagementPaths({ cwd: workspace, homeDir: homedir(), env: { TRYLO_HOME: profile } });
  const report = { status: "running", build, model, previousSequence: previousDir, stages: [], noCrashClaim: true,
    mechanism: "budget-deferred canonical journal intake recovered by a new process and new explicit grant", seededFactsOrReceipts: false };
  let requests = previous.httpRequests;
  const flush = () => save(path.join(out, "recovery-report.json"), JSON.parse(safe(JSON.stringify(report))));
  const snapshot = async label => {
    const board = await createBoardReader(paths.boardRoot).load();
    if (!board.ok) throw failure("recovery_board_unavailable");

    const facts = createSkillExperienceFile({ root: paths.factsRoot, workspaceId: paths.workspaceId, collection: () => "enabled", retention: "segmented" }).read(label);
    if (!facts.ok) throw failure("recovery_facts_unavailable");

    const pending = createSkillTaskQueue({ root: paths.factsRoot, workspaceId: paths.workspaceId, collection: () => "enabled" })
      .pending({ limit: 128, retryRevision: "acceptance-inspection-only", includeRecovery: true });
    if (!pending.ok) throw failure("recovery_queue_unavailable");

    const result = { state: board.state, facts: facts.opportunity.experiences, pending };

    save(path.join(out, label + ".sanitized.json"), safe(JSON.stringify(result, null, 2)));
    return result;
  };
  const cli = async (label, args) => {
    if (requests >= 256) throw failure("global_sequence_request_ceiling");

    report.currentStage = label;
    flush();
    process.stdout.write(JSON.stringify({ status: "stage_started", stage: label, httpRequests: requests }) + "\n");
    const result = await child(path.join(build, "cmd/trylo/main.js"), args, workspace, { ...process.env, TRYLO_HOME: profile, TRYLO_OPENAI_API_KEY: secret,
      TRYLO_REAL_SEQUENCE_OBSERVER: "1", TRYLO_REAL_SEQUENCE_ORIGIN: resolved.endpoint.origin, TRYLO_REAL_SEQUENCE_BUILD: build,
      TRYLO_REAL_SEQUENCE_BOARD_ROOT: paths.boardRoot, TRYLO_REAL_SEQUENCE_WORKSPACE_ID: paths.workspaceId, TRYLO_REAL_SEQUENCE_MAX_REQUESTS: String(Math.min(40, 256 - requests)) });
    const telemetryLine = result.stderr.split(/\r?\n/).find(line => line.startsWith("TRYLO_REAL_SEQUENCE_TELEMETRY "));
    let telemetry;
    try { telemetry = telemetryLine ? JSON.parse(telemetryLine.slice(30)) : undefined; } catch { /* Missing telemetry is an explicit failure below. */ }

    const frames = result.stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const redacted = result.stdout.split(/\r?\n/).map(line => {
      try {
      const value = JSON.parse(line);
      if (String(value.type).startsWith("reasoning")) return JSON.stringify({ type: value.type, text: "[omitted]" });
    } catch { /* Plain diagnostic is scrubbed below. */ }
      return safe(line);
    }).join("\n");

    save(path.join(out, label, "stdout.ndjson"), redacted);
    save(path.join(out, label, "stderr.txt"), safe(result.stderr));

    if (telemetry) requests += telemetry.fetchCalls;

    const stage = { label, pid: result.pid, exitCode: result.code, telemetry: telemetry ?? null, runResult: frames.findLast(frame => frame.type === "run_result") ?? null };

    report.stages.push(stage);
    flush();

    if (!telemetry || result.code !== 0 || telemetry.refused || telemetry.requests.some(request => request.status !== 200 || request.usageStatus !== "reported" || request.model !== model)) throw failure("recovery_cli_or_cost_failed:" + label);

    return { stage, frames };
  };

  try {
    flush();
    await snapshot("before");
    const item = JSON.parse(readFileSync(path.join(fixture, "cases.json"), "utf8"))[0];

    item.brief.requirePlan = true;
    item.brief.order = "desc";
    save(path.join(workspace, "source.json"), item.source);
    save(path.join(workspace, "brief.json"), item.brief);
    save(path.join(workspace, "output.json"), { groups: [] });

    if (existsSync(path.join(workspace, "audit-plan.json"))) unlinkSync(path.join(workspace, "audit-plan.json"));

    const config = JSON.parse(readFileSync(path.join(fixture, "skill-learning.json"), "utf8"));
    config.allowance = { maxCalls: 1, maxTokens: 1 };
    save(path.join(workspace, ".trylo/skill-learning.json"), config);
    const frozen = Object.fromEntries(["source.json", "brief.json", "reporting-rules.json", "check-report.mjs", ".trylo/skill-learning.json"].map(name => [name, digest(readFileSync(path.join(workspace, name)))]));
    const sessionId = "skill-real-recovery-" + digest(previousDir).slice(0, 8);
    const deferred = await cli("deferred-ordinary-task", ["run", "--workspace", workspace, "--session", sessionId, "--learning", "skill", "--allow-writes", "--allow-tools", "run_shell,skill", "--model", model,
      "--shell-isolation", "host", "--max-iterations", "10", "--max-tokens", "1800", "--format", "stream-json", "--system-prompt", "Execute this real isolated file task. Preserve every initial input and checker byte. Your first tool call must run_shell exactly node check-report.mjs before any mutation. Observe the actual assertion failure, then read brief.json, generate the report and required plan with actual tools, and run the exact foreground command node check-report.mjs after all mutations. Stop on any shell readiness/permission failure; do not substitute a claimed pass. Do not edit learning/profile/evidence files.",
      "Complete a new raw-row grouped report from source.json according to brief.json and reporting-rules.json. Repair report.mjs if needed and generate accurate output.json; the current output is wrong. Follow the brief's plan requirement. Finish after the independent checker passes."]);

    for (const [name, hash] of Object.entries(frozen)) if (!existsSync(path.join(workspace, name)) || digest(readFileSync(path.join(workspace, name))) !== hash) throw failure("recovery_frozen_input_changed");

    const checked = spawnSync(process.execPath, ["check-report.mjs"], { cwd: workspace, windowsHide: true, encoding: "utf8", timeout: 10_000 });

    save(path.join(out, "independent-task-check.json"), { exitCode: checked.status, stdout: safe(checked.stdout ?? ""), stderr: safe(checked.stderr ?? "") });

    if (checked.status !== 0) throw failure("recovery_independent_task_check_failed");

    if (deferred.stage.runResult?.exitCode && deferred.stage.runResult.exitCode !== 0) throw failure("recovery_ordinary_task_failed");

    const waiting = await snapshot("deferred"), target = waiting.pending.entries.filter(entry => entry.task.sessionId === sessionId);
    if (!target.some(entry => entry.task.qualification.outcome === "success") || waiting.facts.some(fact => fact.runId.startsWith(sessionId + ":"))) throw failure("real_source_was_not_budget_deferred");

    const tiny = waiting.state.learningGrantFacts.filter(fact => fact.kind === "open" && fact.sourceRef.startsWith("execution:" + sessionId + ":"));
    if (tiny.length !== 1 || tiny[0].allowance.maxCalls !== 1 || tiny[0].allowance.maxOutputTokens !== 1
      || !waiting.state.learningGrantFacts.some(fact => fact.kind === "reserve" && fact.grantId === tiny[0].grantId)) throw failure("tiny_real_grant_was_not_consumed");

    const journalFile = sessionPath(homedir(), { TRYLO_HOME: profile }, sessionId), journal = await createNdjsonSessionStore({ path: journalFile }).readRecords();
    if (!journal.ok || journal.view.tornTail || !journal.view.records.some(record => record.type === "terminal")) throw failure("deferred_source_journal_not_settled");

    save(path.join(out, "source-evidence.json"), { sessionId, target, childPid: deferred.stage.pid, journalSha256: digest(readFileSync(journalFile)), journalBytes: statSync(journalFile).size,
      terminalRecords: journal.view.records.filter(record => record.type === "terminal").length, expectedFactsPerQualification: 1 });
    config.allowance = { maxCalls: 16, maxTokens: 18000 };
    save(path.join(workspace, ".trylo/skill-learning.json"), config);
    const restored = await cli("new-process-explicit-learn", ["skills", "learn", "--max-calls", "16", "--max-tokens", "18000", "--allow-writes", "--allow-exec", "--allow-skill-trial", "--shell-isolation", "host", "--json"]);
    if (restored.stage.pid === deferred.stage.pid) throw failure("recovery_not_a_new_process");

    const after = await snapshot("after");

    for (const entry of target) {
      const matches = after.facts.filter(fact => fact.runId === `${entry.task.sessionId}:${entry.task.turnId}` && fact.qualification.ref === entry.task.qualification.ref
        && fact.qualification.kind === entry.task.qualification.kind);
      if (matches.length !== 1 || after.pending.entries.some(item => item.key === entry.key)) throw failure("recovered_source_missing_or_duplicated");
    }

    const allRequests = [...previous.stages, ...report.stages].flatMap(stage => stage.telemetry?.requests ?? []);
    const cost = auditLearningCosts(after.state, allRequests, paths.workspaceId, 10);
    if (cost.errors.length) throw failure("recovery_grant_cost_mismatch:" + cost.errors.join(","));

    Object.assign(report, { status: "passed", httpRequestsIncludingSequence: requests, cost, recoveredSourceCount: target.length,
      preservedSourceFactIds: after.facts.filter(fact => fact.runId.startsWith(sessionId + ":")).map(fact => fact.episode.id) });
    flush();
    process.stdout.write(JSON.stringify({ status: "passed", evidence: out, recoveredSourceCount: target.length, httpRequestsIncludingSequence: requests }) + "\n");
  } catch (error) {
    Object.assign(report, { status: "failed", reason: error?.safeCode ?? "recovery_unavailable", httpRequestsIncludingSequence: requests });
    flush();
    process.exitCode = 1;
    process.stdout.write(JSON.stringify({ status: report.status, reason: report.reason, evidence: out }) + "\n");
  } finally { secret = undefined; }
}

function child(entry, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const processChild = spawn(process.execPath, ["--import", pathToFileURL(path.join(root, "scripts/skill-learning/real-sequence.mjs")).href, entry, ...args], { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => processChild.kill(), 600_000);
    const collect = (name, chunk) => {
      if (name === "stdout") stdout += chunk;else stderr += chunk;
      if (stdout.length + stderr.length > 16 * 1024 * 1024) processChild.kill();
    };

    processChild.stdout.on("data", chunk => collect("stdout", chunk));
    processChild.stderr.on("data", chunk => collect("stderr", chunk));
    processChild.once("error", () => {
      clearTimeout(timer);
      reject(failure("recovery_child_spawn_failed"));
    });
    processChild.once("close", code => {
      clearTimeout(timer);
      resolve({ code, pid: processChild.pid, stdout, stderr });
    });
  });
}

try { await main(); }
catch (error) {
  process.stdout.write(JSON.stringify({ status: "failed", reason: error?.safeCode ?? "recovery_unavailable", secretPersisted: false }) + "\n");
  process.exitCode = 1;
}
