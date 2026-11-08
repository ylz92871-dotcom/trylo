import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCheckLearningForTurn, closeCheckLearningTurn, requirementsForCheckTurn, type DailyCheckRuntime } from "./check-learning-wiring.js";
import { executeTurn, isTurnFailure, type TurnHostInput } from "./host.js";
import type { Wiring } from "./wiring.js";
import type { ProviderEvent, ProviderPort, ProviderRequest } from "../../ports/provider.js";
import type { ToolBinding, ToolOutcome } from "../../ports/tools.js";
import { EMPTY_PROFILE } from "../../contract/profile.js";
import type { CheckExperience } from "../../learning/check/v2/contracts.js";
import type { Envelope } from "../../protocol/envelope.js";
import { createRunExecution } from "./run-execution-wiring.js";

const SIGNAL = new AbortController().signal;
const binding = (name: string): ToolBinding => ({ name, description: name, sideEffect: name === "read_file" ? "read_only" : "workspace_write",
  parameters: { type: "object" }, needsApproval: false, timeoutMs: 10_000, outputLimits: { maxBytes: 65536, maxLines: 2000 } });
const SCHEMA = { $id: "invoice-json-v1", description: "invoice output", type: "object", required: ["total"], properties: { total: { type: "number" } } };

async function fixture(t: { after(fn: () => Promise<void>): void }, verdict: "fail" | "checker_error" = "fail") {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-check-hook-"));
  const execution = createRunExecution(root, { shellIsolation: "host" });

  t.after(async () => {
    await execution.close();
    await rm(root, { recursive: true, force: true });
  });
  const experiences: CheckExperience[] = [], checks: Parameters<DailyCheckRuntime["check"]>[0][] = [];
  const requests: ProviderRequest[] = [], feedbacks: Parameters<NonNullable<DailyCheckRuntime["feedback"]>>[0][] = [];
  const learned: Parameters<DailyCheckRuntime["learn"]>[0][] = [], stdout: string[] = [];
  const runtime: DailyCheckRuntime = {
    capture: async experience => {
      experiences.push(experience);
      return { ok: true };
    },

    check: async input => {
      checks.push(input);
      return { ok: true, runs: [{ runId: `${input.runId}:actual-check`, versionId: "checker-v2",
        outcome: verdict === "checker_error" ? { kind: "checker_error", code: "execution_unavailable" }
          : { kind: "checked", verdict: { status: "fail", findings: [{ requirementRef: input.requirements.ref, message: "total is missing" }] } } }] };
    },

    learn: async dispatch => {
      learned.push(dispatch);
      return { ok: true };
    },

    feedback: async input => {
      feedbacks.push(input);
      return { ok: true };
    },
  };
  const provider: ProviderPort = { async *stream(request): AsyncIterable<ProviderEvent> {
    requests.push(request);
    yield { type: "stream_start", providerId: "fixture", model: "fixture", warnings: [] };
    yield { type: "text_start", blockId: "answer" };
    yield { type: "text_delta", blockId: "answer", text: '{"total":3}' };
    yield { type: "text_end", blockId: "answer" };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } };
  const input: TurnHostInput = { text: "make an invoice", sessionId: "session", turnId: "turn", correlationId: "correlation",
    workspaceRoot: root, workspaceId: "workspace", checkpointRoot: path.join(root, "undo"), providerId: "fixture", model: "fixture",
    endpoint: "", apiKey: undefined, responseSchema: SCHEMA, format: "stream-json", now: () => 0, execution,
    permission: { request: async action => ({ ticketId: action.toolCallId, toolCallId: action.toolCallId }),
      awaitDecision: async () => ({ resolution: "approved", scope: "once" }) },
    sink: { stdout: text => stdout.push(text), stderr: () => {} },
    checkLearning: { collection: "enabled", allowance: { modelCalls: 2, executions: 8, tokens: 2000 }, runtime },
  };
  const wiring: Wiring = { close: async () => {}, providerId: "fixture", model: "fixture", toolCatalogHash: "catalog", ports: {
    provider, permission: input.permission, profile: { load: async () => EMPTY_PROFILE },
    tools: { snapshot: () => [binding("read_file"), binding("write_file")], cancel: async () => {},

      async execute(call): Promise<ToolOutcome> {
        if (call.name === "write_file") {
          await writeFile(path.join(root, String(call.arguments.path)), String(call.arguments.content));
          return { outcome: "result", output: "written", truncated: false, value: {
            fileWrite: { kind: "file_write", path: String(call.arguments.path), bytes: 12, mode: "created" },
          } };
        }

        const text = await readFile(path.join(root, String(call.arguments.path)), "utf8");

        return { outcome: "result", output: text, truncated: false, value: { path: String(call.arguments.path), content: text } };
      },
    },
  } };

  return { root, input, wiring, runtime, experiences, checks, requests, feedbacks, learned, stdout };
}

