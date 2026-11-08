import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { centralLearningSpent } from "../../learning/control/coordination-contract.js";
import { createDenyAllPermission } from "./permission.js";
import { wirePorts, type Wiring } from "./wiring.js";

test("the public central collaboration host sends one POST for its one funded reservation", async t => {
  const base = testScratchPath("learning-provider-host-tests");

  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "case-")), scope = path.join(root, "workspace"), home = path.join(root, "home");

  await mkdir(scope, { recursive: true });
  let wired: Wiring | undefined;

  t.after(async () => {
    await wired?.close();
    assert.equal(path.dirname(path.resolve(root)), base);
    await rm(root, { recursive: true, force: true });
  });
  const originalFetch = globalThis.fetch;
  let posts = 0;

  globalThis.fetch = async (_url, init) => {
    assert.equal(init?.method, "POST");
    posts += 1;
    return new Response("{}", { status: 503 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const wiring = wirePorts({ providerId: "synthetic-learning", providerKind: "openai-compatible", model: "synthetic",
    endpoint: "https://unit.invalid/chat/completions", apiKey: "synthetic-not-a-credential", workspaceRoot: scope,
    permission: createDenyAllPermission(), collaborationLearning: { homeDir: home, env: { TRYLO_HOME: home },
      scope, turnId: "turn:single-request", now: () => 0, warn: () => {} } });

  assert.ok(!("code" in wiring));
  wired = wiring;
  const control = wiring.collaboration?.control;
  assert.ok(control);
  const reported = await control.report({ scope, problemKey: "one-funded-transport", report: {
    reportId: "report:single-request", source: { teamRunId: "fixture-team", taskId: "fixture-task", memberId: "personal_agent" },
    facts: ["Synthetic transport accounting fixture."], evidenceRefs: [] } });

  assert.ok(reported.ok);
  const focused = await control.decide({ issueId: reported.issue.issueId, expectedRevision: reported.issue.revision,
    decision: "focused_learning", reason: "Explicit local accounting fixture.", sourceRefs: ["report:single-request"] });

  assert.ok(focused.ok);
  const funded = await control.fund({ issueId: focused.issue.issueId, expectedRevision: focused.issue.revision,
    grantId: "grant:single-request", allowance: { schemaVersion: 2, unit: "total_model_tokens",
      maxTokens: 24_000, maxCalls: 1, maxSteps: 1, maxPromptChars: 100_000 } });

  assert.ok(funded.ok);
  const dispatched = await control.dispatch({ scope });
  assert.ok(dispatched.ok);
  const view = await control.read(scope);
  assert.ok(view.ok);
  const grant = view.grants.find(item => item.grantId === funded.grant.grantId);
  assert.ok(grant);
  assert.equal(grant.reservations.length, 1, "the test must reach the real funded Provider call");
  assert.equal(grant.reservations[0]?.usage?.kind, "unknown");
  assert.equal(centralLearningSpent(grant).tokens, grant.reservations[0]?.maxTokens);
  assert.ok(posts > 0, "a source/readiness rejection is not a transport regression");
  assert.equal(posts, 1, "one reservation cannot hide model POST retries");
});

test("user-only learning and disabled collaboration keep the original single provider construction", async t => {
  const base = testScratchPath("learning-provider-host-tests");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, "off-")), scope = path.join(root, "workspace"), home = path.join(root, "home");

  await mkdir(scope, { recursive: true });
  let guards = 0;
  const wiring = wirePorts({ providerId: "fixture", model: "fixture", endpoint: "", apiKey: undefined, workspaceRoot: scope,
    permission: createDenyAllPermission(), providerGuard: provider => {
      guards += 1;
      return provider;
    },

    learning: { switch: "user", homeDir: home, env: { TRYLO_HOME: home }, emit: () => {} },
    collaborationLearning: { choice: "off", homeDir: home, env: { TRYLO_HOME: home }, scope,
      turnId: "turn:off", now: () => 0, warn: () => {} } });

  assert.ok(!("code" in wiring));
  t.after(async () => {
    await wiring.close();
    assert.equal(path.dirname(path.resolve(root)), base);
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(guards, 1);
  assert.equal(wiring.ports.method, undefined);
});
