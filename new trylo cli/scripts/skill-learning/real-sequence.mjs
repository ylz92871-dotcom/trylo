import { artifactPath, taskPath } from "../../../scripts/workspace-paths.mjs";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, copyFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { loadRealModule, resolveRealConnection } from "./real-connection.mjs";

const script = fileURLToPath(import.meta.url), cliRoot = path.resolve(path.dirname(script), "../..");
const repoRoot = path.resolve(cliRoot, ".."), fixtureRoot = taskPath("legacy-work", "skill-daily-20261103/evidence/fixtures");
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const digest = value => createHash("sha256").update(value).digest("hex");
let runtimeSecret, scrub = text => String(text);
const safe = text => scrub(String(text).replaceAll(runtimeSecret || "__NO_SECRET_TO_REPLACE__", "[secret]"));
const save = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
};
const fail = code => Object.assign(new Error(code), { safeCode: code });

/** A child-only wire observer. It records usage, never prompts, headers or reasoning. */
function installObserver() {
  const original = globalThis.fetch, requests = [];
  const spentReservations = new Set();
  const expectedOrigin = process.env.TRYLO_REAL_SEQUENCE_ORIGIN;
  const limit = Number(process.env.TRYLO_REAL_SEQUENCE_MAX_REQUESTS ?? 40);
  let refused = 0, failed = false;

  runtimeSecret = process.env.TRYLO_OPENAI_API_KEY;
  globalThis.fetch = async (url, options = {}) => {
    if (requests.length >= limit || failed || new URL(url).origin !== expectedOrigin) {
      refused += 1;
      throw new Error("real_sequence_request_ceiling");
    }

    let body;

    try { body = typeof options.body === "string" ? JSON.parse(options.body) : undefined; }
    catch { /* Unknown body metadata is not logged or treated as a free request. */ }

    const firstSystem = body?.messages?.find(message => message.role === "system")?.content ?? "";
    const purpose = firstSystem.includes("skill experience normalizer") ? "extraction"
      : firstSystem.includes("previously learned task family") ? "selection"
        : firstSystem.includes("explicit correction in the CURRENT USER TEXT") ? "correction"
          : firstSystem.includes("isolated skill trial") ? "independent_trial" : "execution";
    const request = { index: requests.length + 1, purpose, model: typeof body?.model === "string" ? body.model : null,
      maxOutputTokens: body?.max_tokens ?? body?.max_completion_tokens ?? body?.max_output_tokens ?? null,
      toolCount: Array.isArray(body?.tools) ? body.tools.length : 0, sent: false, status: null, usageStatus: "missing", usage: null };

    requests.push(request);

    if (purpose !== "execution") {
      try {
        request.grantProof = await reservationBeforeSend(body, spentReservations);
      } catch (error) {
        failed = true;
        request.budgetError = error?.safeCode ?? "learning_budget_proof_unavailable";
        throw new Error(request.budgetError);
      }
    }

    let response;

    try {
      request.sent = true;
      response = await original(url, { ...options, redirect: "error" });
    }
    catch (error) {
      failed = true;
      request.transportCodes = [error?.code, error?.cause?.code].filter(code => typeof code === "string" && /^[A-Z][A-Z0-9_]{1,79}$/.test(code));
      throw error;
    }

    request.status = response.status;

    if (!response.ok) {
      failed = true;
      try {
        const parsed = await response.clone().json(), error = typeof parsed?.error === "object" ? parsed.error : parsed;
        request.error = { code: safe(error?.code ?? ""), type: safe(error?.type ?? ""), message: safe(error?.message ?? parsed?.error ?? "").slice(0, 2048) };
      } catch { /* Keep HTTP status only when there is no safe structured diagnostic. */ }
      return response;
    }

    if (!response.body) return response;

    let pending = "";
    const decoder = new TextDecoder();
    const capture = line => {
      if (!line.startsWith("data:")) return;
      try {
        const value = JSON.parse(line.slice(5).trim()), usage = value?.usage ?? value?.response?.usage;
        const input = usage?.prompt_tokens ?? usage?.input_tokens, output = usage?.completion_tokens ?? usage?.output_tokens;
        const total = usage?.total_tokens ?? (Number.isFinite(input) && Number.isFinite(output) ? input + output : undefined);
        if ([input, output, total].every(number => Number.isFinite(number) && number >= 0)) {
          request.usageStatus = "reported";
          request.usage = { inputTokens: input, outputTokens: output, totalTokens: total };
        }
      } catch { /* This can be an ordinary SSE delta or [DONE]; no raw data is retained. */ }
    };
    const stream = new TransformStream({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = pending.indexOf("\n")) >= 0) {
          capture(pending.slice(0, newline).replace(/\r$/, ""));
          pending = pending.slice(newline + 1);
        }
        if (pending.length > 262_144) {
          pending = "";
          request.usageLineOverflow = true;
        }
        controller.enqueue(chunk);
      },
      flush() {
        pending += decoder.decode();
        if (pending) capture(pending);
        pending = "";
      },
    });

    return new Response(response.body.pipeThrough(stream), { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  process.once("exit", () => process.stderr.write(`TRYLO_REAL_SEQUENCE_TELEMETRY ${JSON.stringify({ requests, fetchCalls: requests.filter(request => request.sent).length, refused })}\n`));
}

/** Read the same authoritative Board immediately before a learning HTTP send. */
async function reservationBeforeSend(body, spent) {
  const build = process.env.TRYLO_REAL_SEQUENCE_BUILD, root = process.env.TRYLO_REAL_SEQUENCE_BOARD_ROOT;
  const workspaceId = process.env.TRYLO_REAL_SEQUENCE_WORKSPACE_ID;
  if (!build || !root || !workspaceId) throw fail("learning_budget_proof_config_missing");

  const [{ createBoardReader }, { learningGrantSnapshots }] = await Promise.all([
    loadRealModule(build, "adapters/learning-store/file-event-store"), loadRealModule(build, "learning/control/grant-state"),
  ]);
  const loaded = await createBoardReader(root).load();
  if (!loaded.ok) throw fail("learning_budget_board_unavailable");

  const grants = learningGrantSnapshots(loaded.state.learningGrantFacts ?? []);
  if (!grants) throw fail("learning_budget_history_invalid");

  const pending = [...grants.values()].filter(grant => grant.workspaceId === workspaceId)
    .flatMap(grant => grant.reservations.filter(reservation => reservation.state === "reserved").map(reservation => ({ grant, reservation })));
  if (pending.length !== 1) throw fail("learning_http_has_no_unique_reservation");

  const { grant, reservation } = pending[0], key = `${grant.grantId}/${reservation.reservationId}`;
  if (grant.status !== "in_flight" || grant.closedReason || spent.has(key)) throw fail("learning_http_reservation_reused_or_closed");

  const cap = body?.max_tokens ?? body?.max_completion_tokens ?? body?.max_output_tokens;
  if (cap !== reservation.maxOutputTokens || grant.callsReserved > grant.allowance.maxCalls
    || reservation.maxOutputTokens > grant.allowance.maxOutputTokens - grant.reportedOutputTokens) throw fail("learning_http_exceeds_reserved_budget");

  spent.add(key);

  return { grantId: grant.grantId, reservationId: reservation.reservationId, boardSequence: loaded.state.sequence,
    maxOutputTokens: reservation.maxOutputTokens, allowance: grant.allowance, callsReserved: grant.callsReserved };
}

export function auditLearningCosts(state, requests, workspaceId, maxGrants) {
  const facts = state.learningGrantFacts ?? [], opens = facts.filter(fact => fact.kind === "open"), reserved = facts.filter(fact => fact.kind === "reserve");
  const settlements = facts.filter(fact => fact.kind === "settle"), learning = requests.filter(request => request.purpose !== "execution");
  const errors = [], keys = new Set();

  if (opens.length > maxGrants || opens.some(fact => fact.workspaceId !== workspaceId || fact.subsystem !== "skill")) errors.push("grant_scope_or_count_mismatch");

  for (const request of learning) {
    const proof = request.grantProof, key = proof ? `${proof.grantId}/${proof.reservationId}` : undefined;
    const reserve = reserved.find(fact => fact.grantId === proof?.grantId && fact.reservationId === proof?.reservationId);
    const settle = settlements.find(fact => fact.grantId === proof?.grantId && fact.reservationId === proof?.reservationId);

    if (!key || keys.has(key) || !reserve || reserve.boardSequence > proof.boardSequence) errors.push("request_reservation_missing_duplicate_or_late");

    if (key) keys.add(key);

    if (!settle || settle.usage.kind !== "reported" || request.usageStatus !== "reported"
      || ["inputTokens", "outputTokens", "totalTokens"].some(field => settle.usage[field] !== request.usage?.[field])) errors.push("wire_usage_does_not_match_board_settlement");
  }

  if (reserved.length !== learning.length || settlements.length !== learning.length) errors.push("learning_call_count_does_not_match_board");

  for (const open of opens) {
    const calls = reserved.filter(fact => fact.grantId === open.grantId), usage = settlements.filter(fact => fact.grantId === open.grantId);
    const output = usage.reduce((total, fact) => total + (fact.usage.kind === "reported" ? fact.usage.outputTokens : 0), 0);
    if (calls.length > open.allowance.maxCalls || output > open.allowance.maxOutputTokens
      || usage.some(fact => fact.usage.kind !== "reported") || !facts.some(fact => fact.kind === "close" && fact.grantId === open.grantId)) errors.push("grant_unsettled_over_limit_or_unclosed");
  }

  return { errors: [...new Set(errors)], grantCount: opens.length, learningHttpRequests: learning.length, reservations: reserved.length,
    wireUsage: aggregateRequests(learning), boardUsage: settlements.reduce((sum, fact) => fact.usage.kind !== "reported" ? sum : {
      inputTokens: sum.inputTokens + fact.usage.inputTokens, outputTokens: sum.outputTokens + fact.usage.outputTokens, totalTokens: sum.totalTokens + fact.usage.totalTokens,
    }, { inputTokens: 0, outputTokens: 0, totalTokens: 0 }) };
}

function fixtureFiles() { return ["check-report.mjs", "report-seed.mjs", "reporting-rules.json", "cases.json", "skill-learning.json", "holdout-source.json", "holdout-brief.json"]; }

function verifyFixtures() {
  for (const name of fixtureFiles()) if (!existsSync(path.join(fixtureRoot, name))) throw fail(`fixture_missing:${name}`);
  const cases = JSON.parse(readFileSync(path.join(fixtureRoot, "cases.json"), "utf8"));
  if (cases.length !== 8) throw fail("fixture_case_count_invalid");
  return cases;
}

/** Prove the independent checker accepts a correct result and rejects the supplied broken one. No model. */
function checkOracle() {
  const root = artifactPath("skill-learning-real", "oracle-selfcheck");
  mkdirSync(root, { recursive: true });
  copyFileSync(path.join(fixtureRoot, "check-report.mjs"), path.join(root, "check-report.mjs"));
  const first = verifyFixtures()[0], output = { groups: [{ group: "cedar", count: 1, total: 7 }, { group: "maple", count: 2, total: 17 }] };

  save(path.join(root, "source.json"), first.source);
  save(path.join(root, "brief.json"), first.brief);
  save(path.join(root, "output.json"), { groups: [] });
  const rejected = spawnSync(process.execPath, ["check-report.mjs"], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 10_000 });

  save(path.join(root, "output.json"), output);
  const accepted = spawnSync(process.execPath, ["check-report.mjs"], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 10_000 });
  const result = { modelCalls: 0, suppliedBrokenResultExit: rejected.status, correctResultExit: accepted.status,
    passed: rejected.status === 1 && accepted.status === 0, checkerSha256: digest(readFileSync(path.join(root, "check-report.mjs"))) };

  save(artifactPath("skill-learning-real", "oracle-selfcheck.json"), result);

  if (!result.passed) throw fail("independent_checker_selfcheck_failed");

  return result;
}

