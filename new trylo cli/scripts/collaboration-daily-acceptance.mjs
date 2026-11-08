import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { recordDailyCheckerFeedback } from "./collaboration-daily-checks.mjs";

// Drive the ordinary CLI and its automatic collaboration worker. This runner
// never invokes the learning service, inserts facts or manufactures receipts.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const build = path.resolve(root, arg("build-dir") ?? "dist");
const stage = arg("stage") ?? "baseline";

assert.ok(["baseline", "transfer", "independent", "corrected", "after-correction"].includes(stage), "Unknown acceptance stage");

const runDir = path.resolve(arg("run-dir") ?? path.join(root, "docs/02-分期工程产出/P05-Experience-Learning-V0.3/evidence/2026-11-03-collaboration-learning/daily", new Date().toISOString().replaceAll(/[:.]/g, "-")));
const workspace = path.join(runDir, "workspace"), profile = path.join(runDir, "profile");
const stageDir = path.join(runDir, stage), teamRunId = `daily-${stage}`;

assert.ok(!existsSync(path.join(stageDir, "result.json")), "Choose a fresh stage; prior evidence is immutable");

mkdirSync(stageDir, { recursive: true }); mkdirSync(workspace, { recursive: true }); mkdirSync(profile, { recursive: true });

const save = (name, value) => { const target = path.join(stageDir, name);
mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n"); };
const hash = value => createHash("sha256").update(value).digest("hex");
const taskDirectory = path.join(workspace, stage);

mkdirSync(taskDirectory, { recursive: true });

const cases = stage === "transfer" ? { sourceField: "elapsed", targetField: "seconds", raw: 3210, scale: 0.001 }
  : stage === "independent" ? { sourceField: "count", targetField: "count", raw: 6, scale: 1 }
  : { sourceField: "subtotal", targetField: "usd", raw: 12500, scale: 0.01 };
const item = { ...cases, independent: stage === "independent", folder: stage };

writeFileSync(path.join(taskDirectory, "source.json"), JSON.stringify({ [item.sourceField]: item.raw, units: 3 }));

writeFileSync(path.join(taskDirectory, "producer-brief.json"), JSON.stringify({ sourceField: item.sourceField,
  targetField: item.targetField, scale: item.scale, expected: item.raw * item.scale,
  reason: "The producer contract fixes units. The raw export alone does not encode them." }));

const workerPrompt = "Implement only the assigned mapping JSON using supplied read_file/write_file paths. Mapping JSON has exactly sourceField:string,targetField:string,scale:number. Do not change source inputs. In the legacy fast lane, unspecified unit scale defaults to 1. Apply an actual supplied collaboration action if relevant; if it requires producer context, ask the parent before writing. Never invent unit values or verification evidence.";
const members = [
  { memberId: "architect", baseRole: "architect", displayName: "Producer", prompt: "Read the producer brief; return a canonical handoff with scope,artifacts[],evidence[],pending[],blockers[]. Do not edit files." },
  { memberId: "worker-a", baseRole: "worker", displayName: "Mapping", prompt: workerPrompt },
  { memberId: "worker-b", baseRole: "worker", displayName: "Independent count", prompt: workerPrompt },
  { memberId: "reviewer", baseRole: "reviewer", displayName: "Independent review", prompt: "Independently read actual source, mappings and producer brief. Calculate expected and actual results. Never edit files. Report defects with observed numeric evidence, separating schema/capability problems from missing shared context. Use report_collaboration_observation {dimension:'review',summary,evidence_refs:[]} for an actual independent assessment; empty refs let runtime ground it to your active round. Never claim a missing file passed." },
];
const teamDir = path.join(workspace, ".trylo/team", teamRunId);

mkdirSync(teamDir, { recursive: true });

writeFileSync(path.join(teamDir, "profile.v1.json"), JSON.stringify({ frozenProfile: { surface: "code", members: members.map(member => ({
  memberId: member.memberId, baseRole: member.baseRole, overlay: { model: arg("model") ?? "DeepSeek-V4-Flash", skills: [],
    systemPromptOverlay: member.prompt, tools: member.baseRole === "worker" ? ["read_file", "write_file"] : ["read_file"] },
})) } }, null, 2));

const system = `<trylo_team_access>\ndecision: spawn_team\nsurface: code\nteamRunId: ${teamRunId}\n${members.map(member => `- member_id=${member.memberId} baseRole=${member.baseRole} displayName=${member.displayName}`).join("\n")}\n</trylo_team_access>`;
const systemFile = path.join(stageDir, "team-system.txt"); writeFileSync(systemFile, system);

const initial = item.independent
  ? `This is an independent count mapping. Worker-a has all information: ${item.sourceField}->${item.targetField}, scale1. No producer artifact is a prerequisite; no context request is needed.`
  : "Legacy runbook: after Producer finishes, assign Mapping with only source path, output path and required field names; the old handoff omitted producer artifacts/evidence. The normal scale default is1 when context is absent. Current applicable collaboration practices may change this runbook before dependent work.";
const prompt = `Complete one small team delivery in workspace ${workspace}. Work only under ${stage}/. Use actual frozen members, never implement for them. ${initial}\n`
  + `1. Producer reads ${stage}/producer-brief.json and returns the contract.\n`
  + `2. Mapping writes ${stage}/mapping.json from ${stage}/source.json, sourceField=${item.sourceField},targetField=${item.targetField}. This ${item.independent ? "has no" : "has a producer artifact"} dependency. Use actual ready prerequisite IDs when declaring a dependency.\n`
  + `3. Independent count writes ${stage}/count-mapping.json, sourceField=units,targetField=count,scale1. This task is independent and may run in parallel.\n`
  + "4. Reviewer independently reads source, both outputs and producer brief. Ask for numeric schema and delivery checks. If a defect is found, pass the actual canonical handoff to the same worker and repair at most once. Ask Reviewer to recheck real repaired outputs. An independent artifact watcher preserves observed versions automatically.\n"
  + "Use read/write tools only. Ask members for bounded work (token_budget6000,timeout_ms120000,max_iterations8 when supported). Wait for actual completed rounds. Adopt an applicable displayed learning action only when its conditions hold, using its real action id; do not invent an action. Keep schema/format defects distinct from unit/context defects. Close all members before finishing. Return a concise factual result including files and remaining failures. Do not claim external acceptance.";

save("prompt.txt", prompt); save("case.json", item);

const candidateFiles = [];
const inventory = directory => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name), relative = path.relative(build, absolute).replaceAll(path.sep, "/");
    if (/\.test\.|\.test$/.test(entry.name) || /^(?:tests[^/]*\.tap|quality-report\.json|wp27-[^/]*\.json)$/.test(relative)) continue;
    if (entry.isDirectory()) inventory(absolute);
    else { assert.ok(entry.isFile(), "Candidate must not contain redirected entries");
    const bytes = readFileSync(absolute);
      candidateFiles.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) }); }
  }
};

