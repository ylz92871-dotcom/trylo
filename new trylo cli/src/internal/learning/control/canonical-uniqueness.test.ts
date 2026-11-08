import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const NAMES = [
  "LearningObservation",
  "LearningProposal",
  "EvidenceBundle",
  "LearningAssetVersion",
  "ActivationRecord",
  "ApprovalRequest",
  "ExecutionProfileSnapshot",
];

test("learning canonical types have a single production definition", async () => {
  const src = path.join(process.cwd(), "src", "internal");
  const files = await listTs(src);

  for (const name of NAMES) {
    const hits: string[] = [];
    const pattern = new RegExp(`export type ${name}\\s*=`);

    for (const file of files) {
      if (file.endsWith(".test.ts")) {
        continue;
      }

      const source = await readFile(file, "utf8");
      if (pattern.test(source)) {
        hits.push(path.relative(src, file));
      }
    }

    const allowed = path.normalize(
      name === "ExecutionProfileSnapshot"
        ? path.join("contract", "profile.ts")
        : path.join("learning", "control", "contracts.ts"),
    );

    assert.deepEqual(hits.map((item) => path.normalize(item)), [allowed], name);
  }
});

async function listTs(target: string): Promise<string[]> {
  const info = await stat(target);
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
