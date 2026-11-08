import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ExpertConfiguration, ExpertLibrarySnapshot } from "../../subagent/experts/contracts.js";
import { ExpertLibraryError } from "../../subagent/experts/contracts.js";
import { releaseLock, tryAcquireLock } from "../learning-store/lock.js";
import { createFileExpertStore } from "./store.js";

const configuration: ExpertConfiguration = {
  displayName: "TypeScript reviewer", specialty: "TypeScript API review", situations: ["public API changes"],
  responsibilities: ["inspect compatibility"], constraints: ["do not modify files"], collaboration: ["report to parent"],
  baseRole: "reviewer", role: { name: "reviewer", description: "Review TypeScript API compatibility" },
  toolRefs: [], methods: [{ title: "Compatibility review", instructions: "Inspect exported signatures and their consumers.", sourceUris: ["https://www.typescriptlang.org/docs/"] }],
  sources: [{ kind: "official", title: "TypeScript docs", uri: "https://www.typescriptlang.org/docs/", excerpt: "Review exported types and consumers." }],
};
const empty = (): ExpertLibrarySnapshot => ({ schemaVersion: 1, sequence: 0, experts: [], requests: [] });
const saved = (): ExpertLibrarySnapshot => ({ schemaVersion: 1, sequence: 1, requests: [{
  requestId: "request-reviewer", expertId: "expert-reviewer", experienceKey: "expert:expert-reviewer", origin: "settings",
  instruction: "Create a TypeScript API compatibility reviewer", baseVersion: 0, state: "saved", revision: 1,
  createdAt: 1, configuration, userEdits: {}, creationAuthorization: "create-receipt", retentionAuthorization: "retain-receipt",
}], experts: [{
  expertId: "expert-reviewer", experienceKey: "expert:expert-reviewer", status: "active", versions: [{
    expertId: "expert-reviewer", experienceKey: "expert:expert-reviewer", version: 1, configuration, createdAt: 1, requestId: "request-reviewer",
  }],
}] });
const hasCode = (code: ExpertLibraryError["code"]) => (error: unknown): boolean => error instanceof ExpertLibraryError && error.code === code;

function inDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(path.join(os.tmpdir(), "trylo-expert-store-"));
  try { run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("expert store persists a validated snapshot and rejects a stale sequence", () => inDirectory(directory => {
  const first = createFileExpertStore(directory);

  assert.deepEqual(first.read(), empty());
  first.update(0, saved());
  const second = createFileExpertStore(directory);

  assert.deepEqual(second.read(), saved());
  assert.throws(() => second.update(0, { ...saved(), sequence: 2 }), hasCode("conflict"));
  assert.deepEqual(first.read(), saved());
}));

test("expert store cannot remove or rewrite a saved version", () => inDirectory(directory => {
  const store = createFileExpertStore(directory);

  store.update(0, saved());
  assert.throws(() => store.update(1, { ...empty(), sequence: 2 }), hasCode("conflict"));
  const prior = saved().experts[0]!;
  const changedConfiguration = { ...configuration, specialty: "silently changed" };
  const rewritten = { ...prior, versions: [{ ...prior.versions[0]!, configuration: changedConfiguration }] };
  const requests = saved().requests.map(request => ({ ...request, configuration: changedConfiguration }));

  assert.throws(() => store.update(1, { ...saved(), sequence: 2, requests, experts: [rewritten] }), hasCode("conflict"));
  assert.deepEqual(store.read(), saved());
}));

test("expert store preserves the old committed file when publication fails", () => inDirectory(directory => {
  const store = createFileExpertStore(directory);

  store.update(0, saved());
  const before = readFileSync(path.join(directory, "expert-library.v1.json"), "utf8");
  const interrupted = createFileExpertStore(directory, { onStage: stage => { if (stage === "before_publish") throw new Error("injected publication fault"); } });

  assert.throws(() => interrupted.update(1, { ...saved(), sequence: 2 }), hasCode("store_unavailable"));
  assert.equal(readFileSync(path.join(directory, "expert-library.v1.json"), "utf8"), before);
  assert.deepEqual(store.read(), saved());
}));

test("expert store fails closed on corrupt or unsupported persisted input", () => inDirectory(directory => {
  const file = path.join(directory, "expert-library.v1.json");
  const store = createFileExpertStore(directory);

  writeFileSync(file, "{broken");
  assert.throws(() => store.read(), hasCode("store_unavailable"));
  writeFileSync(file, JSON.stringify({ ...empty(), schemaVersion: 2 }));
  assert.throws(() => store.read(), hasCode("store_unavailable"));
  assert.throws(() => store.update(0, saved()), hasCode("store_unavailable"));
}));

test("expert store refuses a competing lock instead of overwriting", () => inDirectory(directory => {
  const lock = tryAcquireLock(path.join(directory, "expert-library.lock"));
  assert.equal("fd" in lock, true);
  if (!("fd" in lock)) throw new Error("test could not acquire real lock");
  try { assert.throws(() => createFileExpertStore(directory).update(0, saved()), hasCode("conflict")); }
  finally { releaseLock(lock); }
  assert.deepEqual(createFileExpertStore(directory).read(), empty());
}));
