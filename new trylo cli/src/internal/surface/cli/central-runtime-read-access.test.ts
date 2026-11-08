import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { createMethodBoardWriter } from "../../learning/agent/subsystems/method/adapters/board-writer.js";
import type { MethodObservation } from "../../learning/agent/subsystems/method/domain/inference-observations.js";
import { projectOrganizationNativeFeedbackChanges } from "../../integration/central-learning/organization-feedback-changes.js";
import { projectCentralDomainFeedback } from "./central-learning-sources.js";
import type { CliContext } from "./context.js";
import { methodBoardRoot } from "./learning-sink.js";
import { workspaceIdentity } from "./workspace-identity.js";
import { createCentralRuntimeReadWorkspaceAccess } from "./central-runtime-read-access.js";
import { centralRuntimeSources } from "./central-runtime-sources.js";

const at = "2026-11-05T00:00:00.000Z";

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-runtime-read-access-"));
  const native = path.join(root, "native"), alias = path.join(root, "alias"), foreign = path.join(root, "foreign");

  mkdirSync(native);
  mkdirSync(foreign);
  const rootRef = { budgetId: "budget:original", scope: native, openedSequence: 1, authorizationRef: "authorization:original" };
  const calls: string[] = [];
  const ctx: CliContext = { cwd: native, homeDir: root, env: { TRYLO_HOME: path.join(root, "home") }, nodeVersion: "test", stdinIsTty: false,
    workspaceIdentity: { physicalRoot: native, workspaceRoot: native, workspaceId: workspaceIdentity(native), budgetScope: native,
      compatibleRoots: [native], compatibleWorkspaceIds: [workspaceIdentity(native)], rootRef },

    realPath: value => {
      calls.push(value);
      return value === native || value === alias ? native : value === foreign ? foreign : undefined;
    },

    readFile: () => undefined, isDirectory: () => false, readDir: () => [], writeFile: () => false,
    readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined,
    stdout() {}, stderr() {}, now: () => Date.parse(at), newId: prefix => `${prefix}:unused` };

  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("trylo-runtime-read-access-"));
    rmSync(root, { recursive: true, force: true });
  });

  return { ctx, native, alias, foreign, calls, rootRef };
}

test("proved raw aliases publish immutable new read snapshots while primary identity and funding remain fixed", t => {
  const f = fixture(t), access = createCentralRuntimeReadWorkspaceAccess(f.ctx), before = access.snapshot(), identity = access.identity;

  assert.ok(identity);
  assert.ok(Object.isFrozen(before));

  for (const values of [before.roots, before.workspaceIds, before.scopes]) assert.ok(Object.isFrozen(values));

  assert.equal(access.observeSourceWorkspaceRoots([f.foreign, "relative", f.alias + path.sep, "bad\0root"]), before);
  assert.equal(access.identity, identity);
  const after = access.observeSourceWorkspaceRoots([f.alias]);

  assert.equal(after.revision, before.revision + 1);
  assert.deepEqual(after.roots, [f.native, f.alias]);
  assert.deepEqual(after.workspaceIds, [workspaceIdentity(f.native), workspaceIdentity(f.alias)]);
  assert.deepEqual(after.scopes, [f.native, f.alias, workspaceIdentity(f.native), workspaceIdentity(f.alias)]);
  assert.deepEqual(before.roots, [f.native]);
  assert.deepEqual(identity.compatibleRoots, [f.native]);
  assert.notEqual(access.identity, identity);
  assert.equal(access.identity?.workspaceId, identity.workspaceId);
  assert.equal(access.identity?.workspaceRoot, identity.workspaceRoot);
  assert.equal(access.identity?.physicalRoot, identity.physicalRoot);
  assert.equal(access.identity?.budgetScope, identity.budgetScope);
  assert.deepEqual(access.identity?.rootRef, f.rootRef);
  assert.equal(access.observeSourceWorkspaceRoots([f.alias, f.foreign]), after);

  for (const values of [after.roots, after.workspaceIds, after.scopes, access.identity?.compatibleRoots,
    access.identity?.compatibleWorkspaceIds]) assert.ok(Object.isFrozen(values));
});