async function main() {
  const cases = verifyFixtures(), oracle = checkOracle();

  if (!process.argv.includes("--execute")) {
    const prepared = { status: "prepared", fixtureRoot, cases: cases.map(item => item.id), oracle, networkRequests: 0,
      executionRequires: "--execute --build-dir=<root-supplied-current-candidate-dist> --out=<new-evidence-directory>" };
    save(artifactPath("skill-learning-real", "PREPARED.json"), prepared);
    process.stdout.write(`${JSON.stringify(prepared)}\n`);
    return;
  }

  const buildArgument = option("build-dir");
  if (!buildArgument) throw fail("explicit_current_candidate_build_required");

  const build = path.resolve(buildArgument), entry = path.join(build, "cmd/trylo/main.js");

  for (const name of [entry, path.join(build, "internal/surface/cli/skill-daily-host.js")]) if (!existsSync(name)) throw fail("candidate_skill_runtime_missing");

  const out = path.resolve(option("out") ?? artifactPath("skill-learning-real", `sequence-${Date.now()}`));
  if (existsSync(path.join(out, "sequence-report.json"))) throw fail("sequence_evidence_exists_no_automatic_rerun");

  const model = option("model") ?? "DeepSeek-V4-Flash";
  const resolved = await resolveRealConnection({ build, workspaceRoot: repoRoot, modelOverride: model });

  runtimeSecret = resolved.apiKey;
  const privacy = await loadRealModule(build, "compaction/disclosure");
  scrub = privacy.scrubDisclosure;
  const profile = path.join(out, "profile"), workspace = path.join(out, "workspace");

  mkdirSync(profile, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  save(path.join(profile, "providers.json"), { version: 1, selected: "sequence-amd", providers: [{ id: "sequence-amd", kind: resolved.selected.kind,
    endpoint: resolved.selected.endpoint, model, streaming: true, tools: true, reasoning: resolved.selected.capabilities.reasoning, cancellation: true }] });

  for (const name of ["check-report.mjs", "reporting-rules.json", "holdout-source.json", "holdout-brief.json"]) copyFileSync(path.join(fixtureRoot, name), path.join(workspace, name));

  const frozenChecker = digest(readFileSync(path.join(workspace, "check-report.mjs")));
  const report = { status: "running", model, configuredModel: resolved.configuredModel, provider: resolved.selected.providerId,
    build, entrySha256: digest(readFileSync(entry)), profile, workspace, oracle, stages: [], startedAt: new Date().toISOString(),
    originalProfileModified: false, secretPersisted: false, skillOrReceiptSeeded: false };
  const maxRequests = Number(option("max-http-requests") ?? 128);
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 512) throw fail("invalid_sequence_http_ceiling");

  const commonEnv = { ...process.env, TRYLO_HOME: profile, TRYLO_OPENAI_API_KEY: runtimeSecret,
    TRYLO_REAL_SEQUENCE_OBSERVER: "1", TRYLO_REAL_SEQUENCE_ORIGIN: resolved.endpoint.origin };
  const [{ createBoardReader }, { createSkillExperienceFile }, { skillDailyManagementPaths }] = await Promise.all([
    loadRealModule(build, "adapters/learning-store/file-event-store"), loadRealModule(build, "integration/skill-learning/experience-file"),
    loadRealModule(build, "surface/cli/skill-daily-management"),
  ]);
  const paths = skillDailyManagementPaths({ cwd: workspace, homeDir: homedir(), env: { TRYLO_HOME: profile } });

  Object.assign(commonEnv, { TRYLO_REAL_SEQUENCE_BUILD: build, TRYLO_REAL_SEQUENCE_BOARD_ROOT: paths.boardRoot, TRYLO_REAL_SEQUENCE_WORKSPACE_ID: paths.workspaceId });
  let preCorrectionVersions = [], totalRequests = 0;
  const flush = () => save(path.join(out, "sequence-report.json"), JSON.parse(safe(JSON.stringify(report))));
  const cli = async (name, args) => {
    const remaining = maxRequests - totalRequests;
    if (remaining <= 0) throw fail("sequence_http_allowance_exhausted");

    report.currentStage = name;
    flush();
    process.stdout.write(`${JSON.stringify({ status: "stage_started", stage: name, completedStages: report.stages.length, httpRequests: totalRequests })}\n`);
    const captured = await runChild(entry, args, workspace, { ...commonEnv, TRYLO_REAL_SEQUENCE_MAX_REQUESTS: String(Math.min(40, remaining)) });
    const stageDir = path.join(out, "stages", name);

    save(path.join(stageDir, "stdout.ndjson"), redactStdout(captured.stdout));
    save(path.join(stageDir, "stderr.txt"), safe(captured.stderr));
    const frames = parseFrames(captured.stdout), telemetryLine = captured.stderr.split(/\r?\n/).find(line => line.startsWith("TRYLO_REAL_SEQUENCE_TELEMETRY "));
    let telemetry;

    try { telemetry = telemetryLine ? JSON.parse(telemetryLine.slice("TRYLO_REAL_SEQUENCE_TELEMETRY ".length)) : undefined; }
    catch { /* Missing telemetry is a stage failure, never zero spend. */ }

    if (telemetry) totalRequests += telemetry.fetchCalls;

    const final = frames.findLast(frame => frame.type === "run_result"), payload = frames.findLast(frame => frame.schemaVersion === 1 && typeof frame.ok === "boolean");
    const usage = aggregateRequests(telemetry?.requests);
    const result = { name, cliExitCode: captured.code, childPid: captured.pid, timedOut: captured.timedOut,
      runResult: final ?? null, payload: payload ?? null, telemetry: telemetry ?? null, usage, totalRequests, errors: [] };

    report.stages.push(result);
    save(path.join(stageDir, "result.json"), JSON.parse(safe(JSON.stringify(result))));
    flush();

    if (!telemetry) throw fail(`stage_missing_http_telemetry:${name}`);

    if (captured.code !== 0 || captured.timedOut || captured.overflow) throw fail(`cli_stage_failed:${name}`);

    if (telemetry.requests.some(request => request.status !== 200 || request.model !== model) || telemetry.refused > 0) throw fail(`http_stage_failed:${name}`);

    if (usage.usageStatus === "missing") throw fail(`unreported_model_cost:${name}`);

    return { result, frames, stageDir, payload };
  };
  const snapshot = async name => {
    const board = await createBoardReader(paths.boardRoot).load();
    if (!board.ok) throw fail(`board_read_failed:${name}`);

    const facts = createSkillExperienceFile({ root: paths.factsRoot, workspaceId: paths.workspaceId, collection: () => "enabled", retention: "segmented" }).read(`acceptance:${name}`);
    if (!facts.ok) throw fail(`facts_read_failed:${name}`);

    save(path.join(out, "stages", name, "board-and-facts.sanitized.json"), safe(JSON.stringify({ board: board.state, opportunity: facts.opportunity, paths }, null, 2)));
    save(path.join(out, "stages", name, "owned-store-files.json"), listOwnedFiles(profile));

    return { state: board.state, facts: facts.opportunity.experiences };
  };

  try {
    flush();

    for (const item of cases) {
      if (item.isCorrection) {
        const beforeCorrection = await snapshot("correction-before");
        preCorrectionVersions = beforeCorrection.state.assets.filter(asset => asset.kind === "skill").map(asset => asset.versionId);
      }

      if (item.withdrawBefore) {
        const listed = await cli("withdraw-list-before", ["skills", "list", "--json"]);
        const live = listed.payload?.skills?.filter(skill => skill.status === "shadow" || skill.status === "active") ?? [];
        if (!live.length) throw fail("withdraw_has_no_actual_live_skill");
        for (const skill of live) await cli(`withdraw-${digest(skill.versionId).slice(0, 8)}`, ["skills", "withdraw", skill.versionId, "--json"]);
        const retired = await cli("withdraw-list-after", ["skills", "list", "--json"]);
        if (retired.payload?.skills?.some(skill => live.some(old => old.versionId === skill.versionId) && skill.status !== "retired")) throw fail("withdraw_pointer_not_retired");
      }

      prepareCase(workspace, item);
      const initialFiles = ["check-report.mjs", "source.json", "brief.json", "reporting-rules.json", "holdout-source.json", "holdout-brief.json"];
      const frozenInputs = Object.fromEntries(initialFiles.map(file => [file, digest(readFileSync(path.join(workspace, file)))]));
      const checkerBefore = spawnSync(process.execPath, ["check-report.mjs"], { cwd: workspace, encoding: "utf8", windowsHide: true, timeout: 10_000 });

      save(path.join(out, "stages", item.id, "fixture-before.json"), { brief: item.brief, source: item.source, independentCheckerExit: checkerBefore.status });

      if (checkerBefore.status !== 1) throw fail(`fixture_does_not_reproduce_failure:${item.id}`);

      const session = `skill-real-${item.id}-${digest(out).slice(0, 8)}`;
      const result = await cli(item.id, ["run", "--workspace", workspace, "--session", session, "--learning", "skill", "--allow-writes",
        "--allow-tools", "run_shell,skill", "--shell-isolation", "host", "--model", model, "--max-iterations", "10", "--max-tokens", "1800", "--format", "stream-json",
        "--system-prompt", executionInstruction(), taskPrompt(item)]);
      const errors = [];

      for (const [file, hash] of Object.entries(frozenInputs)) {
        if (!existsSync(path.join(workspace, file)) || digest(readFileSync(path.join(workspace, file))) !== hash) errors.push(`task_input_was_modified:${file}`);
      }

      save(path.join(result.stageDir, "frozen-inputs.json"), frozenInputs);

      if (digest(readFileSync(path.join(workspace, "check-report.mjs"))) !== frozenChecker) errors.push("independent_checker_was_modified");

      const configExpected = configuredCheck(item.family);
      if (digest(readFileSync(path.join(workspace, ".trylo/skill-learning.json"))) !== digest(JSON.stringify(configExpected, null, 2) + "\n")) errors.push("frozen_learning_config_was_modified");

      const checked = spawnSync(process.execPath, ["check-report.mjs"], { cwd: workspace, encoding: "utf8", windowsHide: true, timeout: 10_000 });

      save(path.join(result.stageDir, "independent-check.json"), { exitCode: checked.status, stdout: safe(checked.stdout ?? ""), stderr: safe(checked.stderr ?? "") });

      if (checked.status !== 0) errors.push("independent_task_check_failed");

      const checks = observedChecks(result.frames), loads = observedSkills(result.frames);
      if (!checks.some(check => check.passed)) errors.push("model_did_not_run_passing_frozen_check");

      if (item.expectFailureThenPass && (!checks[0]?.failed || !checks.at(-1)?.passed || mutationBeforeFirstCheck(result.frames))) errors.push("required_real_failure_before_repair_missing");

      if (item.expectSkill && !loads.length) errors.push("ordinary_task_did_not_load_learned_skill");

      if (item.expectNoSkill && loads.length) errors.push("skill_misapplied_or_withdrawn_version_reused");

      if (item.expectCorrectedVersion && loads.some(load => preCorrectionVersions.includes(load.versionId))) errors.push("pre_correction_skill_reused");

      const captured = await snapshot(item.id);
      const learningCost = auditLearningCosts(captured.state, report.stages.flatMap(stage => stage.telemetry?.requests ?? []), paths.workspaceId,
        report.stages.filter(stage => cases.some(item => item.id === stage.name)).length);

      save(path.join(result.stageDir, "learning-cost-audit.json"), learningCost);
      errors.push(...learningCost.errors);

      if (item.expectCorrectedVersion && loads.some(load => {
        const asset = captured.state.assets.find(asset => asset.versionId === load.versionId);
        const variant = asset?.content?.draft?.variants?.find(variant => variant.id === load.variantId);
        return !variant?.steps?.some(step => /audit.?plan|execution plan|计划|规划文件/i.test(step));
      })) errors.push("corrected_skill_omits_required_plan_step");

      const thisRunFacts = captured.facts.filter(fact => fact.runId.startsWith(`${session}:`));
      if (!thisRunFacts.some(fact => fact.episode.outcome === "success")) errors.push("actual_success_was_not_extracted");

      if (item.expectFailureThenPass && !thisRunFacts.some(fact => fact.episode.outcome === "failure")) errors.push("actual_failure_lesson_was_not_extracted");

      if (item.isCorrection && !thisRunFacts.some(fact => fact.episode.correction && fact.qualification.kind === "explicit_correction")) errors.push("explicit_user_correction_was_not_retained");

      if (item.expectSkill && !thisRunFacts.some(fact => loads.some(load => fact.usedSkill?.versionId === load.versionId
        && fact.usedSkill.variantId === load.variantId && fact.usedSkill.contentHash === load.contentHash))) errors.push("actual_skill_use_was_not_attributed");

      if (item.id === "train-2" && !captured.state.activations.some(activation => activation.assetKind === "skill" && (activation.pointer === "shadow" || activation.pointer === "active"))) errors.push("two_training_tasks_did_not_admit_a_usable_skill");

      for (const file of ["report.mjs", "source.json", "brief.json", "output.json", "audit-plan.json"]) {
        if (existsSync(path.join(workspace, file))) save(path.join(result.stageDir, "artifacts", file), safe(readFileSync(path.join(workspace, file), "utf8")));
      }

      Object.assign(result.result, { errors, checkerCalls: checks, skillLoads: loads, recordedExperienceIds: thisRunFacts.map(fact => fact.episode.id),
        learningCost, accepted: errors.length === 0, snapshotSanitized: true });
      save(path.join(result.stageDir, "result.json"), JSON.parse(safe(JSON.stringify(result.result))));
      flush();

      if (errors.length) throw fail(`behavior_stage_failed:${item.id}:${errors.join(",")}`);
    }

    report.status = "passed";
    report.finishedAt = new Date().toISOString();
    report.httpRequests = totalRequests;
    report.totalUsage = aggregateRequests(report.stages.flatMap(stage => stage.telemetry?.requests ?? []));
    flush();
    process.stdout.write(`${JSON.stringify({ status: report.status, evidence: out, model, httpRequests: totalRequests, usage: report.totalUsage })}\n`);
  } catch (error) {
    report.status = "failed";
    report.failure = typeof error?.safeCode === "string" ? error.safeCode : "real_sequence_unavailable";
    report.finishedAt = new Date().toISOString();
    report.httpRequests = totalRequests;
    report.totalUsage = aggregateRequests(report.stages.flatMap(stage => stage.telemetry?.requests ?? []));
    flush();
    process.stdout.write(`${JSON.stringify({ status: "failed", code: report.failure, evidence: out, httpRequests: totalRequests, usage: report.totalUsage })}\n`);
    process.exitCode = 1;
  } finally { runtimeSecret = undefined; }
}

