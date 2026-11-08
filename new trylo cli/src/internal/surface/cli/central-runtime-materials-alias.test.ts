import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { createMethodBoardWriter } from "../../learning/agent/subsystems/method/adapters/board-writer.js";
import type { MethodObservation } from "../../learning/agent/subsystems/method/domain/inference-observations.js";
import { projectOrganizationNativeFeedbackChanges } from "../../integration/central-learning/organization-feedback-changes.js";
import { projectOrganizationDomainFeedback } from "../../integration/central-learning/organization-feedback-sources.js";
import { readSessionContent, sessionContentAddress, sessionContentRecordRef, sessionTaskAddress } from "../../integration/learning-content/sources/session.js";
import { contentHashOf } from "../../learning/control/hash.js";
import { createCentralRuntimeMaterials } from "./central-runtime-materials.js";
import { resolveCentralRuntimeWorkspaceIdentity } from "./central-runtime-workspace-identity.js";
import type { CliContext } from "./context.js";
import { methodBoardRoot } from "./learning-sink.js";
import { sessionPath, sessionsDir } from "./session-paths.js";
import { workspaceIdentity } from "./workspace-identity.js";
import { centralLearningTaskSessions } from "./central-learning-sources.js";
import { createRuntimeSessionWorkspaceAccess } from "./central-runtime-materials-scope.js";
import { centralRuntimeSources } from "./central-runtime-sources.js";

const at = "2026-11-05T12:00:00.000Z", signal = new AbortController().signal;

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-runtime-source-alias-")), workspace = path.join(root, "MixedWorkspace");
  const foreign = path.join(root, "ForeignWorkspace"), home = path.join(root, "Profile");

  mkdirSync(workspace);
  mkdirSync(foreign);
  mkdirSync(home);
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("trylo-runtime-source-alias-"));
    rmSync(root, { recursive: true, force: true }); });
  const ctx: CliContext = { cwd: workspace, homeDir: root, env: { TRYLO_HOME: home }, nodeVersion: "test", stdinIsTty: false,
    readFile: file => existsSync(file) ? readFileSync(file, "utf8") : undefined, isDirectory: file => existsSync(file) && statSync(file).isDirectory(),
    realPath: file => { try { return realpathSync.native(file); } catch { return undefined; } },
    readDir: directory => existsSync(directory) ? readdirSync(directory).map(name => { const stat = statSync(path.join(directory, name));
      return { name, bytes: stat.size, modifiedAtMs: stat.mtimeMs }; }) : [],
    writeFile: () => false, readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined,
    stdout() {}, stderr() {}, now: () => Date.parse(at), newId: prefix => prefix };
  const journal = async (id: string, workspaceId: string, text: string, workspaceRoot?: string, poison = false, turnId = `turn-${id}`) => {
    const filename = sessionPath(ctx.homeDir, ctx.env, id), store = createNdjsonSessionStore({ path: filename });

    try {
      assert.ok((await store.start({ sessionId: id, createdAt: at, fingerprint: { schemaVersion: "1", workspaceId,
        providerId: "local", model: "source-contract", toolCatalogHash: "catalog", ...(workspaceRoot === undefined ? {} : { workspaceRoot }) } })).ok);
      assert.ok((await store.append({ type: "turn_start", sessionId: id, turnId, at, payload: {} })).ok);
      assert.ok((await store.append({ type: "turn_input", sessionId: id, turnId, at, payload: { text } })).ok);
    } finally { await store.release(); }

    if (poison) writeFileSync(filename, `${readFileSync(filename, "utf8").split("\n")[0]}\nFOREIGN_BODY_MUST_NOT_REACH_THE_ORIGINAL_DECODER\n`);

    return { id, filename, text, workspaceId, store: createNdjsonSessionStore({ path: filename }) };
  };

  return { root, workspace, foreign, home, ctx, journal };
}