inventory(build); candidateFiles.sort((a, b) => a.path.localeCompare(b.path));

const candidate = { schemaVersion: 1, files: candidateFiles, nodeSha256: hash(readFileSync(process.execPath)),
  runtimeLockSha256: hash(readFileSync(path.join(root, "package-lock.json"))) };
const candidateHash = hash(JSON.stringify(candidate)), frozen = path.join(runDir, "candidate-files.json");
if (existsSync(frozen)) assert.equal(hash(JSON.stringify(JSON.parse(readFileSync(frozen, "utf8")))), candidateHash,
  "Candidate bytes changed between stages; use a distinct evidence run and label migration explicitly");
else writeFileSync(frozen, JSON.stringify(candidate, null, 2) + "\n", { flag: "wx" });

save("candidate.json", { build, manifest: frozen, candidateHash, fileCount: candidateFiles.length,
  runnerSha256: hash(readFileSync(fileURLToPath(import.meta.url))), checkerSha256: hash(readFileSync(new URL("./collaboration-daily-checks.mjs", import.meta.url))),
  mode: "ordinary-cli-auto-driver", manualLearningInvocation: false });

if (process.argv.includes("--prepare-only")) {
  save("prepared.json", { workspace, profile, stage, apiCalls: 0 });
  console.log(JSON.stringify({ prepared: true, stageDir }));
} else {
  const imported = await import(pathToFileURL(path.join(build, "internal/adapters/credentials/compose.js")).href);
  const sourceHome = process.env.TRYLO_ACCEPTANCE_HOME ?? path.join(homedir(), ".trylo");
  const declarations = JSON.parse(readFileSync(path.join(sourceHome, "providers.json"), "utf8"));
  const declared = declarations.providers.find(value => value.id === declarations.selected);

  assert.equal(declared?.kind, "openai-compatible", "This runner needs the configured Chat-compatible account");
  const credentials = imported.createCredentialPort({ homeDir: sourceHome, projectDir: root, env: process.env, now: () => new Date().toISOString() });
  const account = credentials.getAccount({ providerId: "openai-compatible", accountId: declared.accountId });

  assert.ok(account.ok, "Configured credential must resolve through CredentialPort");
  const model = arg("model") ?? "DeepSeek-V4-Flash";

  save("provider.json", { provider: declared.id, origin: new URL(declared.endpoint).origin,
    configuredModel: declared.model, model, modelOverride: model !== declared.model, credentialLayer: account.value.layer });
  const env = { ...process.env, TRYLO_HOME: profile, TRYLO_OPENAI_API_KEY: account.value.secret, TRYLO_API_KEY: "" };
  const cliArgs = [path.join(build, "cmd/trylo/main.js"), "run", "--provider=openai-compatible", `--model=${model}`,
    `--endpoint=${declared.endpoint}`, "--format=stream-json", `--workspace=${workspace}`, "--subagent", "--ask=never",
    "--allow-tools=read_file,write_file", "--deny-tools=run_shell", `--session=${teamRunId}`,
    "--tools=read_file,write_file,spawn_agent,send_input,wait_agent,close_agent,list_agents,resume_agent",
    "--max-iterations=28", "--max-tokens=50000", "--collaboration-learning=16000", `--append-system-prompt-file=${systemFile}`, "-"];

  save("invocation.json", { executable: process.execPath, args: cliArgs, env: { TRYLO_HOME: profile, credential: "CredentialPort -> child environment (not recorded)" } });
  const module = name => import(pathToFileURL(path.join(build, "internal/surface/cli", `${name}.js`)).href);
  const [{ parseRun }, { permissionChoice, permissionFor }, { teamProfileFor }, { wirePorts }, { createSubagentCheckpointJournal }] = await Promise.all([
    module("args-run"), module("permission-for-run"), module("team-profile-wiring"), module("wiring"),
    import(pathToFileURL(path.join(build, "internal/adapters/subagent-checkpoints/journal.js")).href),
  ]);
  const parsed = parseRun(cliArgs.slice(2));
  assert.equal(parsed.kind, "run", "Exact real CLI flags must parse before spending provider quota");
  const permitted = permissionFor("non_interactive", { stderr: () => {}, readLine: async () => undefined }, permissionChoice(parsed.options), workspace);
  const frozenTeam = teamProfileFor({ workspaceRoot: workspace, systemPrompt: system,
    readFile: filename => existsSync(filename) ? readFileSync(filename, "utf8") : undefined });

  assert.ok(frozenTeam.ok && frozenTeam.team !== undefined, "Exact frozen team must be readable");
  const wired = wirePorts({ providerId: "openai-compatible", model, endpoint: declared.endpoint, apiKey: undefined,
    workspaceRoot: workspace, permission: permitted, toolSelection: parsed.options.toolSelection,
    subagent: { enabled: true, team: frozenTeam.team, checkpoints: createSubagentCheckpointJournal([], teamRunId, async () => {}) } });

  assert.ok(!("code" in wired), "Production wiring must admit this team");

  try {
    const names = wired.ports.tools.snapshot().map(binding => binding.name);
    const inheritedRead = permitted.inheritance.canUseTool("read_file"), inheritedWrite = permitted.inheritance.canUseTool("write_file");
    save("catalog-permission-preflight.json", { mode: "structural-production-wiring-only", providerCalls: 0, names, inheritedRead, inheritedWrite });
    for (const name of ["spawn_agent", "send_input", "wait_agent", "close_agent", "list_agents", "resume_agent", "read_file", "write_file"]) assert.ok(names.includes(name), `Missing actual tool ${name}`);
    assert.ok(inheritedRead && inheritedWrite, "Actual inherited permission must allow bounded read/write");
  } finally { await wired.close(); }

  if (process.argv.includes("--preflight-only")) {
    save("preflight-only.json", { providerCalls: 0, passed: true });
    console.log(JSON.stringify({ preflight: true, stageDir }));
    process.exit(0);
  }

  let stdout = "", stderr = "", timedOut = false;
  const versions = [];
  const snapshot = filename => {
    if (filename !== "mapping.json" && filename !== "count-mapping.json") return;
    try {
      const bytes = readFileSync(path.join(taskDirectory, filename), "utf8"), sha256 = hash(bytes);
      if (versions.some(value => value.filename === filename && value.sha256 === sha256)) return;
      const artifact = `artifact-versions/${String(versions.length + 1).padStart(3, "0")}-${filename}`;
      save(artifact, bytes);
      versions.push({ filename, sha256, artifact, observedAt: new Date().toISOString() });
      save("artifact-versions.json", versions);
    } catch { /* A rename/write can temporarily remove a file; the next event retries. */ }
  };
  const watcher = watch(taskDirectory, (_event, filename) => snapshot(String(filename)));
  const startedAt = Date.now();
  const child = spawn(process.execPath, cliArgs, { cwd: workspace, windowsHide: true, env, stdio: ["pipe", "pipe", "pipe"] });

  child.stdout.on("data", chunk => {
    stdout += String(chunk);
    save("stdout.jsonl", stdout);
  });
  child.stderr.on("data", chunk => {
    stderr += String(chunk);
    save("stderr.log", stderr);
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 10 * 60_000);
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
    child.stdin.end(prompt);
  })
    .finally(() => {
      clearTimeout(timer);
      snapshot("mapping.json");
      snapshot("count-mapping.json");
      watcher.close();
    });
  const frames = stdout.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return { unparsed: line }; } });
  const terminal = frames.filter(frame => frame.type === "run_result");
  const check = (filename, sourceField, targetField, scale, directory = taskDirectory) => {
    let actual, error;
    try { actual = JSON.parse(readFileSync(path.join(directory, filename), "utf8")); } catch (cause) { error = cause.message; }
    const schemaValid = actual !== null && typeof actual === "object" && !Array.isArray(actual) && Object.keys(actual).length === 3
      && actual.sourceField === sourceField && actual.targetField === targetField && typeof actual.scale === "number" && Number.isFinite(actual.scale);
    return { filename, actual: actual ?? null, schemaValid, expectedScale: scale, passed: schemaValid && Math.abs(actual.scale - scale) < 1e-12, ...(error ? { error } : {}) };
  };
  const final = check("mapping.json", item.sourceField, item.targetField, item.scale);
  const first = versions.find(version => version.filename === "mapping.json");
  const before = first === undefined ? undefined : check(first.artifact, item.sourceField, item.targetField, item.scale, stageDir);
  const count = check("count-mapping.json", "units", "count", 1);
  const result = { stage, exitCode, timedOut, elapsedMs: Date.now() - startedAt, terminalCount: terminal.length,
    terminal: terminal[0] ?? null, versions, checks: { final, count, before: before ?? null },
    unitOnlyReworkObserved: before?.schemaValid === true && !before.passed && final.passed,
    acceptedDelivery: final.passed && count.passed,
    learningBenefitAccepted: false,
    limitation: "Artifact checks are independent sidecar evidence. Runtime/member completion is not delivery acceptance. Cross-stage comparison and actual Board exposure/adoption must be inspected separately." };

  save("result.json", result);
  const checkedFeedback = await recordDailyCheckerFeedback({ build, profile, workspace, teamRunId, stageDir, item, versions });

  save("checked-feedback.json", checkedFeedback);
  const bound = checkedFeedback.ok ? checkedFeedback.results.filter(entry => entry.subject.memberId === "worker-a" && entry.result.ok) : [];

  result.unitOnlyReworkObserved = bound.some(failed => failed.checks.schemaValid && !failed.checks.passed
    && bound.some(repaired => repaired.subject.taskId === failed.subject.taskId && repaired.subject.round > failed.subject.round && repaired.checks.passed));
  save("result.json", result);
  const statusArgs = [path.join(build, "cmd/trylo/main.js"), "learn", "collaboration", "status", "--workspace", workspace, "--json"];
  const inspect = spawn(process.execPath, statusArgs, { cwd: workspace, windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
  let state = "", diagnostics = "";

  inspect.stdout.on("data", chunk => { state += String(chunk); });
  inspect.stderr.on("data", chunk => { diagnostics += String(chunk); });
  const inspectExit = await new Promise((resolve, reject) => {
    inspect.once("error", reject);
    inspect.once("close", resolve);
  });

  save("board-status.json", state);
  save("board-status-stderr.log", diagnostics);
  save("board-status-exit.json", inspectExit);
  console.log(JSON.stringify({ stageDir, exitCode, acceptedDelivery: result.acceptedDelivery,
    unitOnlyReworkObserved: result.unitOnlyReworkObserved, learningBenefitAccepted: false }));

  if (exitCode !== 0 || timedOut || !result.acceptedDelivery) process.exitCode = 1;
}