test("missing physical evidence or a descriptor never expands read access", t => {
  const f = fixture(t), { realPath: _physicalPort, ...withoutPort } = f.ctx;
  const exact = createCentralRuntimeReadWorkspaceAccess(withoutPort), initial = exact.snapshot();

  assert.equal(exact.observeSourceWorkspaceRoots([f.alias, f.foreign, f.native]), initial);
  const { workspaceIdentity: _identity, ...withoutIdentity } = f.ctx;
  const staticAccess = createCentralRuntimeReadWorkspaceAccess(withoutIdentity), before = staticAccess.snapshot();

  assert.equal(staticAccess.identity, undefined);
  assert.equal(staticAccess.observeSourceWorkspaceRoots([f.alias]), before);
  assert.deepEqual(before.roots, [f.native]);
  assert.deepEqual(f.calls, []);
});

test("native source caches follow the access revision while each asynchronous context read keeps its entry snapshot", async t => {
  const f = fixture(t), boardRoot = methodBoardRoot(f.ctx.homeDir, f.ctx.env), writer = createMethodBoardWriter(boardRoot);
  const readBoard = async () => {
    const loaded = await createBoardReader(boardRoot).load();
    assert.ok(loaded.ok);
    return loaded.state;
  };

  assert.ok((await writer.commitCard({ card: { schemaVersion: 1, hint: "Inspect the declared schema before editing.", appliesWhen: {}, labels: [],
    lineage: { createdFrom: { turnId: "task:source", beat: 1, reason: "containment" } } }, nicheId: "niche:json", versionId: "method:json",
    proposalId: "proposal:json", evidenceId: "admission:json", writeId: "card:json", sample: "schema:missing", observedAt: at })).ok);

  for (const [scope, issueId] of [[f.alias, "issue:alias"], [f.foreign, "issue:foreign"]] as const) assert.ok((await withBoardWriter(boardRoot,
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
  const before = await readBoard(), access = createCentralRuntimeReadWorkspaceAccess(f.ctx);
  const options = { maximumChars: 60000, enabled: () => true, readWorkspaceAccess: access.snapshot };
  const factory = centralRuntimeSources(f.ctx, workspaceIdentity(f.native), options), previousScopes = factory.compatibleScopes;
  const previous = factory.nativeFeedbackChanges(before);
  assert.deepEqual(previous, []);
  assert.equal(factory.nativeFeedbackChanges(before), previous);
  const pending = factory.contextForIssue("issue:alias");

  access.observeSourceWorkspaceRoots([f.alias]);
  await assert.rejects(pending, /content_issue_missing/u);
  assert.equal(previousScopes.includes(f.alias), false);
  assert.equal(factory.compatibleScopes.includes(f.alias), true);
  const expected = projectOrganizationNativeFeedbackChanges(before, { scope: f.alias, workspaceId: workspaceIdentity(f.alias) });

  assert.ok(expected.some(row => row.kind === "delivery"));
  assert.ok(expected.some(row => row.kind === "correction"));
  const changes = factory.nativeFeedbackChanges(before);
  assert.deepEqual(changes, expected);
  assert.notEqual(changes, previous);
  assert.equal(factory.nativeFeedbackChanges(before), changes);
  assert.deepEqual(factory.domainFeedback(before, "issue:alias"), projectCentralDomainFeedback(before,
    { scope: f.alias, workspaceId: workspaceIdentity(f.alias), issueId: "issue:alias", nativeChanges: expected }));
  const context = await factory.contextForIssue("issue:alias");
  assert.ok(context?.text.includes("issue:alias"));
  const stable = access.snapshot();
  access.observeSourceWorkspaceRoots([f.foreign]);
  assert.equal(access.snapshot(), stable);
  assert.equal(factory.domainFeedback(before, "issue:foreign"), undefined);
  await assert.rejects(factory.contextForIssue("issue:foreign"), /content_issue_missing/u);
  assert.equal(factory.nativeFeedbackChanges(before).some(row => row.issueId === "issue:foreign"), false);
  assert.deepEqual(await readBoard(), before, "read closure changes never activate assets, issue calls, or write Board facts");
});
