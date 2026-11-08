import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isRuntimeWake, type CentralRuntimeWake } from "./contracts.js";
import { readRuntimeIntent, runtimeScopePaths, tryAcquireRuntimeOwner, type RuntimeIntent } from "./files.js";
import { createCentralScopeOwner } from "./owner.js";

const tick = async () => { await new Promise<void>(resolve => setImmediate(resolve)); };

function initial(workspaceRoot = path.resolve("WorkspaceRoot")): RuntimeIntent {
  return { schemaVersion: 1, homeRoot: path.resolve("Profile"), workspaceRoot, enabled: true, configuration: {
    configurationRef: "original-semantic-configuration", rootRef: { budgetId: "original-root", authorizationRef: "original-authorization" } },
    wakeSequence: 0, consumedSequence: 0, wakeReason: "initial", sourceRefs: [] };
}

function caseVariants(root: string, count: number): readonly string[] {
  // Synthetic lexical variants exercise parent metadata capacity; they assert no filesystem proof.
  return Array.from({ length: count }, (_, mask) => {
    let index = 0;
    return root.replace(/[a-z]/giu, character => index < 6
      ? ((mask & (1 << index++)) === 0 ? character.toLowerCase() : character.toUpperCase()) : character);
  });
}

test("wake workspace hints require bounded canonical absolute paths while old wake shape remains compatible", () => {
  const root = path.resolve("WorkspaceRoot"), wake = { reason: "original_source", sourceRefs: ["journal:original"] };

  assert.equal(isRuntimeWake(wake), true);
  assert.equal(isRuntimeWake({ ...wake, sourceWorkspaceRoots: [root] }), true);
  assert.equal(isRuntimeWake({ ...wake, sourceWorkspaceRoots: [] }), true);
  const accessor: string[] = [];
  Object.defineProperty(accessor, "0", { enumerable: true, get: () => root });
  const extra = Object.assign([root], { unexpected: root });

  for (const sourceWorkspaceRoots of [undefined, null, "root", ["relative"], [`${root}${path.sep}.`], [""], [1],
    [root.replace(/.$/u, "\0")], new Array(1), accessor, extra, Array.from({ length: 33 }, () => root)]) {
    assert.equal(isRuntimeWake({ ...wake, sourceWorkspaceRoots }), false);
  }
});

test("old intent roundtrips unchanged and optional workspace hints remain closed, canonical and scope-bound", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-runtime-source-roots-")), paths = runtimeScopePaths(root, path.join(root, "WorkspaceRoot"));
  const acquired = tryAcquireRuntimeOwner(paths);
  assert.ok(acquired.ok);
  const old = { ...initial(paths.workspaceRoot), homeRoot: paths.homeRoot };

  try {
    assert.ok(acquired.value.writeIntent(old).ok);
    assert.deepEqual(readRuntimeIntent(paths), { ok: true, value: old });
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(paths.intentPath, "utf8")), "sourceWorkspaceRoots"), false);
    const roots = path.sep === "\\" ? [paths.workspaceRoot, paths.workspaceRoot.toLowerCase()] : [paths.workspaceRoot];
    const extended = { ...old, sourceWorkspaceRoots: roots };

    assert.ok(acquired.value.writeIntent(extended).ok);
    assert.deepEqual(readRuntimeIntent(paths), { ok: true, value: extended });
    const bytes = readFileSync(paths.intentPath, "utf8");

    for (const value of [{ ...extended, unexpected: true }, { ...extended, sourceWorkspaceRoots: undefined },
      { ...extended, sourceWorkspaceRoots: ["relative"] }, { ...extended, sourceWorkspaceRoots: [path.join(root, "ForeignWorkspace")] },
      { ...extended, sourceWorkspaceRoots: new Array(1) }, { ...extended, sourceWorkspaceRoots: Array.from({ length: 33 }, () => paths.workspaceRoot) }]) {
      assert.equal(acquired.value.writeIntent(value).ok, false);
      assert.equal(readFileSync(paths.intentPath, "utf8"), bytes);
    }
  } finally {
    acquired.value.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("trylo-runtime-source-roots-"));
    rmSync(root, { recursive: true, force: true });
  }
});

