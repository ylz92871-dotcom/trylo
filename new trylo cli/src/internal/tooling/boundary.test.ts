import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const owned = [
  join(repoRoot, "src", "internal", "tooling"),
  join(repoRoot, "src", "internal", "learning", "domains", "tool"),
  join(repoRoot, "src", "internal", "learning", "agent", "subsystems", "tool", "domain"),
  join(repoRoot, "src", "internal", "learning", "agent", "subsystems", "tool", "assets"),
  join(repoRoot, "src", "internal", "learning", "agent", "subsystems", "tool", "adapters", "events"),
  join(repoRoot, "src", "internal", "learning", "agent", "subsystems", "tool", "adapters", "quarantine"),
  join(repoRoot, "src", "internal", "learning", "agent", "subsystems", "tool", "adapters", "acquisition", "discovery-index.ts"),
];
const forbidden = ["internal/loop", "internal/domain", "internal/protocol", "internal/ports/permission"];

async function filesOf(root: string): Promise<string[]> {
  if ((await stat(root)).isFile()) return [root];

  const out: string[] = [];
  const pending = [root];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }

    const entries = await readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        out.push(full);
      }
    }
  }

  return out;
}

async function testFiles(root: string, suffix: string): Promise<string[]> {
  const out: string[] = [];
  const pending = [root];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }

    const entries = await readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        out.push(relative(repoRoot, full).replaceAll("\\", "/"));
      }
    }
  }

  return out;
}

test("dist tests cannot outlive deleted source tests", async () => {
  const srcTests = (await testFiles(join(repoRoot, "src"), ".test.ts"))
    .map((file) => file.replace(/^src\//, "").replace(/\.test\.ts$/, ""));
  const distTests = (await testFiles(join(repoRoot, "dist"), ".test.js"))
    .map((file) => file.replace(/^dist\//, "").replace(/\.test\.js$/, ""));
  const srcSet = new Set(srcTests);
  const orphans = distTests.filter((file) => !srcSet.has(file));

  assert.deepEqual(orphans, []);
});

test("WP-D production code does not import Loop Domain Protocol or Permission Service", async () => {
  const hits: string[] = [];

  for (const root of owned) {
    for (const file of await filesOf(root)) {
      const source = await readFile(file, "utf8");
      for (const layer of forbidden) {
        if (source.includes(layer)) {
          hits.push(`${relative(repoRoot, file)} mentions ${layer}`);
        }
      }
    }
  }

  assert.deepEqual(hits, []);
});
