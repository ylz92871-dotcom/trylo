import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "./args.js";
import { replSessionOptions, sessionLearningOptions } from "./session-learning-options.js";
import { readCentralLearningOption } from "./central-learning-options.js";
import { centralRuntimeConfiguration, isCentralRuntimeConfiguration, type CentralRuntimeConfiguration } from "./central-runtime-configuration.js";
import { restoreCentralRuntimeRunOptions } from "./central-runtime-settings.js";
import { readRuntimeIntent, runtimeScopePaths, tryAcquireRuntimeOwner } from "../../adapters/central-learning-runtime/files.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { RunScaffold } from "./run-scaffold.js";
import type { CliContext } from "./context.js";

test("normal run and repl carry the same explicit shared worker budget without enabling check", () => {
  const args = ["--central-learning-budget", "32000", "--central-learning-calls", "4"];
  const run = parseArgs(["run", ...args, "ordinary task"]);

  assert.equal(run.kind, "run");
  if (run.kind !== "run") throw new Error("run_parse_failed");

  const centralLearning = { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 32000,
    maxCalls: 4, maxSteps: 4, maxPromptChars: 100000 } as const;

  assert.deepEqual(run.options.centralLearning, centralLearning);
  assert.equal(run.options.checkLearning, undefined);
  assert.deepEqual(sessionLearningOptions(run.options), { centralLearning });
  const repl = parseArgs(["repl", ...args]);

  assert.equal(repl.kind, "repl");
  if (repl.kind !== "repl") throw new Error("repl_parse_failed");

  assert.deepEqual(repl.learningOptions?.centralLearning, centralLearning);
  assert.deepEqual(readCentralLearningOption(new Map()), { ok: true });
});

test("incomplete and out-of-contract central authorizations are rejected before opening a runtime", () => {
  for (const args of [["--central-learning-budget", "32000"], ["--central-learning-calls", "4"],
    ["--central-learning-budget", "0", "--central-learning-calls", "4"],
    ["--central-learning-budget", "32000", "--central-learning-calls", "65"],
    ["--central-learning-budget", "32000", "--central-learning-calls", "4", "--central-learning-prompt-chars", "1000000001"]]) {
    assert.equal(parseArgs(["run", ...args, "ordinary task"]).kind, "error");
  }
});

test("an explicitly sized original review preserves its prompt allowance in runtime configuration", () => {
  const parsed = readCentralLearningOption(new Map([["central-learning-budget", "160000"], ["central-learning-calls", "16"],
    ["central-learning-prompt-chars", "160000"], ["central-learning-thought-tokens", "160000"]]));
  assert.ok(parsed.ok && parsed.value);
  assert.equal(parsed.value.maxPromptChars, 160000);
  assert.equal(parsed.thoughtMaxTokens, 160000);
  assert.ok(isCentralRuntimeConfiguration({ schemaVersion: 1, providerId: "explicit-provider", model: "explicit-model",
    endpointHash: contentHashOf(""), workspaceId: "original-workspace", userLearning: false,
    allowance: parsed.value, thoughtMaxTokens: parsed.thoughtMaxTokens }));
  const implicit = readCentralLearningOption(new Map([["central-learning-budget", "160000"], ["central-learning-calls", "16"]]));
  assert.ok(implicit.ok && implicit.value);
  assert.equal(implicit.value.maxPromptChars, 100000, "the explicit range change does not increase the implicit default");
});

test("read-only inspection and exact-source skill actions have versioned central command routes", () => {
  assert.deepEqual(parseArgs(["learn", "central", "inspect", "-"]), { kind: "learn",
    options: { subsystem: "central", centralOperation: "inspect" } });
  assert.deepEqual(parseArgs(["learn", "central", "skill", "-"]), { kind: "learn",
    options: { subsystem: "central", centralOperation: "skill" } });
  assert.equal(parseArgs(["learn", "central", "inspect"]).kind, "error");
});

test("an independent thought cap survives normal run and repl replacement without changing cumulative authorization", () => {
  const args = ["--central-learning-budget", "32000", "--central-learning-calls", "4", "--central-learning-thought-tokens", "64000"];
  const run = parseArgs(["run", ...args, "ordinary task"]);
  assert.equal(run.kind, "run");

  if (run.kind !== "run") throw new Error("run_parse_failed");

  assert.equal(run.options.centralLearningThoughtMaxTokens, 64000);
  assert.deepEqual(run.options.centralLearning, { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 32000,
    maxCalls: 4, maxSteps: 4, maxPromptChars: 100000 });
  const repl = parseArgs(["repl", ...args]);
  assert.equal(repl.kind, "repl");

  if (repl.kind !== "repl") throw new Error("repl_parse_failed");

  assert.deepEqual(repl.learningOptions, sessionLearningOptions(run.options));
  assert.equal(replSessionOptions("replacement", undefined, sessionLearningOptions(run.options)).centralLearningThoughtMaxTokens, 64000);
  assert.deepEqual(readCentralLearningOption(new Map([["central-learning-budget", "32000"], ["central-learning-calls", "4"],
    ["central-learning-thought-tokens", "64000"]])), { ok: true, value: run.options.centralLearning, thoughtMaxTokens: 64000 });
});

