import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const SRC_ROOT = path.join(process.cwd(), "src", "internal");

test("loop and permission must not import knowledge", async () => {
  const files = [
    ...(await listTsFiles(path.join(SRC_ROOT, "loop"))),
    ...(await listTsFiles(path.join(SRC_ROOT, "ports", "permission.ts"))),
  ];
  const offenders: string[] = [];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (importsKnowledge(source)) {
      offenders.push(path.relative(SRC_ROOT, file));
    }
  }

  assert.deepEqual(offenders, []);
});

function importsKnowledge(source: string): boolean {
  return /from\s+["'][^"']*knowledge[^"']*["']/.test(source);
}

async function listTsFiles(target: string): Promise<string[]> {
  let info;

  try {
    info = await stat(target);
  } catch (err) {
    if (isNotFound(err)) {
      return [];
    }
    throw err;
  }

  if (info.isFile()) {
    return target.endsWith(".ts") && !target.endsWith(".test.ts") ? [target] : [];
  }

  const entries = await readdir(target, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTsFiles(full)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }

  return files;
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}