function configuredCheck(family) {
  const config = JSON.parse(readFileSync(path.join(fixtureRoot, "skill-learning.json"), "utf8"));
  if (family === "preaggregated") Object.assign(config.checks[0], { id: "json-preaggregated-report", label: "independent preaggregated JSON report acceptance",
    taskFamily: { id: "json-preaggregated-report-v1", intentClass: "json-preaggregated-report", checkKind: "acceptance", checkSchema: "preaggregated-json-report-v1" } });
  return config;
}

function prepareCase(workspace, item) {
  save(path.join(workspace, "source.json"), item.source);
  save(path.join(workspace, "brief.json"), item.brief);
  save(path.join(workspace, "output.json"), { groups: [] });

  if (existsSync(path.join(workspace, "audit-plan.json"))) unlinkSync(path.join(workspace, "audit-plan.json"));

  if (item.resetImplementation || !existsSync(path.join(workspace, "report.mjs"))) copyFileSync(path.join(fixtureRoot, "report-seed.mjs"), path.join(workspace, "report.mjs"));

  save(path.join(workspace, ".trylo/skill-learning.json"), configuredCheck(item.family));
  const holdout = JSON.parse(readFileSync(path.join(fixtureRoot, "holdout-brief.json"), "utf8"));

  holdout.requirePlan = item.brief.requirePlan;
  save(path.join(workspace, "holdout-brief.json"), holdout);
}

