import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

type ForbiddenHit = {
  specifier: string;
  layer: string;
};

const loopDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(loopDir, "..", "..", "..");
const srcInternal = join(repoRoot, "src", "internal");
const coreRoots = [
  join(srcInternal, "loop"),
  join(srcInternal, "domain"),
  join(srcInternal, "protocol"),
  join(srcInternal, "contract"),
];
const forbiddenLayers = new Set([
  "adapters",
  "knowledge",
  "desktop",
  "journal",
  "learning",
  "tooling",
]);
const forbiddenPackages = ["react", "openai", "@anthropic-ai/sdk"];

const specifierPattern =
  /(?:from\s+|import\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;

function importedSpecifiers(source: string): string[] {
  const specifiers: string[] = [];

  for (const match of source.matchAll(specifierPattern)) {
    const specifier = match[1];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }

  return specifiers;
}

function forbiddenImportsIn(source: string): ForbiddenHit[] {
  const hits: ForbiddenHit[] = [];

  for (const specifier of importedSpecifiers(source)) {
    const segments = specifier.replaceAll("\\", "/").split("/");

    for (const layer of segments) {
      if (forbiddenLayers.has(layer)) {
        hits.push({ specifier, layer });
      }
    }

    for (const pkg of forbiddenPackages) {
      if (specifier === pkg || specifier.startsWith(`${pkg}/`)) {
        hits.push({ specifier, layer: pkg });
      }
    }
  }

  return hits;
}

async function productionTsFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending: string[] = [root];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }

    const entries = await readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(current, entry.name);

      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }

      if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts")
      ) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

test("loop and domain must not import adapters or knowledge", async () => {
  const violations: string[] = [];

  for (const root of coreRoots) {
    for (const file of await productionTsFiles(root)) {
      const source = await readFile(file, "utf8");
      for (const hit of forbiddenImportsIn(source)) {
        violations.push(
          `${relative(repoRoot, file)} imports ${hit.layer} via ${hit.specifier}`,
        );
      }
    }
  }

  assert.deepEqual(violations, []);
});

test("detector fails when a loop file imports knowledge", async () => {
  const fixture = join(
    repoRoot,
    "testdata",
    "architecture",
    "forbidden-loop-import-knowledge.ts",
  );
  const hits = forbiddenImportsIn(await readFile(fixture, "utf8"));

  assert.equal(
    hits.some((hit) => hit.layer === "knowledge"),
    true,
    "testdata/architecture/forbidden-loop-import-knowledge.ts must be caught",
  );
});

test("detector fails when a loop file imports adapters", async () => {
  const fixture = join(
    repoRoot,
    "testdata",
    "architecture",
    "forbidden-loop-import-adapters.ts",
  );
  const hits = forbiddenImportsIn(await readFile(fixture, "utf8"));

  assert.equal(
    hits.some((hit) => hit.layer === "adapters"),
    true,
    "testdata/architecture/forbidden-loop-import-adapters.ts must be caught",
  );
});

test("detector fails when a loop file imports journal, learning, or tooling", async () => {
  const fixture = join(
    repoRoot,
    "testdata",
    "architecture",
    "forbidden-loop-import-journal.ts",
  );
  const hits = forbiddenImportsIn(await readFile(fixture, "utf8"));

  for (const layer of ["journal", "learning", "tooling"]) {
    assert.equal(
      hits.some((hit) => hit.layer === layer),
      true,
      `testdata/architecture/forbidden-loop-import-journal.ts must catch ${layer}`,
    );
  }
});

test("detector fails when a loop file imports provider SDK", async () => {
  const fixture = join(repoRoot, "testdata", "architecture", "forbidden-loop-import-sdk.ts");
  const hits = forbiddenImportsIn(await readFile(fixture, "utf8"));
  assert.equal(hits.some((hit) => hit.layer === "openai"), true);
  assert.equal(hits.some((hit) => hit.layer === "@anthropic-ai/sdk"), true);
});

test("detector fails when a loop file imports UI", async () => {
  const fixture = join(repoRoot, "testdata", "architecture", "forbidden-loop-import-ui.ts");
  const hits = forbiddenImportsIn(await readFile(fixture, "utf8"));
  assert.equal(hits.some((hit) => hit.layer === "react"), true);
  assert.equal(hits.some((hit) => hit.layer === "desktop"), true);
});

test("knowledge directory exists outside the loop", async () => {
  const info = await stat(join(srcInternal, "knowledge"));
  assert.equal(info.isDirectory(), true);
});