test("two real Windows case callers read only witnessed legacy IDs or explicit same-physical journal roots without rewriting sources", { skip: path.sep !== "\\" }, async t => {
  const f = fixture(t), native = realpathSync.native(f.workspace), upper = native.toUpperCase(), lower = native.toLowerCase();
  const explicit = native.replace("MixedWorkspace", "mIxEdWoRkSpAcE");
  const primary = await f.journal("primary-case", workspaceIdentity(native), "PRIMARY_ORIGINAL_REQUIREMENT");
  const oldUpper = await f.journal("upper-case", workspaceIdentity(upper), "UPPER_CASE_ORIGINAL_REQUIREMENT");
  const oldLower = await f.journal("lower-case", workspaceIdentity(lower), "LOWER_CASE_ORIGINAL_REQUIREMENT");
  const rooted = await f.journal("explicit-root", workspaceIdentity(explicit), "EXPLICIT_ROOT_ORIGINAL_REQUIREMENT", explicit);
  const foreign = await f.journal("foreign-root", workspaceIdentity(f.foreign), "FOREIGN_PRIVATE_BODY", f.foreign, true);
  const unknown = await f.journal("unknown-rootless", "unwitnessed-old-hash", "UNKNOWN_PRIVATE_BODY", undefined, true);
  const mismatched = await f.journal("mismatched-root", "hash-does-not-match-explicit-root", "MISMATCHED_PRIVATE_BODY", explicit, true);
  const original = new Map([primary, oldUpper, oldLower, rooted, foreign, unknown, mismatched].map(row => [row.filename, readFileSync(row.filename)]));

  for (const [caller, known, unproven] of [[upper, oldUpper, oldLower], [lower, oldLower, oldUpper]] as const) {
    const identity = await resolveCentralRuntimeWorkspaceIdentity({ ...f.ctx, cwd: caller }, caller, { allowBudgetLookup: false });
    assert.ok(identity.ok);
    assert.equal(identity.value.compatibleWorkspaceIds.includes(rooted.workspaceId), false, "the explicit journal root supplies new evidence, never case enumeration");
    const ctx = { ...f.ctx, cwd: identity.value.workspaceRoot, workspaceIdentity: identity.value };
    const tasks = centralLearningTaskSessions(ctx, identity.value.workspaceId);

    assert.deepEqual(await tasks(`turn-${known.id}`, signal), [known.id]);
    assert.deepEqual(await tasks(`turn-${rooted.id}`, signal), [rooted.id]);
    const source = createCentralRuntimeMaterials({ ctx, workspaceId: identity.value.workspaceId, enabled: () => true });
    const snapshot = await source.snapshot(ctx.cwd, signal), serialized = JSON.stringify(snapshot.materials);

    for (const row of [primary, known, rooted]) assert.ok(serialized.includes(row.text), row.id);

    assert.equal(serialized.includes(unproven.text), false, "a rootless unknown hash is not guessed from filesystem casing");

    for (const row of [foreign, unknown, mismatched]) assert.equal(serialized.includes(row.text), false);

    for (const row of [known, rooted]) {
      const pages = await source.read(ctx.cwd, [sessionTaskAddress(`turn-${row.id}`)], 4096, signal), page = JSON.parse(pages[0]!.text);
      assert.equal(page.text, row.text);
      assert.equal(page.originalRef, sessionContentRecordRef(row.id, 2));
      assert.deepEqual(page.coordinate, { runId: row.id, sequence: 2 });
      assert.equal(page.sourceHash, contentHashOf(row.text));
    }

    await assert.rejects(source.read(ctx.cwd, [sessionContentAddress({ sessionId: foreign.id, journalSequence: 2 })], 4096, signal), /scope/u);
  }

  for (const [filename, bytes] of original) assert.deepEqual(readFileSync(filename), bytes, "alias reads never rewrite headers, IDs or journal bodies");

  assert.equal(existsSync(methodBoardRoot(f.ctx.homeDir, f.ctx.env)), false);
  assert.equal(readdirSync(sessionsDir(f.ctx.homeDir, f.ctx.env)).some(name => name.endsWith(".lock")), false);
});