test("thought caps reject invalid values and require an explicit initial cumulative authorization", () => {
  const budget = ["--central-learning-budget", "32000", "--central-learning-calls", "4"];
  for (const value of ["0", "-1", "1.5", "NaN", "1000000001"]) {
    assert.equal(parseArgs(["run", ...budget, "--central-learning-thought-tokens", value, "task"]).kind, "error");
  }
  assert.equal(parseArgs(["run", "--central-learning-thought-tokens", "64000", "task"]).kind, "error");
  assert.equal(parseArgs(["run", ...budget, "--central-learning-thought-tokens", "64000", "--central-learning-thought-tokens", "64000", "task"]).kind, "error");
});

function scaffold(): RunScaffold {
  return { providerId: "fixture", providerKind: "openai-compatible", model: "fixture-model", endpoint: "", apiKey: undefined,
    format: "text", workspaceRoot: path.resolve("thought-fixture-workspace"), workspaceId: "workspace:thought", checkpointRoot: "fixture",
    sessionId: "fixture", warnings: [], close: async () => {}, learning: "all",
    centralLearning: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 32000, maxCalls: 4, maxSteps: 4, maxPromptChars: 100000 } };
}

test("legacy runtime construction keeps its original shape and hash while explicit thought caps remain separate", () => {
  const input = scaffold(), legacy = centralRuntimeConfiguration(input);
  const expected = { schemaVersion: 1, providerId: "fixture", model: "fixture-model", endpointHash: contentHashOf(""),
    workspaceId: "workspace:thought", allowance: input.centralLearning, userLearning: true };

  assert.deepEqual(legacy, expected);
  assert.equal(contentHashOf(legacy), contentHashOf(expected));
  assert.ok(isCentralRuntimeConfiguration(legacy));
  assert.equal(Object.hasOwn(legacy, "thoughtMaxTokens"), false);
  const explicit = centralRuntimeConfiguration({ ...input, centralLearningThoughtMaxTokens: 64000 });
  assert.ok(explicit);
  assert.ok(isCentralRuntimeConfiguration(explicit));
  assert.equal(explicit.thoughtMaxTokens, 64000);
  assert.deepEqual(explicit.allowance, legacy.allowance);
  assert.equal(isCentralRuntimeConfiguration({ ...legacy, thoughtMaxTokens: 0 }), false);
  assert.equal(isCentralRuntimeConfiguration({ ...legacy, thoughtMaxTokens: null }), false);
  assert.equal(isCentralRuntimeConfiguration({ ...legacy, thoughtMaxTokens: undefined }), false);
});

test("saved thought configuration is restored without ordinary flags reconfiguring it and a saved stop clears the carrier", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-cli-thought-")), home = path.join(root, "home"), workspace = path.join(root, "workspace");

  mkdirSync(workspace);
  const ctx: CliContext = { homeDir: root, cwd: workspace, env: { TRYLO_HOME: home }, nodeVersion: "v24.0.0", stdinIsTty: false,
    now: () => 1, newId: prefix => `${prefix}-thought`, readFile: () => undefined, isDirectory: () => true, readDir: () => [],
    writeFile: () => false, stdout() {}, stderr() {}, readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined };
  const paths = runtimeScopePaths(home, workspace), owner = tryAcquireRuntimeOwner(paths);
  assert.ok(owner.ok);
  t.after(() => {
    owner.value.close();
    assert.equal(path.dirname(root), tmpdir());
    assert.match(path.basename(root), /^trylo-cli-thought-/);
    rmSync(root, { recursive: true, force: true });
  });
  const legacy = centralRuntimeConfiguration(scaffold());
  assert.ok(legacy);
  const save = (configuration: CentralRuntimeConfiguration, enabled: boolean) => assert.ok(owner.value.writeIntent({ schemaVersion: 1,
    homeRoot: paths.homeRoot, workspaceRoot: paths.workspaceRoot, configuration, enabled,
    wakeSequence: 1, consumedSequence: 1, wakeReason: "fixture", sourceRefs: [] }).ok);
  const options = { message: [], readStdin: false, centralLearningThoughtMaxTokens: 999 };

  save({ ...legacy, thoughtMaxTokens: 64000 }, true);
  assert.equal((await restoreCentralRuntimeRunOptions(ctx, options, workspace)).centralLearningThoughtMaxTokens, 64000);
  save(legacy, true);
  assert.equal(Object.hasOwn(await restoreCentralRuntimeRunOptions(ctx, options, workspace), "centralLearningThoughtMaxTokens"), false);
  save({ ...legacy, thoughtMaxTokens: 64000 }, false);
  const stopped = await restoreCentralRuntimeRunOptions(ctx, options, workspace);

  assert.equal(stopped.centralLearning, undefined);
  assert.equal(Object.hasOwn(stopped, "centralLearningThoughtMaxTokens"), false);
  const saved = readRuntimeIntent(paths);
  assert.ok(saved.ok);
  assert.equal(saved.value?.configuration.thoughtMaxTokens, 64000);
});
