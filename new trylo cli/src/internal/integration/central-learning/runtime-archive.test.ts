import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createRewardV2BoardPort } from "../reward/v2-board-port.js";
import type { CentralLearningRuntimeState, CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import { buildCentralRuntimeRecord } from "../../learning/central/runtime/records.js";
import { CENTRAL_RUNTIME_LIMITS, isCentralLearningRuntimeState, isCentralRuntimeMaterial } from "../../learning/central/runtime/validation.js";
import { archiveCentralRuntimeMaterials } from "./runtime-archive.js";
import { createCentralRuntimeStore, type CentralRuntimeAppend } from "./runtime-store.js";

const scope = "scope:runtime-archive";

async function directory(t: TestContext) {
  const base = testScratchPath("central-runtime-archive-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-"));
  assert.ok(!path.relative(base, root).startsWith(".."));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const material = (ref: string, size: number): CentralRuntimeMaterial => ({
  ref, kind: "source", text: "x".repeat(size), sourceRefs: ["source:original-owner"],
});
const changed = (value: CentralRuntimeMaterial): CentralRuntimeMaterial => ({ ...value, text: `y${value.text.slice(1)}` });

test("whole-body archive crosses original capacity, preserves committed prefixes and refuses live or cold identity conflicts", async t => {
  const boardRoot = await directory(t), store = createCentralRuntimeStore({ boardRoot, enabled: () => true });
  const before = await store.read(scope);
  const bodies = Array.from({ length: 5 }, (_, index) => material(`source:whole-${index}`, CENTRAL_RUNTIME_LIMITS.textChars));

  assert.ok(bodies.every(isCentralRuntimeMaterial));
  const archived = await archiveCentralRuntimeMaterials(store, before, bodies);

  assert.equal(archived.status, "archived");
  if (archived.status !== "archived") return;

  assert.ok(archived.cursor.revision >= before.revision + 2, "valid whole bodies exceed one original checkpoint without imposing a batch size");
  const originals = await store.lookupMany(scope, bodies.map(row => ({ kind: "material" as const, ref: row.ref })));

  for (const [index, found] of originals.entries()) {
    assert.equal(found.status, "found");
    if (found.status === "found") assert.deepEqual(found.value, bodies[index]);
  }

  const live = bodies.at(-1)!;

  assert.ok(archived.cursor.state.materials.some(row => row.ref === live.ref));
  await assert.rejects(archiveCentralRuntimeMaterials(store, archived.cursor, [changed(live)]), /material_identity_conflict/);
  await assert.rejects(archiveCentralRuntimeMaterials(store, archived.cursor, [live, changed(live)]), /material_identity_conflict/);
  const compacted = await store.append({ expectedRevision: archived.cursor.revision, previousRef: archived.cursor.stateRef,
    state: { ...archived.cursor.state, materials: [] }, reason: "Keep original bodies in exact archival history", sourceRefs: [] });

  assert.equal(compacted.status, "written");
  const cold = await store.read(scope);
  assert.equal(cold.state.materials.length, 0);
  await assert.rejects(archiveCentralRuntimeMaterials(store, cold, [changed(bodies[0]!)]), /material_identity_conflict/);
  const duplicate = material("source:uncommitted-duplicate", 32);

  await assert.rejects(archiveCentralRuntimeMaterials(store, cold, [duplicate, changed(duplicate)]), /material_identity_conflict/);
  assert.equal((await store.read(scope)).stateRef, cold.stateRef, "conflicting input cannot be hidden by deduplication or append a replacement");

  const heldRoot = await directory(t), heldStore = createCentralRuntimeStore({ boardRoot: heldRoot, enabled: () => true });
  const empty = await heldStore.read(scope), protectedBodies = Array.from({ length: 4 }, (_, index) => material(`source:wait-${index}`, 30000));
  const protectedState: CentralLearningRuntimeState = { ...empty.state, materials: protectedBodies, intents: [{
    intentId: "intent:waiting", subject: { plane: "agent", domain: "prompt", issueId: "issue:waiting" },
    goal: "Retain the original unresolved condition", rationale: "The actual owner evidence is still needed", conditions: [], knowledge: [],
    residual: ["Original owner confirmation"], commitment: { purpose: "Wait for actual evidence", assumptions: [], reconsiderWhen: [] },
    revisionReason: "Retain the original active wait", sourceRefs: [],
    continuation: { kind: "waiting", wait: { kind: "facts", reason: "Original evidence remains necessary", sourceRefs: protectedBodies.map(row => row.ref) } },
  }] };

  assert.ok(isCentralLearningRuntimeState(protectedState));
  assert.equal((await heldStore.append({ expectedRevision: empty.revision, previousRef: empty.stateRef, state: protectedState,
    reason: "Original active wait protects these whole bodies", sourceRefs: protectedBodies.map(row => row.ref) })).status, "written");
  const held = await heldStore.read(scope), prefix = material("source:committed-prefix", 1024), tooLarge = material("source:whole-no-fit", CENTRAL_RUNTIME_LIMITS.textChars);

  assert.ok(isCentralRuntimeMaterial(tooLarge));
  assert.ok(JSON.stringify({ ...held.state, materials: [...held.state.materials, prefix, tooLarge] }).length > CENTRAL_RUNTIME_LIMITS.jsonChars);
  const capacity = await archiveCentralRuntimeMaterials(heldStore, held, [prefix, tooLarge]);

  assert.equal(capacity.status, "archived");
  if (capacity.status !== "archived") return;

  assert.notEqual(capacity.cursor.stateRef, held.stateRef);
  assert.deepEqual(capacity.cursor.state.intents, held.state.intents);
  assert.deepEqual(capacity.cursor.state.consumedSourceRefs, held.state.consumedSourceRefs);
  const savedPrefix = await heldStore.lookup(scope, { kind: "material", ref: prefix.ref });

  assert.equal(savedPrefix.status, "found");
  if (savedPrefix.status === "found") assert.deepEqual(savedPrefix.value, prefix);

  const separate = capacity.cursor.history.materials.find(row => row.ref === tooLarge.ref);

  assert.ok(separate?.factRef.startsWith("central-runtime-material:"));
  assert.equal(capacity.cursor.state.materials.some(row => row.ref === tooLarge.ref), false,
    "archival does not require an unrelated original body to occupy the active purpose's working memory");
  const savedWhole = await heldStore.lookup(scope, { kind: "material", ref: tooLarge.ref, factRef: separate!.factRef });

  assert.equal(savedWhole.status, "found");
  if (savedWhole.status === "found") assert.deepEqual(savedWhole.value, tooLarge);

  const archiveHead = capacity.cursor.stateRef;

  await assert.rejects(archiveCentralRuntimeMaterials(heldStore, capacity.cursor, [changed(tooLarge)]), /material_identity_conflict/);
  assert.equal((await heldStore.read(scope)).stateRef, archiveHead, "a source identity conflict cannot replace the active semantic head");

  const beforeView = await heldStore.read(scope), deliveredView = material("source:actual-delivered-page", 1024);
  const viewArchive = await archiveCentralRuntimeMaterials(heldStore, beforeView, [deliveredView], "independent");
  assert.equal(viewArchive.status, "archived");if (viewArchive.status !== "archived") return;
  assert.equal(viewArchive.cursor.stateRef, beforeView.stateRef, "freezing an actual input page never advances the semantic head");
  assert.deepEqual(viewArchive.cursor.state, beforeView.state, "original input storage supplies no delivery, interpretation or outcome credit");
  const view = await heldStore.lookup(scope, { kind: "material", ref: deliveredView.ref });
  assert.equal(view.status, "found");if (view.status === "found") assert.deepEqual(view.value, deliveredView);
});

test("whole-body archive preserves competing heads and never repeats an unconfirmed append", async t => {
  const boardRoot = await directory(t), store = createCentralRuntimeStore({ boardRoot, enabled: () => true });
  const board = createRewardV2BoardPort(boardRoot, () => true), before = await store.read(scope), attempts: CentralRuntimeAppend[] = [];
  let insertUnrelated = true;
  const racing = { lookupMany: store.lookupMany, async read(requestedScope: string) {
    const current = await store.read(requestedScope);

    if (insertUnrelated) {
      insertUnrelated = false;
      assert.equal((await board.append(current.revision, { id: "unrelated:archive-race", scope: "scope:unrelated",
        algorithmVersion: "original-unrelated-fact-v1", kind: "projection", payloadJson: "{}" })).status, "written");
    }

    return current;
  }, async append(input: CentralRuntimeAppend) {
    attempts.push(input);
    return store.append(input);
  } };
  const rebased = await archiveCentralRuntimeMaterials(racing, before, [material("source:rebased", 32)]);

  assert.equal(rebased.status, "archived");
  if (rebased.status !== "archived") return;

  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map(row => row.expectedRevision), [before.revision, before.revision + 1]);
  const facts = attempts.map(({ expectedRevision: _revision, ...record }) => buildCentralRuntimeRecord(record));

  assert.deepEqual(facts[0], facts[1], "physical CAS rebasing preserves the original whole payload, predecessor and command identity");

  let headAppends = 0;
  const alreadyArchived = await archiveCentralRuntimeMaterials({ read: store.read, lookupMany: store.lookupMany,

    async append(input) {
      if (++headAppends === 1) assert.equal((await store.append(input)).status, "written");
      return store.append(input);
    },
  }, rebased.cursor, [material("source:winning-head", 32)]);

  assert.equal(alreadyArchived.status, "archived");
  assert.equal(headAppends, 1, "an identical checkpoint winning elsewhere is a new canonical head, not permission to resubmit");

  const postBefore = await store.read(scope);
  const postBodies = Array.from({ length: 5 }, (_, index) => material(`source:post-write-${index}`, CENTRAL_RUNTIME_LIMITS.textChars));
  let postAppends = 0, rivalRef: string | undefined;
  const alongsideRival = await archiveCentralRuntimeMaterials({ lookupMany: store.lookupMany,

    async read(requestedScope) {
      const current = await store.read(requestedScope);

      if (postAppends === 1 && rivalRef === undefined) {
        const rival = await store.append({ expectedRevision: current.revision, previousRef: current.stateRef,
          state: { ...current.state, consumedSourceRefs: [...current.state.consumedSourceRefs, "source:rival-head"] },
          reason: "Another canonical head wins before the first batch acknowledgement read", sourceRefs: [] });
        assert.equal(rival.status, "written");
        if (rival.status === "written") rivalRef = rival.stateRef;
        return store.read(requestedScope);
      }

      return current;
    },

    async append(input) {
      postAppends += 1;
      return store.append(input);
    },
  }, postBefore, postBodies);

  assert.equal(alongsideRival.status, "archived");
  assert.ok(postAppends > 1);
  assert.ok(rivalRef);
  assert.ok((await store.read(scope)).state.consumedSourceRefs.includes("source:rival-head"), "archiving cannot overwrite the rival transition");
  assert.equal((await store.lookup(scope, { kind: "material", ref: postBodies.at(-1)!.ref })).status, "found");

  const committed = await store.read(scope), lost = material("source:acknowledgement-lost", 32), unknown = new Error("original_archive_acknowledgement_lost");
  let unknownReads = 0, unknownAppends = 0, readsAtLoss = -1;

  await assert.rejects(archiveCentralRuntimeMaterials({ lookupMany: store.lookupMany,

    async read(requestedScope) {
      unknownReads += 1;
      return store.read(requestedScope);
    },

    async append(input) {
      unknownAppends += 1;
      assert.equal((await store.append(input)).status, "written");
      readsAtLoss = unknownReads;
      throw unknown;
    },
  }, committed, [lost]), error => error === unknown);
  assert.equal(unknownAppends, 1);
  assert.equal(unknownReads, readsAtLoss, "unknown acknowledgement causes no recovery read or automatic retry");
  const original = await store.lookup(scope, { kind: "material", ref: lost.ref });

  assert.equal(original.status, "found");
  if (original.status === "found") assert.deepEqual(original.value, lost);
});