test("the full instruction is frozen even with a schema, while identical instructions remain reusable", () => {
  const first = requirementsForCheckTurn({ text: "produce invoice A", responseSchema: SCHEMA });
  const second = requirementsForCheckTurn({ text: "produce invoice A", responseSchema: SCHEMA });
  const changed = requirementsForCheckTurn({ text: "produce invoice A", responseSchema: { ...SCHEMA, required: ["total", "currency"] } });
  const instruction = requirementsForCheckTurn({ text: "produce invoice A but use net instead of gross total", responseSchema: SCHEMA });

  assert.ok(first.ok && second.ok && changed.ok && instruction.ok);
  assert.equal(first.value.digest, second.value.digest);
  assert.equal(first.value.ref, second.value.ref);
  assert.notEqual(first.value.digest, changed.value.digest);
  assert.notEqual(first.value.digest, instruction.value.digest);
  assert.ok(first.value.text.includes("produce invoice A"));
});

test("writes return unchanged before checking, and the next provider sees a real read-back result", async t => {
  const fx = await fixture(t), hook = await createCheckLearningForTurn(fx.input, fx.wiring);
  assert.ok(hook);
  const call = { toolCallId: "write-one", name: "write_file", arguments: { path: "result.json", content: '{"total":3}' } };
  const result = await hook.ports.tools.execute(call, SIGNAL);

  assert.equal(result.outcome, "result");
  if (result.outcome !== "result") return;

  assert.equal(result.output, "written");
  assert.equal(fx.checks.length, 0, "the tool timeout owns no checker execution");
  assert.equal(fx.learned.length, 0);

  for await (const _event of hook.ports.provider.stream({ attemptId: "next", model: "fixture", messages: [], tools: [] }, SIGNAL)) { /* drain */ }

  assert.equal(fx.checks.length, 1);
  assert.deepEqual(fx.checks[0]!.input.output, { total: 3 });
  assert.equal(fx.experiences[0]!.facts.tool?.name, "write_file");
  assert.ok(fx.requests[0]!.messages.some(message => message.content.includes("Actual learned-check execution results")));
  assert.ok(fx.requests[0]!.messages.some(message => message.content.includes("total is missing")));
  assert.equal(fx.experiences[0]!.assessment, undefined, "the model/tool completion never becomes an oracle");
});

test("checker execution errors remain distinct from an invalid object and never change the actual tool outcome", async t => {
  const fx = await fixture(t, "checker_error");
  await writeFile(path.join(fx.root, "result.json"), '{"total":3}');
  const hook = await createCheckLearningForTurn(fx.input, fx.wiring);
  assert.ok(hook);
  const result = await hook.ports.tools.execute({ toolCallId: "read-one", name: "read_file", arguments: { path: "result.json" } }, SIGNAL);

  assert.equal(result.outcome, "result");

  for await (const _event of hook.ports.provider.stream({ attemptId: "next", model: "fixture", messages: [], tools: [] }, SIGNAL)) { /* drain */ }

  const text = JSON.stringify(fx.requests[0]!.messages);

  assert.ok(text.includes("checker_error"));
  assert.ok(text.includes("execution_unavailable"));
  assert.equal(text.includes('\\"status\\":\\"fail\\"'), false);
});

test("a later write prevents a read-back result being attributed to an earlier write", async t => {
  const fx = await fixture(t), hook = await createCheckLearningForTurn(fx.input, fx.wiring);
  assert.ok(hook);

  for (const total of [1, 2]) await hook.ports.tools.execute({ toolCallId: `write-${total}`, name: "write_file",
    arguments: { path: "result.json", content: JSON.stringify({ total }) } }, SIGNAL);

  for await (const _event of hook.ports.provider.stream({ attemptId: "next", model: "fixture", messages: [], tools: [] }, SIGNAL)) { /* drain */ }

  assert.equal(fx.checks.length, 1);
  assert.deepEqual(fx.checks[0]!.input.output, { total: 2 });
  assert.equal(fx.experiences.length, 2, "both actual tool facts survive, but only the last artifact is checked");
  assert.ok(fx.stdout.join("").includes("artifact_superseded_before_check"));
});

test("artifact reads respect an explicit read denial and missing content is never judged as a defective artifact", async t => {
  const fx = await fixture(t);
  const hook = await createCheckLearningForTurn({ ...fx.input, permission: { ...fx.input.permission,
    isDenied: name => name === "read_file" } }, fx.wiring);
  assert.ok(hook);
  await hook.ports.tools.execute({ toolCallId: "write", name: "write_file", arguments: { path: "result.json", content: '{"total":3}' } }, SIGNAL);

  for await (const _event of hook.ports.provider.stream({ attemptId: "next", model: "fixture", messages: [], tools: [] }, SIGNAL)) { /* drain */ }

  assert.equal(fx.checks.length, 0);
  assert.equal(fx.experiences.length, 1);
  assert.ok(fx.stdout.join("").includes("artifact_read_not_available"));
});

