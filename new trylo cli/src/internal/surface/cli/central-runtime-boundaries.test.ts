import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProcessContext } from "../../../cmd/trylo/main.js";
import { runtimeScopePaths, readRuntimeIntent, tryAcquireRuntimeOwner } from "../../adapters/central-learning-runtime/files.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { restoreCentralRuntimeRunOptions } from "./central-runtime-settings.js";
import { controlCentralRuntimeFor } from "./central-runtime-control.js";
import { prepareRun, isRunFailure } from "./run-command.js";
import { parseArgs } from "./args.js";
import { createCentralRuntimeMaterials } from "./central-runtime-materials.js";
import { createPersonalAgentProvider } from "./collaboration-parent-context.js";
import type { ProviderPort } from "../../ports/provider.js";
import type { CentralRuntimeConfiguration } from "./central-runtime-configuration.js";
import { centralRuntimeProvider } from "./central-runtime-provider.js";
import { workspaceIdentity } from "./workspace-identity.js";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-runtime-boundary-")), home = path.join(root, "profile"), workspace = path.join(root, "workspace");

  mkdirSync(home);
  mkdirSync(workspace);
  const owned = createProcessContext(), ctx = { ...owned, homeDir: root, cwd: workspace,
    env: { TRYLO_HOME: home }, stdout: () => {}, stderr: () => {} };
  const paths = runtimeScopePaths(home, workspace);
  const configuration: CentralRuntimeConfiguration = { schemaVersion: 1, providerId: "fixture", model: "fixture-model", endpointHash: contentHashOf(""),
    workspaceId: workspaceIdentity(workspace), userLearning: true,
    allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 32000, maxCalls: 4, maxSteps: 4, maxPromptChars: 40000 } };
  const acquired = tryAcquireRuntimeOwner(paths);
  assert.ok(acquired.ok);
  assert.ok(acquired.value.writeIntent({ schemaVersion: 1, homeRoot: paths.homeRoot, workspaceRoot: paths.workspaceRoot,
    enabled: true, configuration, wakeSequence: 4, consumedSequence: 3, wakeReason: "original_source", sourceRefs: ["source:original"] }).ok);
  acquired.value.close();

  return { ctx, paths, configuration, close() {
    owned.close();
    assert.ok(root.startsWith(path.join(tmpdir(), "trylo-runtime-boundary-")));
    rmSync(root, { recursive: true, force: true });
  } };
}

test("normal no-flags preparation restores activation before creating the real source session; privacy pause does not", async () => {
  const f = fixture(), base = { message: ["ordinary work"], readStdin: false };
  try {
    const run = await prepareRun(f.ctx, { options: base, sink: f.ctx, permissionMode: "non_interactive" });

    assert.equal(isRunFailure(run), false);
    if (isRunFailure(run)) return;

    assert.deepEqual(run.centralLearning, f.configuration.allowance);
    assert.ok(run.session);
    await run.close();
    const privateRun = await prepareRun(f.ctx, { options: { ...base, centralRuntimePolicy: "pause" }, sink: f.ctx, permissionMode: "non_interactive" });

    assert.equal(isRunFailure(privateRun), false);
    if (isRunFailure(privateRun)) return;

    assert.equal(privateRun.centralLearning, undefined);
    assert.equal(privateRun.session, undefined);
    assert.equal(privateRun.learning, undefined);
    await privateRun.close();
    const saved = readRuntimeIntent(f.paths);
    assert.equal(saved.ok && saved.value?.enabled, true);
    assert.equal(saved.ok && saved.value?.wakeSequence, 4);
    const smaller = { ...f.configuration.allowance, maxTokens: 1000, maxCalls: 1, maxSteps: 1 };
    const explicit = await restoreCentralRuntimeRunOptions(f.ctx, { ...base, centralLearning: smaller }, f.ctx.cwd);

    assert.deepEqual(explicit.centralLearning, smaller, "a saved allowance cannot enlarge an explicitly bounded source review");
  } finally { f.close(); }
});

