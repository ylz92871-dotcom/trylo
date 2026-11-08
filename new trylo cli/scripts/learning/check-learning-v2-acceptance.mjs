import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url), root = fileURLToPath(new URL("../../", import.meta.url));
const description = "Invoice contract: total = sum(lines[*].qty * lines[*].unitPrice) - discount; discount defaults to 0 when absent; qty=0 is legal. qty, unitPrice and discount are finite nonnegative numbers. lines is nonempty. Do not add stricter acceptance conditions.";
const schema = { $id: "urn:trylo:acceptance:invoice:v2", description, type: "object", additionalProperties: false,
  required: ["invoiceId", "lines", "total"], properties: { invoiceId: { type: "string" }, total: { type: "number" },
    discount: { type: "number", minimum: 0 }, lines: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false,
      required: ["qty", "unitPrice"], properties: { qty: { type: "number", minimum: 0 }, unitPrice: { type: "number", minimum: 0 } } } } } };

/** Independent host oracle. It neither imports nor evaluates a generated checker. */
export function invoiceOracle(value, formula = "subtract") {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.invoiceId !== "string"
    || !Array.isArray(value.lines) || value.lines.length === 0 || !Number.isFinite(value.total)) return "fail";

  if (Object.keys(value).some(key => !["invoiceId", "lines", "discount", "total"].includes(key))) return "fail";

  const discount = value.discount === undefined ? 0 : value.discount;
  if (!Number.isFinite(discount) || discount < 0) return "fail";

  let subtotal = 0;

  for (const line of value.lines) {
    if (!line || Object.keys(line).some(key => !["qty", "unitPrice"].includes(key))
      || !Number.isFinite(line.qty) || line.qty < 0 || !Number.isFinite(line.unitPrice) || line.unitPrice < 0) return "fail";
    subtotal += line.qty * line.unitPrice;
  }

  const expected = subtotal + (formula === "add" ? discount : -discount);

  return Number.isFinite(expected) && Math.abs(value.total - expected) <= 1e-9 ? "pass" : "fail";
}

export function acceptancePlan() {
  return { mode: "plan_only; add --execute to call the real configured provider", model: "DeepSeek-V4-Flash", provider: "existing AMD declaration; preserve its actual id spelling",
    limits: { upstreamHttpRequests: 27, perTaskIterations: 3, perRequestOutputTokens: 8192, learningStages: 2, modelCallsPerLearningStage: 3, learningTokensPerStage: 65536 },
    phases: ["injected source/holdout artifacts through ordinary CLI read_file + automatic capture", "independent oracle labels + real model generation and confined evaluation",
      "new task artifact, actual checks and positive/negative transfer", "natural boundary challenge",
      "if needed: explicitly injected faulty working variant + ordinary task produces a real false positive",
      "bound external task-owner correction + real model successor", "unchanged-schema regression", "changed standard must not reuse the old checker", "fresh process recovery and reuse"],
    boundaries: { injected: "input fixtures; optionally a separately labelled faulty checker version, only inside this fresh profile",
      real: "production CLI main/host, provider transport, generation, confinement, permissions, Board and restart",
      oracle: "this script's independent arithmetic; never generated checker output, model self-rating or task completed",
      authority: "explicit experimental parent permission allow-tools read_file,write_file,run_shell; the learning allowance grants none" } };
}