test("collection disabled and unattributed legacy user transport construct no runtime", async t => {
  const fx = await fixture(t);
  let factories = 0;
  const createRuntime = async () => {
    factories += 1;
    return fx.runtime;
  };
  assert.equal(await createCheckLearningForTurn({ ...fx.input, checkLearning: { ...fx.input.checkLearning!, collection: "disabled" } }, fx.wiring, { createRuntime }), undefined);
  assert.equal(await createCheckLearningForTurn({ ...fx.input, userSourceAvailable: false }, fx.wiring, { createRuntime }), undefined);
  assert.equal(factories, 0);
  assert.equal(fx.experiences.length, 0);
});

test("cancelled pending work starts neither a checker nor a learning request", async t => {
  const fx = await fixture(t), cancel = new AbortController();
  await writeFile(path.join(fx.root, "x.json"), "{}");
  const hook = await createCheckLearningForTurn({ ...fx.input, cancelSignal: cancel.signal }, fx.wiring);
  assert.ok(hook);
  await hook.ports.tools.execute({ toolCallId: "read", name: "read_file", arguments: { path: "x.json" } }, SIGNAL);
  cancel.abort();
  await hook.afterClose();
  assert.equal(fx.checks.length, 0);
  assert.equal(fx.experiences.length, 0);
  assert.equal(fx.learned.length, 0);
});

test("close order releases execution first and only then lends the subsystem its bounded allowance", async t => {
  const fx = await fixture(t), order: string[] = [], hook = await createCheckLearningForTurn(fx.input, fx.wiring);
  assert.ok(hook);
  await closeCheckLearningTurn({ reward: { flush: async () => { order.push("reward"); } }, input: { bindAgentTools: () => { order.push("unbind"); } },
    wiring: { close: async () => { order.push("execution"); } }, toolGap: { close: async () => { order.push("tool-gap"); } }, checks: {
      ...hook, afterClose: async () => {
        order.push("check-learning");
        await hook.afterClose();
      },
    } });
  assert.deepEqual(order, ["reward", "unbind", "execution", "tool-gap", "check-learning"]);
  assert.deepEqual(fx.learned, [{ subsystem: "verifier", allowance: { modelCalls: 2, executions: 0, tokens: 2000 } }]);
});

test("ordinary host executes the check hook, publishes its real report before run_result, and preserves one terminal", async t => {
  const fx = await fixture(t);
  const outcome = await executeTurn(fx.input);

  assert.equal(isTurnFailure(outcome), false);
  if (isTurnFailure(outcome)) return;

  assert.equal(outcome.exitCode, 0, "task lifecycle and checker verdict remain distinct");
  assert.ok(fx.checks.some(check => check.input.phase === "before_completion"));
  const rows = fx.stdout.join("").trim().split("\n").map(line => JSON.parse(line) as { type: string; code?: string });

  assert.equal(rows.filter(row => row.type === "run_result").length, 1);
  const report = rows.findIndex(row => row.type === "warning" && row.code === "check_learning_result");

  assert.ok(report >= 0);
  assert.ok(report < rows.findIndex(row => row.type === "run_result"));
  assert.equal(fx.learned.length, 1);
});

test("real correction identity is forwarded without converting free text into a passing or failing oracle", async t => {
  const fx = await fixture(t), hook = await createCheckLearningForTurn(fx.input, fx.wiring);
  assert.ok(hook);
  const event: Envelope = { protocolVersion: "0.0", eventId: "human-correction", sequence: 4, timestamp: "2026-11-03T00:00:00.000Z",
    sessionId: "session", turnId: "turn", kind: "user_correction", payload: { text: "This case is an exception, keep the normal rule." }, producerId: "loop", producerSequence: 4 };

  hook.capture(event);
  hook.capture(event);
  // Obtain a terminal through the actual execution loop, without a fabricated success flag.
  const { runTurn } = await import("../../loop/runner.js");
  const run = await runTurn(fx.wiring.ports, { sessionId: "session", turnId: "turn", correlationId: "correlation", text: "finish" });

  await hook.finish(run);
  assert.equal(fx.feedbacks.length, 1);
  assert.equal(fx.feedbacks[0]!.sourceRef, "execution:human-correction");
  assert.equal(fx.feedbacks[0]!.text, event.payload.text);
  assert.equal(fx.experiences.some(experience => experience.assessment?.sourceRef === "execution:human-correction"), false);
});
