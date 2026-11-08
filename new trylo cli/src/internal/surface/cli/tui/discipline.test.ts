import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

/**
 * Contract #3, written the way `exec-substrate-discipline.test.ts` writes its
 * kind of contract: as a static scan, not as prose.
 *
 * The TUI is a surface over the one run host. It must never grow a second
 * loop, never call a provider or the tool port itself, never touch the
 * permission port, never build its own projection of envelopes, and — this
 * build's conservative line — never reach for `process` or raw-mode
 * switches. Scans run over stripped code so the bans themselves in comments
 * do not trip them.
 */

const tuiDir = path.join(process.cwd(), "src/internal/surface/cli/tui");

test("the TUI directory was actually scanned", async () => {
  const sources = await productionSources();
  assert.equal(
    sources.length >= 6,
    true,
    `only ${sources.length} production sources under tui/; the scan is running on the wrong directory`,
  );
});

test("no second loop, no direct provider or permission, no process access", async () => {
  const offenders: string[] = [];

  for (const file of await productionSources()) {
    const code = stripComments(await readFile(file, "utf8"));
    const rel = path.relative(process.cwd(), file).replaceAll("\\", "/");

    if (/from "[^"]*(\/loop\/|\/adapters\/|ports\/permission)/.test(code)) {
      offenders.push(`${rel}: imports outside the sanctioned run host`);
    }

    if (/\b(wirePorts|executeTurn|runTurn|createProjection|projectRun|setRawMode)\b/.test(code)) {
      offenders.push(`${rel}: builds its own loop or projection`);
    }

    if (/\bprocess\b/.test(code)) {
      offenders.push(`${rel}: reaches for process`);
    }
  }

  assert.deepEqual(offenders, []);
});

test("the non-TTY path is the line REPL itself, not a copy of it", async () => {
  const entry = await readFile(path.join(tuiDir, "entry.ts"), "utf8");
  // `handleRepl` takes an optional third argument — the `--learning` switch,
  // added by the method-subsystem activation package. What this assertion is
  // about is that the fallback *delegates*, not how many arguments it passes:
  // a reimplementation would not be identical by construction.
  assert.match(
    stripComments(entry),
    /return handleRepl\(ctx, sink(?:, \w+){0,2}\);/,
    "the non-TTY fallback must delegate to the real handleRepl so behavior is identical by construction",
  );
});

async function productionSources(): Promise<Array<string>> {
  const found: Array<string> = [];

  for (const entry of await readdir(tuiDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      found.push(path.join(tuiDir, entry.name));
    }
  }

  return found.sort();
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}