test("a live owner retains every exact alias hint without cancelling work or reconfiguring and cold recovery forwards all roots", { skip: path.sep !== "\\" }, async () => {
  const scope = runtimeScopePaths("D:\\Profile", "D:\\WorkspaceRoot"), roots = caseVariants(scope.workspaceRoot, 32);
  let saved: RuntimeIntent = { ...initial(scope.workspaceRoot), homeRoot: scope.homeRoot, sourceWorkspaceRoots: roots.slice(0, 12) };
  const configuration = saved.configuration, received: CentralRuntimeWake[] = [];
  let release!: () => void, firstSignal: AbortSignal | undefined;
  const running = new Promise<void>(resolve => { release = resolve; });
  const owner = createCentralScopeOwner({ scope, ownerId: "active-hint-owner", intent: saved,
    store: { owns: () => true, writeIntent(value) {
      saved = value as RuntimeIntent;
      return { ok: true };
    } },
    driver: { async drive(input) {
      received.push(structuredClone(input.wake));
      if (received.length === 1) {
        firstSignal = input.signal;
        await running;
      }
      return { state: "waiting" };
    } } });

  try {
    assert.ok(owner.wake({ reason: "original_source", sourceRefs: ["source:original"] }).ok);
    await tick();
    assert.deepEqual(received[0]!.sourceWorkspaceRoots, roots.slice(0, 12));
    assert.ok(owner.wake({ reason: "new_alias_source", sourceRefs: ["source:alias"], sourceWorkspaceRoots: roots.slice(10, 24) }).ok);
    assert.equal(firstSignal?.aborted, false);
    assert.equal(received.length, 1);
    assert.deepEqual(saved.sourceWorkspaceRoots, roots.slice(0, 24));
    assert.equal(saved.configuration, configuration);
    assert.equal(saved.workspaceRoot, scope.workspaceRoot);
    assert.equal(saved.enabled, true);
    release();
    await tick();
    assert.deepEqual(received[1]!.sourceWorkspaceRoots, roots.slice(0, 24));
    assert.deepEqual(received[0]!.sourceWorkspaceRoots, roots.slice(0, 12), "an in-flight input is never mutated by later hints");
    assert.deepEqual(received[1]!.sourceRefs, ["source:alias"]);
  } finally {
    release();
    await owner.close("restart");
  }

  const recovered: CentralRuntimeWake[] = [];
  const cold = createCentralScopeOwner({ scope, ownerId: "cold-hint-owner", intent: saved,
    store: { owns: () => true, writeIntent(value) {
      saved = value as RuntimeIntent;
      return { ok: true };
    } },
    driver: { async drive(input) {
      recovered.push(input.wake);
      return { state: "waiting" };
    } } });

  cold.start();
  await tick();
  assert.deepEqual(recovered[0]!.sourceWorkspaceRoots, roots.slice(0, 24));
  await cold.close("stop");
  assert.equal(saved.enabled, false);
  assert.deepEqual(saved.sourceWorkspaceRoots, roots.slice(0, 24));
  assert.deepEqual(saved.configuration, configuration);
});

test("a foreign folded workspace hint rejects its entire wake without touching durable acceptance", async () => {
  const scope = runtimeScopePaths(path.resolve("Profile"), path.resolve("WorkspaceRoot"));
  let saved = { ...initial(scope.workspaceRoot), homeRoot: scope.homeRoot }, writes = 0;
  const owner = createCentralScopeOwner({ scope, ownerId: "foreign-hint-owner", intent: saved,
    store: { owns: () => true, writeIntent(value) {
      writes++;
      saved = value as RuntimeIntent;
      return { ok: true };
    } },
    driver: { async drive() { return { state: "waiting" }; } } });
  const before = owner.snapshot(), original = saved;

  assert.deepEqual(owner.wake({ reason: "foreign_source", sourceRefs: ["source:foreign"], sourceWorkspaceRoots: [path.resolve("ForeignWorkspace")] }),
    { ok: false, reason: "runtime_scope_mismatch" });
  assert.equal(saved, original);
  assert.equal(writes, 0);
  assert.deepEqual(owner.snapshot(), before);
  await owner.close("restart");
});

test("workspace-hint union refuses overflow atomically and never truncates older aliases", { skip: path.sep !== "\\" }, async () => {
  const scope = runtimeScopePaths("D:\\Profile", "D:\\WorkspaceRoot"), roots = caseVariants(scope.workspaceRoot, 64);
  let saved: RuntimeIntent = { ...initial(scope.workspaceRoot), homeRoot: scope.homeRoot, sourceWorkspaceRoots: roots.slice(0, 32) }, writes = 0;
  const owner = createCentralScopeOwner({ scope, ownerId: "capacity-hint-owner", intent: saved,
    store: { owns: () => true, writeIntent(value) {
      writes++;
      saved = value as RuntimeIntent;
      return { ok: true };
    } },
    driver: { async drive() { return { state: "waiting" }; } } });
  const before = owner.snapshot(), original = saved;

  assert.deepEqual(owner.wake({ reason: "one_alias_too_many", sourceRefs: ["source:overflow"], sourceWorkspaceRoots: [roots[32]!] }),
    { ok: false, reason: "runtime_source_workspace_roots_capacity" });
  assert.equal(saved, original);
  assert.equal(writes, 0);
  assert.deepEqual(owner.snapshot(), before);
  assert.ok(owner.wake({ reason: "duplicate_alias", sourceRefs: [], sourceWorkspaceRoots: [roots[0]!, roots[0]!] }).ok);
  assert.deepEqual(saved.sourceWorkspaceRoots, roots.slice(0, 32));
  await tick();
  await owner.close("restart");
});
