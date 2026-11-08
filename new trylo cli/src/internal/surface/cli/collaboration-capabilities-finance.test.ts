import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorkspaceSandbox } from "../../adapters/sandbox/index.js";
import { createPermissionGrantCache } from "../../loop/permission-grants.js";
import { emptyUsage, type ProviderEvent, type ProviderPort } from "../../ports/provider.js";
import type { ToolPort } from "../../ports/tools.js";
import type { SkillCatalogPort, SkillDescriptor } from "../../ports/skills.js";
import type { ExpertConfiguration } from "../../subagent/experts/index.js";
import type { CentralFundingPort } from "../../learning/agent/subsystems/collaboration/control/index.js";
import type { CentralLearningGrant, CentralLearningUsage } from "../../learning/control/coordination-contract.js";
import { createCollaborationCapabilities } from "./collaboration-capabilities.js";

type Ending = "eof" | "typed_error" | "cancel" | "tail_warning" | "complete" | "overrun";

const finish: ProviderEvent = { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
const usage = (tokens: number): ProviderEvent => ({ type: "usage", usage: { ...emptyUsage(), inputTokens: tokens, totalTokens: tokens } });

async function fixture(t: TestContext, ending: Ending, route: "business" | "dedicated_learning" = "business") {
  const root = await mkdtemp(path.join(tmpdir(), "associated-expert-finance-"));

  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("associated-expert-finance-"));
    await rm(root, { recursive: true, force: true });
  });
  const controller = new AbortController(), receipts: CentralLearningUsage[] = [], reservations: number[] = [];
  const descriptor: SkillDescriptor = { name: "accounting-fixture", description: "Synthetic accounting source",
    source: "project", skillRoot: root, path: path.join(root, "SKILL.md"), contentHash: "synthetic-source-v1",
    body: "Retain the source identity when reviewing a receipt.", userInvocable: true, disableModelInvocation: false, forkExecution: false };
  const skills: SkillCatalogPort = { list: () => [descriptor], load: () => ({ kind: "loaded",
    skill: { descriptor, content: descriptor.body } }) };
  const source = { kind: "installed_skill" as const, title: descriptor.name,
    uri: `skill:${descriptor.name}@${descriptor.contentHash}`, excerpt: descriptor.body };
  const configuration: ExpertConfiguration = { displayName: "Receipt fixture", specialty: "Synthetic receipt review",
    situations: ["Accounting contract"], responsibilities: ["Keep source references"], constraints: ["No external effects"],
    collaboration: ["Report the source"], baseRole: "worker", role: { name: "worker", description: "Accounting fixture" },
    toolRefs: [], sources: [source], methods: [{ title: "Review receipt", instructions: "Keep its source identity.", sourceUris: [source.uri] }] };
  let childCalls = 0, parentCalls = 0, forks = 0, unexpectedBusinessForks = 0;
  const child: ProviderPort = { async *stream() {
    childCalls += 1;
    yield usage(ending === "overrun" ? 1_000_000 : 100);

    if (ending === "eof") return;

    if (ending === "typed_error") {
      yield { type: "error", class: "network", retryable: false, phase: "after_stream_started", message: "Synthetic redacted error" };
      return;
    }

    if (ending === "cancel") {
      controller.abort();
      yield { type: "cancel_ack" };
      return;
    }

    yield { type: "text_delta", blockId: "configuration", text: JSON.stringify(configuration) };
    yield finish;

    if (ending === "tail_warning") yield { type: "warning", code: "stream_finish_tail_timeout", message: "Synthetic incomplete receipt" };

    if (ending === "complete") yield usage(250);
  } };
  const provider: ProviderPort = { fork(messages) {
    assert.deepEqual(messages, []);
    forks += 1;
    return child;
  },

    async *stream() {
      parentCalls += 1;
      throw new Error("The parent provider must not be streamed");
    } };
  const withheldBusiness: ProviderPort = { fork() {
    unexpectedBusinessForks += 1;
    throw new Error("Associated work must use its dedicated learning provider");
  },

    async *stream() { throw new Error("The withheld business provider must not be streamed"); } };
  const tools: ToolPort = { snapshot: () => [], async execute() { throw new Error("No tool may run in this accounting contract"); }, async cancel() {} };
  const grant: CentralLearningGrant = { schemaVersion: 2, grantId: "grant:expert-finance", issueId: "issue:expert-finance",
    jobId: "job:expert-finance", scope: root, domain: "collaboration", focusRevision: 2, steps: 0, reservations: [], status: "open",
    claim: { claimId: "claim:expert-finance", ownerId: "fixture", expiresAt: "2026-11-04T10:00:00.000Z", step: 1 },
    allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 20000, maxCalls: 4, maxSteps: 4, maxPromptChars: 40000 } };
  const remaining = { tokens: 20000, calls: 4, steps: 4 };
  const funding: CentralFundingPort = {
    async inspect() { return { ok: true, active: true, grant, remaining }; },

    async reserve(input) {
      reservations.push(input.maxTokens);
      return { ok: true, status: "reserved", grant, remaining };
    },

    async settle(input) {
      receipts.push(input.usage);
      return { ok: true, status: "settled", grant, remaining };
    },
  };
  const capabilities = createCollaborationCapabilities({ homeRoot: path.join(root, "profile"), boardRoot: path.join(root, "board"),
    scope: root, taskId: "task:expert-finance", tools, workspaceTools: tools, toolSelectionCeiling: [],
    provider: route === "business" ? provider : withheldBusiness,
    ...(route === "dedicated_learning" ? { learningProvider: provider } : {}), model: "synthetic-no-network",
    permission: { async request(action) { return { ticketId: "permission:expert-finance", toolCallId: action.toolCallId }; },
      async awaitDecision() { return { resolution: "approved", scope: "once" }; } },
    sandbox: createWorkspaceSandbox({ workspaceRoot: root }), grants: createPermissionGrantCache(), skills,
    experience: { async load() { return ""; } }, now: () => "2026-11-04T06:00:00.000Z" });
  const request = await capabilities.expertHost.library.submitRequest({ origin: "collaboration", requestId: "request:expert-finance",
    instruction: "Prepare an accounting-fixture expert from its installed source.",
    association: { issueId: grant.issueId, jobId: grant.jobId, grantId: grant.grantId } },
  { signal: controller.signal, useScope: { workspaceId: root, taskId: "task:expert-finance" } });

  assert.equal(request.state, "authorized");
  const outcome = await capabilities.buildExpert(request.requestId, funding, controller.signal).then(
    value => ({ kind: "built" as const, value }), error => ({ kind: "failed" as const, error: error instanceof Error ? error.name : "unknown" }));

  assert.deepEqual({ childCalls, parentCalls, forks, reserve: reservations.length, settle: receipts.length },
    { childCalls: 1, parentCalls: 0, forks: 1, reserve: 1, settle: 1 });
  assert.equal(unexpectedBusinessForks, 0);
  assert.ok(reservations[0]! > 100);

  return { outcome, receipts };
}

