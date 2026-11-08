import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { EMPTY_PROFILE } from "./profile.js";

const srcRoot = join(process.cwd(), "src");

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTs(full, acc);
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

function productionDefs(pattern: RegExp): string[] {
  const hits: string[] = [];

  for (const file of walkTs(srcRoot)) {
    const text = readFileSync(file, "utf8");
    if (pattern.test(text)) {
      hits.push(relative(srcRoot, file).replaceAll("\\", "/"));
    }
  }

  return hits.sort();
}

test("Envelope production type has a single owner", () => {
  assert.deepEqual(productionDefs(/export type Envelope =/), ["internal/protocol/envelope.ts"]);
});

test("Fragment production type is not owned by contract", () => {
  const hits = productionDefs(/export type Fragment =/);
  assert.equal(hits.some((hit) => hit.startsWith("internal/contract/")), false);
  assert.deepEqual(hits, ["internal/knowledge/fragment.ts"]);
});

test("ExecutionState production type has a single owner", () => {
  assert.deepEqual(productionDefs(/export type ExecutionState =/), [
    "internal/domain/state.ts",
  ]);
});

test("EVENT_KINDS production const has a single owner", () => {
  assert.deepEqual(productionDefs(/export const EVENT_KINDS =/), [
    "internal/protocol/kinds.ts",
  ]);
});

test("execution profile snapshot has no permission fields", () => {
  assert.equal("permission" in EMPTY_PROFILE, false);
  assert.equal("allowNetwork" in EMPTY_PROFILE, false);
  assert.equal("skipApproval" in EMPTY_PROFILE, false);
});