test("the original session reader accepts only host-verified cross-task IDs and retains each source's original coverage", { skip: path.sep !== "\\" }, async t => {
  const f = fixture(t), native = realpathSync.native(f.workspace), caller = native.toLowerCase();
  const identity = await resolveCentralRuntimeWorkspaceIdentity({ ...f.ctx, cwd: caller }, caller, { allowBudgetLookup: false });
  assert.ok(identity.ok);
  const primary = await f.journal("reader-primary", workspaceIdentity(native), "Primary native requirement.");
  const alias = await f.journal("reader-alias", workspaceIdentity(caller), "Original alias task requirement.");
  const registry = new Map([[primary.id, primary.store], [alias.id, alias.store]]);
  const tasks = centralLearningTaskSessions({ ...f.ctx, workspaceIdentity: identity.value }, primary.workspaceId);
  const input = { session: primary.store, sessionId: primary.id, turnId: `turn-${primary.id}`, scope: native,
    subsystem: "collaboration" as const, enabled: () => true,
    lookupSession: async (id: string) => registry.get(id), lookupSessionsForTask: tasks };
  const exact = await readSessionContent(input, signal);
  assert.ok(exact.ok);
  const refused = await exact.value.source.readMaterial(sessionContentAddress({ sessionId: alias.id, journalSequence: 2 }), signal);

  assert.equal(refused.ok, false, "the old exact-ID boundary remains the default");
  const read = await readSessionContent({ ...input, compatibleWorkspaceIds: identity.value.compatibleWorkspaceIds }, signal);
  assert.ok(read.ok);
  assert.equal(read.value.coverage.workspaceId, primary.workspaceId);
  const page = await read.value.source.readMaterial(sessionTaskAddress(`turn-${alias.id}`), signal);
  assert.ok(page.ok);
  assert.equal(page.value.text, alias.text);
  assert.equal(page.value.sessionId, alias.id);
  assert.equal(page.value.journalSequence, 2);
  const recovered = await read.value.source.retrieve({ scope: native, domain: "collaboration", boardSequence: 0,
    issueIds: [], topicIds: [], artifactRefs: [], sourceRefs: [sessionTaskAddress(`turn-${alias.id}`)] }, signal);
  assert.ok(recovered.ok);
  assert.ok(recovered.value.materials.some(material => material.context.includes(`"workspaceId":"${alias.workspaceId}"`)));
  const original = await readSessionContent({ ...input, session: alias.store, sessionId: alias.id, turnId: `turn-${alias.id}` }, signal);
  assert.ok(original.ok);
  assert.equal(original.value.coverage.workspaceId, alias.workspaceId, "coverage is not relabeled to the primary workspace ID");
  const duplicate = await f.journal("reader-duplicate", alias.workspaceId, "A second original journal owns the same task ID.", undefined, false, `turn-${alias.id}`);

  registry.set(duplicate.id, duplicate.store);
  assert.deepEqual([...(await tasks(`turn-${alias.id}`, signal))].sort(), [alias.id, duplicate.id].sort());
  const ambiguous = await readSessionContent({ ...input, compatibleWorkspaceIds: identity.value.compatibleWorkspaceIds }, signal);
  assert.ok(ambiguous.ok);
  assert.equal((await ambiguous.value.source.readMaterial(sessionTaskAddress(`turn-${alias.id}`), signal)).ok, false,
    "verified physical aliases do not choose between two original journals with the same exact task ID");
});

test("explicit roots never gain access from a known or previously admitted native ID", { skip: path.sep !== "\\" }, async t => {
  const f = fixture(t), native = realpathSync.native(f.workspace), caller = native.toLowerCase();
  const identity = await resolveCentralRuntimeWorkspaceIdentity({ ...f.ctx, cwd: caller }, caller, { allowBudgetLookup: false });
  assert.ok(identity.ok);
  const ctx = { ...f.ctx, cwd: identity.value.workspaceRoot, workspaceIdentity: identity.value };
  const primary = await f.journal("consistent-root", identity.value.workspaceId, "CONSISTENT_EXPLICIT_ROOT_REQUIREMENT", native);

  await f.journal("conflicting-known-root", primary.workspaceId, "CONFLICTING_KNOWN_ID_PRIVATE_BODY", f.foreign, true);
  const source = createCentralRuntimeMaterials({ ctx, workspaceId: primary.workspaceId, enabled: () => true });
  const snapshot = await source.snapshot(ctx.cwd, signal);
  assert.ok(JSON.stringify(snapshot.materials).includes(primary.text));
  const tasks = centralLearningTaskSessions(ctx, primary.workspaceId);
  assert.deepEqual(await tasks(`turn-${primary.id}`, signal), [primary.id]);
  const access = createRuntimeSessionWorkspaceAccess({ ctx, workspaceId: primary.workspaceId });
  const explicit = native.replace("MixedWorkspace", "mIxEdWoRkSpAcE"), explicitId = workspaceIdentity(explicit);

  assert.equal(access.accepts({ workspaceId: explicitId, workspaceRoot: explicit }), true);
  assert.equal(access.accepts({ workspaceId: explicitId, workspaceRoot: f.foreign }), false, "an earlier proof does not bypass a later contradictory explicit root");
  const { realPath: _physicalPort, ...withoutPort } = ctx;
  const exact = createRuntimeSessionWorkspaceAccess({ ctx: withoutPort, workspaceId: primary.workspaceId });

  assert.equal(exact.accepts({ workspaceId: primary.workspaceId, workspaceRoot: native }), true);
  assert.equal(exact.accepts({ workspaceId: workspaceIdentity(caller), workspaceRoot: caller }), false);
  assert.equal(exact.accepts({ workspaceId: workspaceIdentity(caller) }), true, "rootless witnessed legacy IDs stay readable");
});

