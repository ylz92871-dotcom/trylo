import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const SRC = path.join(process.cwd(), "src", "internal");
const FORBIDDEN = ["loop", "domain", "permission", "provider", "tools"];

test("learning control/profile/journal/knowledge/store do not import execution or permission implementations", async () => {
  const roots = [
    path.join(SRC, "learning"),
    path.join(SRC, "journal"),
    path.join(SRC, "knowledge"),
    path.join(SRC, "adapters", "learning-store"),
  ];
  const offenders: string[] = [];

  for (const root of roots) {
    for (const file of await listTs(root)) {
      if (file.endsWith(".test.ts")) {
        continue;
      }

      const source = await readFile(file, "utf8");

      for (const layer of FORBIDDEN) {
        if (importsLayer(source, layer)) {
          offenders.push(`${path.relative(SRC, file)} -> ${layer}`);
        }
      }
    }
  }

  assert.deepEqual(offenders, []);
});

function importsLayer(source: string, layer: string): boolean {
  const pattern = new RegExp(
    String.raw`from\s+["'][^"']*/(?:ports/)?${layer}(?:\.js|/[^"']*)?["']`,
  );
  return pattern.test(source);
}

async function listTs(target: string): Promise<string[]> {
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
    return target.endsWith(".ts") ? [target] : [];
  }

  const entries = await readdir(target, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTs(full)));
    } else if (entry.name.endsWith(".ts")) {
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
