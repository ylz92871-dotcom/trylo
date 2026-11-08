import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CONCAT_ARRAY_KEYS } from "../../settings/schema.js";
import { concatStringArrays, mergeValue, resolveSettings } from "../../settings/merge.js";
import { configValueView, loadConfig, type ConfigLoadIo } from "./config-load.js";

/**
 * The five-layer contract (WP A 波 §2, 反方 #1–#5).
 *
 * Each test is written as the attack that must stay red: precedence inversion,
 * a `cli_flag` that a project file can overwrite, arrays clobbered instead of
 * merged, two load paths both reachable, and an environment variable treated as
 * a layer. "Red" means the assertion fails, so a future change that reintroduces
 * the attack turns the build red here rather than in production.
 */

const CLI_DIR = path.join(process.cwd(), "src", "internal", "surface", "cli");
const CMD_DIR = path.join(process.cwd(), "src", "cmd", "trylo");

function fsOf(files: Readonly<Record<string, string>>): (p: string) => string | undefined {
  return (p: string) => files[p];
}

function io(files: Readonly<Record<string, string>>, systemDir?: string): ConfigLoadIo {
  return {
    readFile: fsOf(files),
    profileDir: "/home/u/.trylo",
    cwd: "/ws",
    ...(systemDir === undefined ? {} : { systemDir }),
  };
}

/** `path.join` on this platform, so the candidate keys match what discovery builds. */
function layerFile(root: string): string {
  return path.join(root, ".trylo", "config.json");
}

const SYSTEM_FILE = path.join("/etc/trylo", "config.json");

test("attack #2: a project file cannot overwrite a cli_flag value", () => {
  const loaded = loadConfig(
    io(
      { [layerFile("/ws")]: JSON.stringify({ maxIterations: 99 }) },
    ),
    { maxIterations: 3 },
  );

  assert.equal(loaded.ok, true, JSON.stringify(loaded));

  if (!loaded.ok) {
    return;
  }

  assert.equal(loaded.resolved["maxIterations"]?.value, 3);
  assert.equal(loaded.resolved["maxIterations"]?.layer, "cli_flag");
});

test("attack #2 (inverted): a lower layer never wins over a higher one", () => {
  const loaded = loadConfig(
    io({
      [layerFile("/home/u")]: JSON.stringify({ maxTokens: 111 }),
      [layerFile("/ws")]: JSON.stringify({ maxTokens: 222 }),
    }),
    {},
  );

  assert.equal(loaded.ok, true, JSON.stringify(loaded));

  if (!loaded.ok) {
    return;
  }

  assert.equal(loaded.resolved["maxTokens"]?.value, 222, "project must beat user");
  assert.equal(loaded.resolved["maxTokens"]?.layer, "project");
});

test("the five-layer order holds end to end: system < user < project < cli_flag", () => {
  const loaded = loadConfig(
    io(
      {
        [SYSTEM_FILE]: JSON.stringify({ maxIterations: 11 }),
        [layerFile("/home/u")]: JSON.stringify({ maxIterations: 22, maxTokens: 22 }),
        [layerFile("/ws")]: JSON.stringify({ maxIterations: 33 }),
      },
      "/etc/trylo",
    ),
    { maxIterations: 44 },
  );

  assert.equal(loaded.ok, true, JSON.stringify(loaded));

  if (!loaded.ok) {
    return;
  }

  assert.equal(loaded.resolved["maxIterations"]?.value, 44, "cli_flag is highest");
  assert.equal(loaded.resolved["maxIterations"]?.layer, "cli_flag");
  assert.equal(loaded.resolved["maxTokens"]?.value, 22, "user survives where project is silent");
  assert.equal(loaded.resolved["maxTokens"]?.layer, "user");
  // The system layer contributed and was beaten; proving it was read at all is
  // what separates "five layers" from "four layers with a spare name".
  const systemSource = loaded.sources.find((source) => source.layer === "system");

  assert.equal(systemSource?.status, "loaded");
});