test("verified aliases route real native producer metadata and original frame/context while foreign scope stays excluded", { skip: path.sep !== "\\" }, async t => {
  const f = fixture(t), native = realpathSync.native(f.workspace), originalScope = native.toUpperCase();
  const identity = await resolveCentralRuntimeWorkspaceIdentity({ ...f.ctx, cwd: originalScope }, originalScope, { allowBudgetLookup: false });
  assert.ok(identity.ok);
  const ctx = { ...f.ctx, cwd: identity.value.workspaceRoot, workspaceIdentity: identity.value }, boardRoot = methodBoardRoot(ctx.homeDir, ctx.env);
  const writer = createMethodBoardWriter(boardRoot), readBoard = async () => {
    const loaded = await createBoardReader(boardRoot).load();
    assert.ok(loaded.ok);
    return loaded.state;
  };

  // Reuse the original Method writer's fielding/canonical-correction producer contract.
  assert.ok((await writer.commitCard({ card: { schemaVersion: 1, hint: "Inspect the declared schema before editing.", appliesWhen: {}, labels: [],
    lineage: { createdFrom: { turnId: "task:source", beat: 1, reason: "containment" } } }, nicheId: "niche:json", versionId: "method:json",
    proposalId: "proposal:json", evidenceId: "admission:json", writeId: "card:json", sample: "schema:missing", observedAt: at })).ok);

  for (const [scope, issueId] of [[originalScope, "issue:alias"], [f.foreign, "issue:foreign"]] as const) assert.ok((await withBoardWriter(boardRoot,
    store => store.apply({ type: "coordinate_learning", commandId: `report:${issueId}`, issuedAt: at, action: { kind: "report", scope,
      problemKey: issueId, issueId, report: { reportId: `report:${issueId}`, source: { subsystem: "method", taskId: "task:source", versionId: "method:json" },
        facts: ["scope:json"], evidenceRefs: ["admission:json"] } } }))).ok);

  assert.ok((await writer.recordUse({ writeId: "send:json", exposureId: "exposure:original", versionId: "method:json", proposalId: "proposal:json",
    turnId: "task:actual", beat: 1, requestId: "request:actual", scope: "json", observedAt: at })).ok);
  const observation: MethodObservation = { observationId: "observation:actual", versionId: "method:json", taskId: "task:actual",
    opportunityId: "opportunity:actual", scopeId: "json", sequence: (await readBoard()).fieldings[0]!.useSequence!, revision: 0,
    adoption: "displayed", outcome: "unhelpful", source: "self_report", features: {} };

  assert.ok((await writer.recordFeedback({ writeId: "feedback:initial", versionId: "method:json", turnId: "task:actual", helped: false,
    exposureId: "exposure:original", observation, observedAt: at })).ok);
  assert.ok((await writer.recordFeedback({ writeId: "feedback:correction", versionId: "method:json", turnId: "task:actual", helped: true,
    exposureId: "exposure:original", observation: { ...observation, revision: 1, outcome: "helped" }, observedAt: at })).ok);
  const before = await readBoard(), factory = centralRuntimeSources(ctx, identity.value.workspaceId, { maximumChars: 60000, enabled: () => true });
  const expected = projectOrganizationNativeFeedbackChanges(before, { scope: originalScope, workspaceId: workspaceIdentity(originalScope) });

  assert.ok(expected.some(row => row.kind === "delivery"));
  assert.ok(expected.some(row => row.kind === "correction"));
  const changes = factory.nativeFeedbackChanges(before);
  assert.deepEqual(changes, expected);
  assert.equal(factory.nativeFeedbackChanges(before), changes);
  assert.equal(changes.some(row => row.issueId === "issue:foreign"), false);
  const frame = factory.domainFeedback(before, "issue:alias");
  assert.ok(frame);
  assert.deepEqual(frame, projectOrganizationDomainFeedback(before, { scope: originalScope, workspaceId: workspaceIdentity(originalScope),
    issueId: "issue:alias", nativeChanges: expected }));
  assert.equal(factory.domainFeedback(before, "issue:foreign"), undefined);
  const context = await factory.contextForIssue("issue:alias");
  assert.ok(context);
  assert.ok(context.text.includes("issue:alias"));
  await assert.rejects(factory.contextForIssue("issue:foreign"), /content_issue_missing/u);
  assert.deepEqual(await readBoard(), before, "read-compatible aliases neither activate old assets nor mutate Board facts or native scopes");
});