function executionInstruction() {
  return "You are a real coding executor in an isolated acceptance workspace. MANDATORY ORDER: tool call 1 must only read_file brief.json. Tool call 2 must be run_shell with exactly {command: 'node check-report.mjs'}. Wait for that actual checker result before every other tool call. Do not write, repair, or generate any file before observing that initial assertion failure. An isolation/permission/readiness error means the checker did not run: stop and report it, do not retry or replace verification. After the real initial failure, inspect the inputs, repair report.mjs, regenerate output.json and run the checker again. Solve using actual tools; do not simulate actions or interpret a fixed keyword protocol. Preserve all task inputs (source.json, brief.json, reporting-rules.json, holdout files), check-report.mjs and .trylo/skill-learning.json byte-for-byte. Generate output.json by running report.mjs rather than writing a hard-coded answer. Follow reporting-rules.json. If an applicable learned skill is available, invoke the skill tool and use its procedure after the initial failed check. Run the exact frozen checker as a foreground command after the last mutation, and finish only after it passes. Do not create or edit learning assets, evidence receipts, profile files or skills yourself.";
}

function taskPrompt(item) {
  const base = "Complete this new grouped JSON report from source.json according to brief.json and reporting-rules.json. The supplied output is wrong. First read brief.json; your next tool call must be the exact checker. Observe its assertion failure before other tools, repair report.mjs if necessary, run it to regenerate output.json and rerun the independent command exactly: node check-report.mjs. Do not modify any task input, checker or learning config.";
  if (item.isCorrection) return "从现在起，原始行（raw rows）的分组报表任务族一律先写 audit-plan.json，准确记录 brief.json 的 order 和预期分组数 expectedGroups，然后才生成 output.json；不能再省略这一步。这是对先前原始行处理方法的长期明确纠正，已聚合输入不属于此项方法纠正范围。\n" + base;
  return item.family === "preaggregated" ? base + " This similar-looking task has a different prerequisite: input rows are already aggregated. Sum their supplied record counts and subtotal values; do not count each input row as one original record. A raw-row grouping method is inapplicable." : base;
}