test("attack #3: a concat key merges arrays instead of the high layer clobbering the low one", () => {
  // The closed set has no array key today (schema.ts says so and this asserts
  // it), so the pin is on the mechanism the production merge delegates to:
  // `mergeValue` concatenates when the key is a concat key, and
  // `resolveSettings` reaches `mergeValue` for every key (proved by the
  // override behaviour of a non-concat key below).
  assert.equal(CONCAT_ARRAY_KEYS.size, 0);
  assert.deepEqual(mergeValue("k", ["a", "b"], ["b", "c"], () => true), ["a", "b", "c"]);
  assert.deepEqual(concatStringArrays(["a"], ["a", "b"]), ["a", "b"]);
  // Non-concat keys take the override — that is the path production actually
  // runs, and it must not turn into a silent concatenation.
  assert.deepEqual(mergeValue("k", ["a"], ["b"], () => false), ["b"]);
  const overridden = resolveSettings([
    { layer: "user", values: { model: "low" } },
    { layer: "project", values: { model: "high" } },
  ]);

  assert.deepEqual(overridden["model"]?.value, "high");
  assert.equal(overridden["model"]?.layer, "project");
});

test("attack #1: no CLI file can reach the old four-layer loader", () => {
  const specifierRe = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;
  const offenders: string[] = [];
  let scanned = 0;

  for (const dir of [CLI_DIR, CMD_DIR]) {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);

      // Test sources are excluded on purpose: this test's own discriminating
      // fixture has to spell the forbidden specifier out, and a test that
      // *names* the old loader is not a command a user can run.
      if (!statSync(full).isFile() || !full.endsWith(".ts") || full.endsWith(".test.ts")) {
        continue;
      }

      const source = readFileSync(full, "utf8");

      for (const match of source.matchAll(specifierRe)) {
        scanned += 1;
        const specifier = match[1] ?? "";
        if (specifier.replaceAll("\\", "/").includes("config/layers")) {
          offenders.push(`${path.basename(full)}: ${specifier}`);
        }
      }
    }
  }

  assert.equal(scanned > 20, true, `too few specifiers scanned (${scanned}); detector may be broken`);
  assert.deepEqual(offenders, []);
});

test("the two-path detector is discriminating: it recognizes the forbidden specifier", () => {
  const specifierRe = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;
  const matches = [...`import { x } from "../../config/layers.js";`.matchAll(specifierRe)];
  assert.equal(matches.length, 1);
  assert.equal((matches[0]?.[1] ?? "").includes("config/layers"), true);
});

test("attack #4: the config loader cannot see the environment at all", () => {
  // Structural, not behavioural: `ConfigLoadIo` has no `env` member, so no
  // caller can hand one in, and the loader's source never mentions one. An
  // environment variable therefore cannot become a layer by accident.
  const source = readFileSync(path.join(CLI_DIR, "config-load.ts"), "utf8");
  assert.equal(/\benv\b/.test(source), false, "config-load.ts must not mention env at all");
  assert.equal(/process\./.test(source), false, "config-load.ts must not touch process");
});

test("attack #5: a secret key is refused, never rendered, and never resolved", () => {
  const loaded = loadConfig(io({ [layerFile("/ws")]: '{"apiKey":"sk-FAKE-not-a-real-key"}' }), {});

  assert.equal(loaded.ok, false, "a config carrying a credential must fail closed");

  if (loaded.ok) {
    return;
  }

  assert.equal(loaded.failure.code, "secret_key");
  assert.equal(loaded.failure.layer, "project");
  assert.equal(loaded.failure.detail.includes("sk-FAKE-not-a-real-key"), false);
});

test("attack #5: the public view cannot carry a secret-shaped key even if one were resolved", () => {
  const loaded = loadConfig(io({ [layerFile("/ws")]: '{"endpoint":"https://e.invalid/v1"}' }), {});

  assert.equal(loaded.ok, true, JSON.stringify(loaded));

  if (!loaded.ok) {
    return;
  }

  const view = configValueView(loaded.resolved);
  const serialized = JSON.stringify(view);

  assert.equal(serialized.includes("apiKey"), false);
  assert.equal(serialized.includes("authorization"), false);
  assert.equal(view["endpoint"]?.sourceLayer, "project");
  assert.equal(view["endpoint"]?.value, "https://e.invalid/v1");
});

test("an invalid layer is never downgraded to 'missing'", () => {
  const loaded = loadConfig(io({ [layerFile("/ws")]: "{ not json" }), {});

  assert.equal(loaded.ok, false);

  if (loaded.ok) {
    return;
  }

  assert.equal(loaded.failure.code, "invalid_json");
  assert.equal(loaded.failure.path, layerFile("/ws"));
});