for (const ending of ["eof", "typed_error", "cancel", "tail_warning"] as const) {
  test(`associated expert ${ending} keeps partial usage unknown through the public host`, async t => {
    const result = await fixture(t, ending);
    assert.equal(result.outcome.kind, ending === "tail_warning" ? "built" : "failed");
    assert.equal(result.receipts[0]?.kind, "unknown");
  });
}

test("associated expert normal completion drains trailing usage before reporting its receipt", async t => {
  const result = await fixture(t, "complete");
  assert.equal(result.outcome.kind, "built");
  assert.deepEqual(result.receipts[0], { kind: "reported", totalTokens: 250, inputTokens: 250, outputTokens: 0, model: "synthetic-no-network" });
});

test("associated expert observed overrun preserves its measured lower bound and rejects the configuration", async t => {
  const result = await fixture(t, "overrun");
  assert.equal(result.receipts[0]?.kind, "reported");
  if (result.receipts[0]?.kind === "reported") assert.equal(result.receipts[0].totalTokens, 1_000_000);
  assert.equal(result.outcome.kind, "failed");
});

test("associated expert selects its dedicated learning provider before forking", async t => {
  const result = await fixture(t, "complete", "dedicated_learning");
  assert.equal(result.outcome.kind, "built");
  assert.equal(result.receipts[0]?.kind, "reported");
});
