import assert from "node:assert/strict";
import test from "node:test";
import type { JsonObject } from "../../../../../protocol/envelope.js";
import type { ExperienceContext, ExperienceDecision, ExperienceRuntimePort } from "../experience-port.js";
import { createExperienceTools, METHOD_CONTEXT_TOOL } from "./experience-tools.js";

function harness(hasSelection = true, hasUnknownCondition = false) {
  const contexts: ExperienceContext[] = [], decisions: ExperienceDecision[] = [];
  const corrections: Array<{ readonly observationId: string; readonly outcome: string; readonly reason: string }> = [];
  const runtime: ExperienceRuntimePort = {
    async context(context) {
      contexts.push(context);
      return hasSelection ? [{ versionId: "v1", scopeId: "s1", compilationId: "c1", compact: "COMPACT", stable: true }] : [];
    },
    async decide(decision) { decisions.push(decision); }, async expand() { return "Original complete method"; }, async catalog() { return "scope"; },
    async correct(correction) { corrections.push(correction); },
    takeContextConditions: () => hasUnknownCondition ? [{ versionId: "v1", scopeId: "s1", condition: "schema-v1 JSON lookup",
      missing: [{ relation: "required", feature: "registered_feature", expectedValue: "yes" }] }] : [],
  };
  const tools = createExperienceTools({ runtime, taskId: "host-task" });
  const call = (args: JsonObject, signal = new AbortController().signal) => tools.execute({ toolCallId: "call", name: METHOD_CONTEXT_TOOL, arguments: args }, signal);

  return { tools, contexts, decisions, corrections, call };
}

test("host task identity is fixed while semantic context is model supplied", async () => {
  const h = harness(), result = await h.call({ operation: "context", situation: "entering recovery", features: { operation: "retry" } });
  assert.equal(result.outcome, "result");
  assert.deepEqual(h.contexts[0], { taskId: "host-task", opportunityId: "host-task", situation: "entering recovery", features: { operation: "retry" } });
  assert.ok(result.outcome === "result" && !result.output.includes("COMPACT"), "compact text is injected at the next request, not duplicated in tool output");
  assert.equal((await h.call({ operation: "context", taskId: "forged", situation: "recovery", features: {} })).outcome, "error");
  assert.equal(h.contexts.length, 1);
});

test("context supplies the exact adopt call before business execution and explains real m-ref feedback", async () => {
  const h = harness(), result = await h.call({ operation: "context", situation: "retry a moved file", features: { format: "json" } });

  assert.ok(result.outcome === "result");
  const output = JSON.parse(result.output);

  assert.equal(output.next.phase, "after_next_method_slot_before_business_execution");
  assert.deepEqual(output.next.calls, [{ name: METHOD_CONTEXT_TOOL,
    arguments: { operation: "adopt", versionId: "v1", scopeId: "s1", reason: "<填写本任务实际采用该方法的具体理由>" } }]);
  assert.equal(output.next.ifInapplicable.operation, "deviate");
  assert.equal(output.next.feedback.fence, "trylo-method-feedback");
  assert.match(output.next.feedback.rule, /m.*ref/);
  assert.match(output.next.feedback.rule, /true.*false/);
  assert.match(output.next.feedback.rule, /未知/);
  assert.equal(result.output.includes("COMPACT"), false);
  assert.equal(h.decisions.length, 0, "context lookup must not record adoption on the host's behalf");
  const actual = { ...output.next.calls[0].arguments, reason: "Use the known index fallback before trying another file path." };

  assert.equal((await h.call(actual)).outcome, "result");
  assert.deepEqual(h.decisions, [{ action: "adopt", versionId: "v1", scopeId: "s1", reason: actual.reason }]);
  const binding = h.tools.snapshot()[0]!;

  assert.equal(binding.sideEffect, "read_only");
  assert.equal(binding.needsApproval, false);
});

test("an empty context selection requests normal planning without fabricated adoption or feedback", async () => {
  const h = harness(false), result = await h.call({ operation: "context", situation: "unmatched task", features: {} });

  assert.ok(result.outcome === "result");
  const output = JSON.parse(result.output);

  assert.deepEqual(output.selected, []);
  assert.equal(output.next.phase, "normal_planning");
  assert.equal(output.next.calls, undefined);
  assert.equal(output.next.feedback, undefined);
  assert.equal(h.decisions.length, 0);
});

test("an unknown scope returns registered conditions for model judgment before re-exploration", async () => {
  const h = harness(false, true), result = await h.call({ operation: "context", situation: "JSON lookup", features: { task_type: "lookup" } });

  assert.ok(result.outcome === "result");
  const output = JSON.parse(result.output);

  assert.deepEqual(output.selected, []);
  assert.equal(output.next.phase, "clarify_scope_facts");
  assert.deepEqual(output.next.conditions[0].missing, [{ relation: "required", feature: "registered_feature", expectedValue: "yes" }]);
  assert.equal(output.next.nextCall.operation, "context");
  assert.equal(output.next.calls, undefined, "an unknown scope must not supply an adopt call");
  assert.deepEqual(h.contexts[0]?.features, { task_type: "lookup" });
  assert.equal(h.decisions.length, 0);
});

test("block returns explicit task recovery and structured version/step/facts", async () => {
  const h = harness(), result = await h.call({ operation: "block", versionId: "v1", scopeId: "s1", reason: "stale assumption", step: "open file", facts: "File moved" });
  assert.deepEqual(h.decisions[0], { action: "block", versionId: "v1", scopeId: "s1", reason: "stale assumption", step: "open file", facts: "File moved" });
  assert.ok(result.outcome === "result" && result.output.includes("Resume normal analysis"));
});

test("deviation and on-demand expansion preserve separate actions", async () => {
  const h = harness();
  await h.call({ operation: "deviate", versionId: "v1", scopeId: "s1", reason: "unsupported environment" });
  assert.equal(h.decisions[0]?.action, "deviate");
  const expanded = await h.call({ operation: "expand", versionId: "v1" });
  assert.ok(expanded.outcome === "result" && expanded.output.includes("Original complete method"));
});

test("cancelled and malformed calls cannot record an adoption", async () => {
  const h = harness(), controller = new AbortController();
  controller.abort();
  assert.equal((await h.call({ operation: "adopt", versionId: "v1", scopeId: "s1", reason: "matching" }, controller.signal)).outcome, "cancelled");
  assert.equal((await h.call({ operation: "adopt", versionId: "v1", scopeId: "s1" })).outcome, "error");
  assert.equal(h.decisions.length, 0);
});

test("a correction revises a named observation without inventing source authority", async () => {
  const h = harness();
  assert.equal((await h.call({ operation: "correct", observationId: "o1", outcome: "external_failure", reason: "Network was unavailable" })).outcome, "result");
  assert.deepEqual(h.corrections, [{ observationId: "o1", outcome: "external_failure", reason: "Network was unavailable" }]);
  assert.equal((await h.call({ operation: "correct", observationId: "o1", outcome: "helped", reason: "revised", source: "user" })).outcome, "error");
  assert.equal(h.corrections.length, 1);
});
