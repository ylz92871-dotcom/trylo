import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderPort, ProviderRequest } from "../../ports/provider.js";
import { emptyUsage } from "../../ports/provider.js";
import { createSkillDailyBudget } from "./skill-daily-budget.js";

const allowance = { maxTokens: 100, maxCalls: 1 };
const request: ProviderRequest = { attemptId: "turn-attempt", model: "test", messages: [], tools: [], maxOutputTokens: 40 };

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "trylo-daily-budget-"));

  t.after(() => rmSync(root, { recursive: true, force: true }));
  let ids = 0, calls = 0;
  const ctx = { now: () => 1793664000000, newId: (prefix: string) => `${prefix}-${++ids}` };
  const paths = { boardRoot: path.join(root, "board"), workspaceId: "test-workspace" };
  const provider: ProviderPort = { async *stream(sent) {
    calls += 1;
    assert.equal(sent.maxOutputTokens, 40);
    yield { type: "usage", usage: { ...emptyUsage(), inputTokens: 10, outputTokens: 12, totalTokens: 22 } };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };

  return { paths, provider, calls: () => calls, budget: () => createSkillDailyBudget(ctx, paths) };
}

async function consume(provider: ProviderPort) { for await (const event of provider.stream(request, new AbortController().signal)) void event; }

test("ordinary request identity and model quota survive a new daily host", async t => {
  const fx = fixture(t), first = fx.budget(), id = await first.open(allowance, "execution:session:turn");

  await consume(first.guard(fx.provider));
  const restarted = fx.budget();
  assert.equal(await restarted.open(allowance, "execution:session:turn"), id);
  const usage = await restarted.usage();

  assert.equal(usage.calls, 1);
  assert.equal(usage.outputTokens, 12);
  assert.equal(usage.tokens, 22);
  assert.equal(usage.reported, true);
  await assert.rejects(consume(restarted.guard(fx.provider)), /learning_grant_exhausted/);
  assert.equal(fx.calls(), 1, "the second host must not send beyond the original grant");
});

test("only a new explicit learning request allocates another quota", async t => {
  const fx = fixture(t), first = fx.budget(), id = await first.open(allowance);
  await consume(first.guard(fx.provider));
  await first.close();
  const second = fx.budget();
  assert.notEqual(await second.open(allowance), id);
  await consume(second.guard(fx.provider));
  assert.equal(fx.calls(), 2);
});

test("a closed ordinary grant and a conflicting larger allowance cannot reopen spending", async t => {
  const fx = fixture(t), first = fx.budget();
  await first.open(allowance, "execution:session:turn");
  await first.close();
  const restarted = fx.budget();
  await restarted.open(allowance, "execution:session:turn");
  await assert.rejects(consume(restarted.guard(fx.provider)), /learning_grant_closed/);
  await assert.rejects(restarted.open({ maxCalls: 2, maxTokens: 200 }), /learning_grant_conflict/);
  assert.equal(fx.calls(), 0);
});

test("zero-model invalidation neither allocates a grant nor constructs a Board", async t => {
  const fx = fixture(t), budget = fx.budget();
  assert.equal(await budget.open({ maxCalls: 0, maxTokens: 0 }), undefined);
  assert.equal((await budget.usage()).calls, 0);
  assert.equal(existsSync(fx.paths.boardRoot), false);
});