async function worker(requestPath) {
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  const requests = [], originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, init) => {
    if (requests.length >= request.maxCalls) throw new Error("acceptance_http_allowance_exhausted");

    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.model !== request.model) throw new Error("acceptance_model_override_lost");

    const key = body.max_completion_tokens === undefined ? "max_tokens" : "max_completion_tokens";

    body[key] = Math.min(Number.isSafeInteger(body[key]) ? body[key] : 8192, 8192);
    const record = { ordinal: requests.length + 1, model: body.model, maxOutputTokens: body[key], usage: null, status: null };

    requests.push(record);
    const response = await originalFetch(url, { ...init, body: JSON.stringify(body) });

    record.status = response.status;

    if (!response.body) return response;

    let pending = "";
    const decoder = new TextDecoder();
    const accept = line => {
      try {
        const value = JSON.parse(line.replace(/^data:\s*/u, ""));
        if (value.usage && typeof value.usage === "object" && JSON.stringify(value.usage).length <= 8192) record.usage = value.usage;
      } catch { /* SSE separators and [DONE] carry no usage. */ }
    };
    const stream = new TransformStream({ transform(chunk, controller) {
      controller.enqueue(chunk);
      pending += decoder.decode(chunk, { stream: true });
      let boundary;
      while ((boundary = pending.indexOf("\n")) >= 0) {
        accept(pending.slice(0, boundary));
        pending = pending.slice(boundary + 1);
      }
      if (pending.length > 1048576) throw new Error("acceptance_response_capacity");
    }, flush() {
      pending += decoder.decode();
      if (pending) accept(pending);
    } });

    return new Response(response.body.pipeThrough(stream), { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  const load = relative => import(pathToFileURL(path.join(request.build, relative)).href);
  const { createProcessContext, main } = await load("cmd/trylo/main.js");
  const { runCheckLearningOperation } = await load("internal/surface/cli/commands-check-learning.js");
  const { readCheckerBoard, saveCheckerRecord } = await load("internal/integration/check-learning/v2/store.js");
  const ctx = createProcessContext();
  let exitCode = 1, result;

  try {
    if (request.action === "task") exitCode = await main(request.argv, ctx);
    else if (request.action === "fault") {
      // Test-only Board writer path, visibly separate from model generation. No production record is overwritten.
      const before = await readCheckerBoard(request.boardRoot);
      assert(before.ok);
      const parent = before.catalog.versions.find(entry => entry.versionId === request.parent);

      assert(parent, "fault parent must be an actual real-model version");
      const checker = { ...parent.value.checker, parentVersionId: parent.versionId,
        question: "TEST FAULT INJECTION: a known erroneous qty>0 condition", claim: "Deliberately wrong test variant; qty=0 is incorrectly rejected. This is not a natural model mistake.",
        applicability: { ...parent.value.checker.applicability, requiredKeys: ["invoiceId", "lines", "total"], excludedKeys: [], instructionIncludes: [] },
        timing: ["after_tool", "before_completion"], source: 'module.exports = function(input) { const output = input.output; if (output && Array.isArray(output.lines) && output.lines.some(line => line.qty === 0)) return {status:"fail",findings:[{requirementRef:input.task.requirementRef,message:"TEST FAULT INJECTION: incorrectly requires qty > 0"}]}; return {status:"not_applicable",findings:[]}; };' };

      result = await saveCheckerRecord(request.boardRoot, { schemaVersion: 2, type: "checker_version", checker,
        requirements: parent.value.requirements, experienceRefs: parent.value.experienceRefs,
        generation: { requestId: "acceptance-explicit-fault-injection", model: "harness_fault_injection_not_a_model", usage: { inputTokens: 0, outputTokens: 0 } } }, new Date().toISOString());
      exitCode = result.ok ? 0 : 1;
    } else {
      const { parseArgs } = await load("internal/surface/cli/args.js");
      const parsed = parseArgs(["run", "--provider", request.provider, "--model", request.model, "--ask", "never", "--allow-tools", "run_shell", "acceptance"]);

      assert.equal(parsed.kind, "run");
      const operations = request.action === "capture_many" ? request.values.map(value => ({ action: "capture", value })) : [request.operation];

      result = [];

      for (const operation of operations) {
        const actual = await runCheckLearningOperation(ctx, operation, AbortSignal.timeout(600000), parsed.options);
        result.push(actual.result);
        if (actual.exitCode !== 0) {
          exitCode = actual.exitCode;
          break;
        }
        exitCode = 0;
      }
    }

    const loaded = await readCheckerBoard(request.boardRoot);

    process.send?.({ kind: "result", pid: process.pid, exitCode, requests, result, board: loaded });
  } catch (error) {
    process.send?.({ kind: "result", pid: process.pid, exitCode: 1, requests, code: error instanceof Error ? error.message : "acceptance_worker_failed" });
  } finally {
    ctx.close();
    process.disconnect?.();
  }
}

async function execute(flags) {
  const build = path.resolve(root, flags.get("build-dir") ?? "dist");
  const sourceHome = path.resolve(flags.get("source-home") ?? process.env.TRYLO_ACCEPTANCE_HOME ?? path.join(homedir(), ".trylo"));
  const maxCalls = Number(flags.get("max-calls") ?? 27), model = flags.get("model") ?? "DeepSeek-V4-Flash";
  let providerId = flags.get("provider") ?? "amd";

  assert(Number.isSafeInteger(maxCalls) && maxCalls > 0 && maxCalls <= 27, "--max-calls must be 1..27");
  const parentDir = path.resolve(root, flags.get("evidence-dir") ?? "docs/02-分期工程产出/P05-Experience-Learning-V0.3/evidence/2026-11-03-check-learning-v2/real");

  await mkdir(parentDir, { recursive: true });
  const evidence = await mkdtemp(path.join(parentDir, "continuous-"));
  const workspace = path.join(evidence, "workspace"), home = path.join(evidence, "profile"), boardRoot = path.join(home, "learning", "board");

  await mkdir(workspace);
  await mkdir(home);
  const report = { schemaVersion: 1, status: "running", evidence, plan: acceptancePlan(), model, providerId, maxCalls, calls: 0, phases: [], assertions: [], trajectory: "natural" };
  let secret;
  const json = (name, value) => writeFile(path.join(evidence, name), JSON.stringify(value, null, 2) + "\n", "utf8");
  const check = (condition, message) => {
    report.assertions.push({ message, passed: Boolean(condition) });
    assert(condition, message);
  };
  let catalog;
  const call = async (name, data, prompt = "") => {
    const requestPath = path.join(evidence, `${name}.request.json`);

    await writeFile(requestPath, JSON.stringify({ build, boardRoot, provider: providerId, model, maxCalls: maxCalls - report.calls, ...data }), "utf8");
    const child = fork(script, ["--worker", requestPath], { cwd: workspace, windowsHide: true,
      env: { ...process.env, TRYLO_HOME: home, TRYLO_OPENAI_API_KEY: secret }, stdio: ["pipe", "pipe", "pipe", "ipc"] });
    let stdout = "", stderr = "", response;
    const collect = (channel, text) => { if (channel === "stdout") stdout += text; else stderr += text;
      if (stdout.length + stderr.length > 2097152) child.kill(); };

    child.stdout.on("data", bytes => collect("stdout", bytes.toString()));
    child.stderr.on("data", bytes => collect("stderr", bytes.toString()));
    child.on("message", value => { if (value.kind === "result") response = value; });
    const timer = setTimeout(() => child.kill(), data.action === "operation" && data.operation?.action === "learn" ? 900000 : 240000);

    child.stdin.end(prompt);
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });
    clearTimeout(timer);
    const clean = text => secret ? text.replaceAll(secret, "[credential]") : text;

    await writeFile(path.join(evidence, `${name}.stdout.ndjson`), clean(stdout));
    await writeFile(path.join(evidence, `${name}.stderr.log`), clean(stderr));

    if (!response) throw new Error(`acceptance_worker_no_result:${name}:${code}`);

    response = JSON.parse(clean(JSON.stringify(response)));
    report.calls += response.requests.length;
    report.phases.push({ name, pid: response.pid, exitCode: response.exitCode, requests: response.requests });
    await json(`${name}.result.json`, response);
    check(report.calls <= maxCalls, "HTTP allowance respected");
    check(response.exitCode === 0, `${name}: production operation succeeded`);
    check(response.board?.ok, `${name}: persisted Board remains readable`);
    catalog = response.board.catalog;

    return { ...response, stdout };
  };
  const files = new Map(), paths = new Map();
  // Labels and scenario aliases stay outside the workspace. Neither filenames nor invoice ids encode the oracle answer.
  const fixture = async (name, invoice) => { files.set(name, invoice);
  paths.set(name, `artifact-${files.size}.json`);
    await writeFile(path.join(workspace, paths.get(name)), JSON.stringify(invoice));
    await json("injected-fixtures.json", [...files].map(([alias, value]) => ({ alias, path: paths.get(alias), value, expected: Number.isFinite(value.total) ? invoiceOracle(value) : "raw_input_not_an_output_label" }))); };
  const make = (alias, qty, unitPrice, discount, offset = 0) => ({ invoiceId: `inv-${createHash("sha256").update(alias).digest("hex").slice(0, 16)}`,
    lines: [{ qty, unitPrice }], ...(discount === undefined ? {} : { discount }), total: qty * unitPrice - (discount ?? 0) + offset });
  const task = async (name, names, last, schemaName = "invoice-schema.json") => {
    // Freeze the full instruction, not guessed semantic fragments. New tasks vary their data, not their standard.
    const selected = [...names];
    while (selected.length < 4) selected.push(last);
    selected.push(last);
    assert.equal(selected.length, 5);

    for (const [index, alias] of selected.entries()) await writeFile(path.join(workspace, `task-input-${index + 1}.json`), JSON.stringify(files.get(alias)));

    const before = catalog?.runs.length ?? 0;
    const args = ["run", "--provider", providerId, "--model", model, "--workspace", workspace, "--format", "stream-json",
      "--output-schema", path.join(workspace, schemaName), "--output-last-message", path.join(evidence, `${name}.model-artifact.json`),
      "--tools", "read_file", "--ask", "never", "--allow-tools", "read_file,write_file,run_shell", "--check-learning", "--check-learning-budget", "0",
      "--max-iterations", "3", "--max-tokens", "4096", "--context-window", "32768", "-"];
    const result = await call(name, { action: "task", argv: args }, "发票验收审计。这些输入是验收脚本明确注入的测试产物，不是自然模型失误。在同一回复中一次提交所有read_file调用，读取 task-input-1.json、task-input-2.json、task-input-3.json、task-input-4.json、task-input-5.json，不要改文件。最后仅返回task-input-5.json的发票JSON；若缺少total则按冻结规则计算。不要拒绝qty=0或缺省discount。输出必须符合本轮schema。");
    const frames = result.stdout.split(/\r?\n/u).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const terminal = frames.filter(frame => frame.type === "run_result");

    check(terminal.length === 1 && terminal[0].status === "completed", `${name}: exactly one real completed run_result`);

    return catalog.runs.slice(before);
  };
  const label = async name => {
    const selected = ["seed-positive", "seed-negative", "holdout-positive", "holdout-negative"].map(alias => files.get(alias));
    const order = new Map(selected.map((value, index) => [value.invoiceId, index]));
    const experiences = catalog.experiences.map(entry => entry.value).filter(value => value.assessment === undefined
      && value.facts.output && order.has(value.facts.output.invoiceId) && value.facts.phase === "after_tool")
      .sort((a, b) => order.get(a.facts.output.invoiceId) - order.get(b.facts.output.invoiceId));

    check(new Set(experiences.map(value => value.facts.output.invoiceId)).size === 4, "four independent source/holdout artifacts were automatically captured through real tools");
    await call(name, { action: "capture_many", values: experiences.map(value => ({ ...value, id: `oracle:${value.id}`,
      assessment: { kind: "task_oracle", verdict: invoiceOracle(value.facts.output) === "pass" ? "valid" : "invalid", sourceRef: `independent-invoice-oracle:${value.id}` } })) });
  };
  const outcomes = runs => runs.filter(run => run.outcome.kind === "checked");
  const matching = (runs, id, expected, version) => outcomes(runs).some(run => run.input.output?.invoiceId === (files.get(id)?.invoiceId ?? id)
    && run.outcome.verdict.status === expected && (version === undefined || run.versionId === version));

  try {
    const declarations = JSON.parse(await readFile(path.join(sourceHome, "providers.json"), "utf8"));
    const selected = declarations.providers.find(value => flags.has("provider") ? value.id === providerId : value.id.toLowerCase() === "amd");

    check(selected?.kind === "openai-compatible", "requested real provider exists and uses the preflighted adapter family");
    providerId = selected.id;
    report.providerId = selected.id;
    const endpoint = new URL(selected.endpoint);

    check(endpoint.protocol === "https:" && !endpoint.username && !endpoint.password && !endpoint.search, "provider endpoint contains no embedded credentials or query secret to copy into evidence");
    const { createCredentialPort } = await import(pathToFileURL(path.join(build, "internal/adapters/credentials/compose.js")).href);
    const credentials = createCredentialPort({ homeDir: sourceHome, projectDir: root, env: process.env });
    const resolved = selected.accountId === undefined ? credentials.get("openai-compatible")
      : credentials.getAccount({ providerId: "openai-compatible", accountId: selected.accountId });

    check(resolved.ok && typeof resolved.value.secret === "string", "credential resolved through CredentialPort");
    secret = resolved.value.secret;
    const { accountId: _boundAccount, ...publicProvider } = selected;

    await writeFile(path.join(home, "providers.json"), JSON.stringify({ version: 1, selected: providerId, providers: [{ ...publicProvider, model }] }));
    report.credentialStrategy = { originalProfileReadOnly: true, originalLayer: resolved.value.layer, isolatedNamedBindingRemoved: true, childLayer: "declared TRYLO_OPENAI_API_KEY env only", origin: new URL(selected.endpoint).origin };
    await writeFile(path.join(workspace, "invoice-schema.json"), JSON.stringify(schema));
    const changed = { ...schema, description: description.replace(" - discount", " + discount") };

    await writeFile(path.join(workspace, "changed-schema.json"), JSON.stringify(changed));
    await fixture("seed-positive", make("seed-positive", 2, 9, 3));
    await fixture("seed-negative", make("seed-negative", 3, 8, 2, 7));
    // The frozen rule permits a negative derived total when discount exceeds subtotal; do not invent total>=0.
    await fixture("holdout-positive", make("holdout-positive", 2, 7, 20));
    await fixture("holdout-negative", make("holdout-negative", 4, 7, 5, -3));
    const { evaluateSchemaOutput } = await import(pathToFileURL(path.join(build, "internal/adapters/check-learning/schema-oracle.js")).href);
    const structuralReport = evaluateSchemaOutput(schema, files.get("seed-negative"));

    await json("legacy-structural-check.json", structuralReport);
    check(structuralReport.status === "pass" && invoiceOracle(files.get("seed-negative")) === "fail", "legacy shape check demonstrably misses the injected arithmetic defect");
    await task("01-seed", ["seed-positive", "seed-negative", "holdout-positive", "holdout-negative"], "seed-positive");
    check(JSON.parse(await readFile(path.join(evidence, "01-seed.model-artifact.json"), "utf8")).invoiceId === files.get("seed-positive").invoiceId, "seed final output does not expose a holdout through a different phase");
    check(catalog.versions.length === 0 && catalog.runs.length === 0, "fresh profile contained no hand-written or pre-existing checker");
    await label("02-independent-labels");
    await call("03-real-learning", { action: "operation", operation: { action: "learn", allowance: { modelCalls: 3, executions: 64, tokens: 65536 } } });
    const initial = catalog.versions.at(-1);
    check(initial?.value.generation.model === model && initial.value.evaluation?.status === "supported", "real model checker passed independent positive/negative source and holdout evaluation");
    check(initial.value.validationSamples.some(sample => sample.role === "holdout" && sample.expected === "pass") && initial.value.validationSamples.some(sample => sample.role === "holdout" && sample.expected === "fail"), "both holdout classes were actually evaluated");
    const { contentHashOf } = await import(pathToFileURL(path.join(build, "internal/learning/control/hash.js")).href);

    check(initial.value.validationSamples.filter(sample => sample.role === "holdout").every(sample => !(initial.value.generation.exposedInputs ?? []).includes(contentHashOf(sample.input))), "actual holdout inputs were absent from the generation exposure ledger");
    await json("natural-first-version.json", initial);
    await fixture("transfer-positive", make("transfer-positive", 6, 7, 2));
    await fixture("transfer-negative", make("transfer-negative", 8, 4, 1, 6));
    await fixture("new-lines", { invoiceId: "model-artifact", lines: [{ qty: 3, unitPrice: 11 }], discount: 2 });
    const transfer = await task("04-transfer", ["transfer-negative", "transfer-positive", "new-lines"], "new-lines");

    check(matching(transfer, "transfer-negative", "fail", initial.versionId) && matching(transfer, "transfer-positive", "pass", initial.versionId), "ordinary new task executed the learned checker on unseen negative and positive artifacts");
    const produced = JSON.parse(await readFile(path.join(evidence, "04-transfer.model-artifact.json"), "utf8"));

    check(produced.invoiceId === "model-artifact" && invoiceOracle(produced) === "pass", "real model produced a new independently correct task artifact");
    await fixture("boundary-zero", make("boundary-zero", 0, 19, 0));
    await fixture("boundary-default", make("boundary-default", 3, 13, undefined));
    await fixture("boundary-bad", make("boundary-bad", 2, 17, undefined, 9));
    const challenge = await task("05-natural-boundaries", ["boundary-zero", "boundary-default", "boundary-bad"], "boundary-zero");
    let wrong = outcomes(challenge).find(run => run.outcome.verdict.status !== invoiceOracle(run.input.output));
    if (!wrong) {
      report.trajectory = "natural-first-version-preserved + explicit-fault-injection";
      const injected = await call("06-explicit-fault-injection", { action: "fault", parent: initial.versionId });
      report.injectedVersionId = injected.result.versionId;
      const faultRuns = await task("07-injected-false-positive", ["boundary-zero"], "boundary-zero");
      wrong = outcomes(faultRuns).find(run => run.versionId === injected.result.versionId && run.outcome.verdict.status === "fail" && invoiceOracle(run.input.output) === "pass");
    }

    check(wrong !== undefined, "a real executed mismatch exists before submitting any correction");
    await json("actual-mismatch-before-correction.json", wrong);
    await call("08-owner-correction", { action: "operation", operation: { action: "feedback", value: { scope: wrong.scope, sessionId: wrong.sessionId,
      turnId: "acceptance-owner-correction", sourceRef: `acceptance-independent-oracle:${wrong.runId}`, runIds: [wrong.runId],
      text: "External task-owner test oracle correction, not a model self-rating: the frozen invoice rule permits qty=0 and absent discount means 0. Apply total=sum(qty*unitPrice)-discount; keep detecting incorrect totals. This correction applies to this exact frozen requirement class; preserve scope and standard.",
      appliesTo: { kind: "class", requirementRef: wrong.requirements.ref, requirementDigest: wrong.requirements.digest },
      judgment: { runId: wrong.runId, expected: invoiceOracle(wrong.input.output) } } } });
    await call("09-real-correction-learning", { action: "operation", operation: { action: "learn", allowance: { modelCalls: 3, executions: 64, tokens: 65536 } } });
    const corrected = catalog.versions.at(-1);

    check(corrected?.versionId !== wrong.versionId && corrected.value.checker.parentVersionId === wrong.versionId && corrected.value.generation.model === model
      && corrected.value.evaluation?.status === "supported", "real model produced a supported correction in the actual faulty version lineage");
    const regression = await task("10-corrected-regression", ["boundary-zero", "boundary-bad", "boundary-default"], "boundary-default");

    check(matching(regression, "boundary-zero", "pass", corrected.versionId) && matching(regression, "boundary-bad", "fail", corrected.versionId)
      && matching(regression, "boundary-default", "pass", corrected.versionId), "corrected version actually accepts legal boundaries while still rejecting bad totals");
    await fixture("changed-standard", { ...make("changed-standard", 2, 10, 3), total: 23 });
    const changedRuns = await task("11-changed-standard", ["changed-standard"], "changed-standard", "changed-schema.json");

    check(changedRuns.length === 0, "old assets were not misapplied after changing the frozen standard under the same schema id");
    const changedExperience = catalog.experiences.find(entry => entry.value.facts.output?.invoiceId === files.get("changed-standard").invoiceId);

    check(changedExperience?.value.requirements.ref === initial.value.requirements.ref && changedExperience.value.requirements.digest !== initial.value.requirements.digest, "same-ref standard changes retain a distinct requirement digest");
    await call("12-fresh-process-recovery", { action: "operation", operation: { action: "recover" } });
    const restarted = await task("13-restarted-task", ["transfer-negative", "boundary-zero"], "boundary-zero");

    check(matching(restarted, "transfer-negative", "fail", corrected.versionId) && matching(restarted, "boundary-zero", "pass", corrected.versionId), "a new process reused the persisted corrected asset with actual positive and negative execution");
    check(new Set(report.phases.map(phase => phase.pid)).size === report.phases.length, "every operation used a separately restarted production process");
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.failure = secret ? String(error.message).replaceAll(secret, "[credential]") : String(error.message);
  }
  finally {
    await json("acceptance.json", report);
    process.stdout.write(JSON.stringify({ status: report.status, evidence, calls: report.calls, trajectory: report.trajectory, failure: report.failure }) + "\n");
  }

  return report.status === "passed" ? 0 : 1;
}