test("stop is available without a business turn and cannot fall back to independently paid legacy Agent learning", async () => {
  const f = fixture();
  try {
    assert.equal((await controlCentralRuntimeFor(f.ctx, f.ctx.cwd, "stop")).ok, true);
    const restored = await restoreCentralRuntimeRunOptions(f.ctx, { message: ["next work"], readStdin: false,
      learning: "all", centralLearning: f.configuration.allowance,
      collaborationLearning: 16000, workflowLearning: true }, f.ctx.cwd);

    assert.equal(restored.centralLearning, undefined);
    assert.equal(restored.learning, "user");
    assert.equal(restored.collaborationLearning, "off");
    assert.equal(restored.workflowLearning, undefined);
    assert.equal(parseArgs(["learn", "central", "runtime", "-"]).kind, "learn");
    const policy = parseArgs(["run", "--central-runtime-policy=pause", "private task"]);

    assert.equal(policy.kind === "run" && policy.options.centralRuntimePolicy, "pause");
  } finally { f.close(); }
});

test("opaque peer ownership is decided without probing another owner's Board or private source body", async () => {
  const f = fixture();
  let registryReads = 0;

  try {
    const source = createCentralRuntimeMaterials({ ctx: { ...f.ctx, readDir() {
      registryReads++;
      throw new Error("unexpected_registry_probe");
    } },
      workspaceId: "workspace:boundary", enabled: () => true });
    assert.equal(await source.owns(f.ctx.cwd, "user-original-ledger-ref"), false);
    assert.equal(registryReads, 0);
  } finally { f.close(); }
});

test("independent provider binds the resolved environment account, while changed accounts and endpoints remain rejected", () => {
  const f = fixture(), endpoint = "http://127.0.0.1:1/v1/chat/completions";
  try {
    f.ctx.writeFile(path.join(f.paths.homeRoot, "providers.json"), JSON.stringify({ version: 1, selected: "local-reference", providers: [{
      id: "local-reference", kind: "openai-compatible", endpoint, model: "controlled-local", streaming: true,
      tools: true, cancellation: true, auth: "api_key" }] }));
    const ctx = { ...f.ctx, env: { ...f.ctx.env, TRYLO_OPENAI_API_KEY: "fixture-local-only" } };
    const configuration = { ...f.configuration, providerId: "local-reference", model: "controlled-local", endpointHash: contentHashOf(endpoint), accountId: "env" };
    const built = centralRuntimeProvider(ctx, configuration);

    assert.equal(built.ok, true);
    if (built.ok) {
      assert.equal(built.connection.accountId, "env");
      assert.equal(built.capabilities.tools, true);
    }

    assert.deepEqual(centralRuntimeProvider(ctx, { ...configuration, accountId: "other-account" }), { ok: false, reason: "runtime_provider_reference_changed" });
    assert.deepEqual(centralRuntimeProvider(ctx, { ...configuration, endpointHash: contentHashOf("http://127.0.0.1:2") }), { ok: false, reason: "runtime_provider_reference_changed" });
  } finally { f.close(); }
});

test("the actual PA provider boundary receives private User clarification only while the normal User consumer is enabled", async () => {
  let shown = "", enabled = true, reads = 0;
  const provider: ProviderPort = { async *stream(request) { shown = JSON.stringify(request.messages);
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }; } };
  const experience = { async prepareExperience() { return { ok: true as const, text: "", versionIds: [], selectionId: "none" }; },
    async recordLoad() { throw new Error("no selected experience"); }, async recordDispatch() { throw new Error("no selected experience"); } };
  const parent = createPersonalAgentProvider({ provider, experience, scope: "workspace", turnId: "turn", now: () => "2026-11-05T00:00:00Z",
    warn() {}, inspect: async () => ({}), recentFacts: () => [], enabled: () => enabled,
    readUserClarification() { reads++;
    return { status: "pending", ref: "user:question", question: "Which project scope should this preference use?",
      sourceRefs: ["user:original"], instruction: "Ask only at a relevant handoff; silence and generic yes are not confirmation." }; } });
  const request = { attemptId: "actual-pa-request", model: "controlled", messages: [], tools: [] };

  for await (const _event of parent.stream(request, new AbortController().signal)) { /* Consume the real wrapper boundary. */ }

  assert.match(shown, /Which project scope/);
  assert.match(shown, /not confirmation/);
  assert.equal(reads, 1);
  enabled = false;

  for await (const _event of parent.stream(request, new AbortController().signal)) { /* The disabled consumer still forwards business. */ }

  assert.doesNotMatch(shown, /Which project scope/);
  assert.equal(reads, 1);
});