function runChild(entry, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", pathToFileURL(script).href, entry, ...args], { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false, overflow = false;
    const collect = (which, chunk) => { if (which === "stdout") stdout += chunk;else stderr += chunk;
      if (stdout.length + stderr.length > 16 * 1024 * 1024) {
        overflow = true;
        child.kill();
      } };

    child.stdout.on("data", chunk => collect("stdout", chunk));
    child.stderr.on("data", chunk => collect("stderr", chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 10 * 60_000);

    child.once("error", () => {
      clearTimeout(timer);
      reject(fail("sequence_child_spawn_failed"));
    });
    child.once("close", code => {
      clearTimeout(timer);
      resolve({ code, pid: child.pid, stdout, stderr, timedOut, overflow });
    });
  });
}

function parseFrames(stdout) { return stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }

function redactStdout(stdout) {
  return stdout.split(/\r?\n/).map(line => {
    try {
      const frame = JSON.parse(line);
      if (String(frame.type).startsWith("reasoning")) return JSON.stringify({ type: frame.type, text: "[omitted]" });
    }
    catch { /* Non-JSON diagnostics still pass through exact-secret and disclosure scrubbing. */ }
    return safe(line);
  }).join("\n");
}

function aggregateRequests(requests) {
  if (requests === undefined) return { usageStatus: "missing", totalTokens: null, requests: null };

  requests = requests.filter(request => request.sent !== false);
  const known = requests.filter(request => request.usageStatus === "reported");
  const sum = field => known.reduce((total, request) => total + request.usage[field], 0);

  return { usageStatus: known.length === requests.length ? "reported" : "missing", requests: requests.length, missingUsageRequests: requests.length - known.length,
    inputTokens: known.length === requests.length ? sum("inputTokens") : null, outputTokens: known.length === requests.length ? sum("outputTokens") : null,
    totalTokens: known.length === requests.length ? sum("totalTokens") : null, reportedSubtotal: { inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), totalTokens: sum("totalTokens") } };
}