function flagsFor(args) {
  const flags = new Map();

  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (["--execute", "--plan", "--self-test"].includes(token)) {
      flags.set(token.slice(2), true);
      continue;
    }
    assert(["--build-dir", "--source-home", "--provider", "--model", "--max-calls", "--evidence-dir"].includes(token) && args[index + 1] && !args[index + 1].startsWith("--"), `unknown or incomplete argument: ${token}`);
    flags.set(token.slice(2), args[++index]);
  }

  return flags;
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  if (process.argv[2] === "--worker") await worker(process.argv[3]);
  else {
    const flags = flagsFor(process.argv.slice(2));
    if (flags.has("self-test")) {
      const valid = { invoiceId: "self-test", lines: [{ qty: 0, unitPrice: 4 }, { qty: 3, unitPrice: 7 }], total: 21 };
      assert.equal(invoiceOracle(valid), "pass");
      assert.equal(invoiceOracle({ ...valid, total: 22 }), "fail");
      assert.equal(invoiceOracle({ ...valid, discount: 2, total: 19 }), "pass");
      assert.equal(invoiceOracle({ ...valid, discount: 2, total: 23 }, "add"), "pass");
      assert.equal(invoiceOracle({ ...valid, discount: -1 }), "fail");
      assert.equal(invoiceOracle({ ...valid, total: "21" }), "fail");
      process.stdout.write("independent oracle self-test passed; no provider, credentials, checker execution or profile writes\n");
    } else if (flags.has("execute")) process.exitCode = await execute(flags);
    else process.stdout.write(JSON.stringify(acceptancePlan(), null, 2) + "\n");
  }
}
