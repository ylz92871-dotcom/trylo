import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWarmRegistry } from "../../adapters/provider/warm.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import type { CliContext } from "./context.js";
import { wirePorts, type WiringInput } from "./wiring.js";
import { createDenyAllPermission } from "./permission.js";
import { handleRepl } from "./repl.js";
import { runOneTurn, type RunScaffold } from "./run-command.js";
import type { CliSink } from "./render.js";

/**
 * The warm layer, proved where it is used.
 *
 * The claim being tested is narrow and checkable: a surface that runs several
 * turns builds the provider **once**. It is tested at two levels because each
 * alone would be too weak — `wirePorts` shows the same object is handed back,
 * and `runOneTurn` shows a real turn sequence reuses its main and separately
 * metered learning transports instead of rebuilding either policy per turn.
 *
 * The failure half matters just as much. A provider that failed is dropped, so
 * the next turn rebuilds rather than being handed a session that just broke.
 * Refusing to reuse a broken provider is the whole reason a warm layer is safe
 * to have; a cache that hands out a dead session is worse than no cache, because
 * it turns a first-turn failure into a mystery that lasts the whole session.
 */

type Fixture = { readonly ctx: CliContext; readonly root: string; readonly out: string[]; readonly err: string[] };

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "trylo-warm-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");

  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(workspace, "package.json"),
    `${JSON.stringify({ name: "warm-fixture", version: "1.0.0" }, null, 2)}\n`,
    "utf8",
  );
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CliContext = {
    env: { TRYLO_HOME: home },
    homeDir: home,
    cwd: workspace,
    nodeVersion: "v22.0.0",
    stdinIsTty: false,

    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },

    isDirectory: () => true,
    readDir: () => [],
    writeFile: () => true,
    readStdin: async () => "",
    readLine: async () => undefined,
    readSecret: async () => undefined,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    now: () => 0,
    newId: (prefix) => `${prefix}-1`,
  };

  return { ctx, root, out, err };
}

function wiringInput(root: string, warm: ReturnType<typeof createWarmRegistry>): WiringInput {
  return {
    providerId: "fixture",
    providerKind: "fixture",
    model: "fixture",
    endpoint: "",
    apiKey: undefined,
    workspaceRoot: join(root, "workspace"),
    permission: createDenyAllPermission(),
    warm,
  };
}

function scaffoldOf(root: string, warm: ReturnType<typeof createWarmRegistry>, overrides: Partial<RunScaffold> = {}): RunScaffold {
  return {
    providerId: "fixture",
    providerKind: "fixture",
    model: "fixture",
    endpoint: "",
    format: "text",
    apiKey: undefined,
    workspaceRoot: join(root, "workspace"),
    workspaceId: "w",
    checkpointRoot: join(root, "home", "checkpoints"),
    sessionId: "s",
    warm,
    close: async () => {},
    warnings: [],
    ...overrides,
  };
}

function sinkOf(out: string[], err: string[]): CliSink {
  return { stdout: (text) => out.push(text), stderr: (text) => err.push(text) };
}

test("two wirings in a row share one provider, and the numbers say so", () => {
  const fx = fixture();
  const warm = createWarmRegistry({ now: () => 0 });
  const input = wiringInput(fx.root, warm);
  const first = wirePorts(input);
  const second = wirePorts(input);

  assert.equal("ports" in first, true);
  assert.equal("ports" in second, true);

  if (!("ports" in first) || !("ports" in second)) {
    return;
  }

  assert.equal(first.ports.provider === second.ports.provider, true);
  assert.deepEqual(warm.stats(), { builds: 1, hits: 1, rebuilds: 0, evictions: 0 });
});

test("three turns reuse one main transport and one funded-learning transport", async () => {
  const fx = fixture();
  const warm = createWarmRegistry({ now: () => 0 });
  const scaffold = scaffoldOf(fx.root, warm);
  const sink = sinkOf(fx.out, fx.err);

  for (let turn = 0; turn < 3; turn += 1) {
    const outcome = await runOneTurn(fx.ctx, scaffold, `turn ${turn}`, sink, "non_interactive", {});
    assert.equal("exitCode" in outcome && "hint" in outcome, false, "the turn must run, not fail");
  }

  const stats = warm.stats();

  assert.equal(stats.builds, 2, "default PA wiring keeps one transport for each request policy");
  assert.equal(stats.hits, 4, "the second and third turns reuse both policy entries");
  assert.equal(stats.rebuilds, 0);
});

test("a provider that failed is not handed to the next turn", async () => {
  // Nothing is listening on port 1, so the adapter's attempt loop ends in a
  // network failure — the one class of failure that must evict a warm entry.
  const fx = fixture();
  const warm = createWarmRegistry({ now: () => 0 });
  const broken = scaffoldOf(fx.root, warm, {
    providerId: "openai-compatible",
    providerKind: "openai-compatible",
    endpoint: "http://127.0.0.1:1/v1",
    apiKey: "test-key-not-a-secret",
  });
  const sink = sinkOf(fx.out, fx.err);
  const outcome = await runOneTurn(fx.ctx, broken, "hello", sink, "non_interactive", {});

  assert.equal("exitCode" in outcome ? outcome.exitCode : -1, EXIT_CODES.TEMPORARY);
  assert.equal(warm.size(), 0, "the failed session was dropped, not kept warm");
  assert.equal(warm.stats().evictions, 2, "both transports for the failed selection are evicted");
  // The next turn rebuilds both policies rather than reusing either failed entry.
  const again = await runOneTurn(fx.ctx, broken, "hello again", sink, "non_interactive", {});

  assert.equal("exitCode" in again ? again.exitCode : -1, EXIT_CODES.TEMPORARY);
  assert.equal(warm.stats().builds, 4);
});

test("the line REPL still runs several turns end to end", async () => {
  const fx = fixture();
  const lines = ["first", "second", "/exit"];
  let index = 0;
  const ctx: CliContext = {
    ...fx.ctx,
    readLine: async () => lines[index++],
  };
  const code = await handleRepl(ctx, sinkOf(fx.out, fx.err), undefined);

  assert.equal(code, EXIT_CODES.OK);
  // Two prompts, two answers, one shell — the fixture answers by naming the
  // workspace's package, so counting those answers is counting the turns.
  const answers = fx.out.join("").split("The package name is").length - 1;

  assert.equal(answers, 2);
});