function observedChecks(frames) {
  return frames.filter(frame => frame.type === "tool_use" && frame.name === "run_shell" && frame.input?.command === "node check-report.mjs").map(call => {
    const result = frames.find(frame => frame.type === "tool_result" && frame.toolCallId === call.toolCallId);
    return { toolCallId: call.toolCallId, status: result?.status ?? "missing", failed: /fail|error|denied/i.test(result?.status ?? ""), passed: /succeed|success|completed|result/i.test(result?.status ?? "") };
  });
}

function mutationBeforeFirstCheck(frames) {
  for (const frame of frames.filter(frame => frame.type === "tool_use")) {
    if (frame.name === "run_shell" && frame.input?.command === "node check-report.mjs") return false;
    if (["write_file", "apply_patch", "edit_file", "delete_file", "move_file", "run_shell"].includes(frame.name)) return true;
  }
  return false;
}

function observedSkills(frames) {
  return frames.filter(frame => frame.type === "tool_use" && frame.name === "skill" && /^\/?learned-/.test(frame.input?.skill ?? "")).flatMap(call => {
    const result = frames.find(frame => frame.type === "tool_result" && frame.toolCallId === call.toolCallId);
    const versionId = /Version:\s*([^;\r\n]+)/.exec(result?.output ?? "")?.[1];
    const variantId = /variant:\s*([^;\s\r\n]+)/.exec(result?.output ?? "")?.[1];
    const contentHash = /content hash:\s*([^;\s\r\n]+)/.exec(result?.output ?? "")?.[1];
    return versionId ? [{ toolCallId: call.toolCallId, name: call.input.skill, versionId, variantId: variantId ?? null, contentHash: contentHash ?? null }] : [];
  });
}

function listOwnedFiles(root) {
  const files = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), relative = path.relative(root, file).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        if (relative.startsWith("learning")) visit(file);
        continue;
      }
      if (entry.isFile() && relative.startsWith("learning/") && statSync(file).size <= 16 * 1024 * 1024) files.push({ relative, bytes: statSync(file).size, sha256: digest(readFileSync(file)) });
    }
  };

  visit(root);
  return files;
}

if (process.env.TRYLO_REAL_SEQUENCE_OBSERVER === "1") {
  const { scrubDisclosure } = await import("../../dist/internal/compaction/disclosure.js");
  scrub = scrubDisclosure;
  installObserver();
} else if (process.env.TRYLO_REAL_SEQUENCE_LIBRARY_ONLY !== "1") {
  try { await main(); }
  catch (error) {
    process.stdout.write(`${JSON.stringify({ status: "failed", code: typeof error?.safeCode === "string" ? error.safeCode : "real_sequence_unavailable", secretPersisted: false })}\n`);
    process.exitCode = 1;
  }
}
