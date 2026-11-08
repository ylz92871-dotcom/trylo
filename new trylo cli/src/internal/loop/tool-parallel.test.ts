import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderEvent, ProviderPort, ProviderRequest } from "../ports/provider.js";
import type { ToolBinding, ToolPort } from "../ports/tools.js";
import { createFakePermission, echoBinding, emptyProfileLoader, toolResult } from "./fakes.js";
import { runTurn, type LoopPorts } from "./runner.js";

/**
 * What "tools may run in parallel" actually buys (WP22.1 / C05, L03).
 *
 * The reducer already had a batch shape before this package, and a batch whose
 * calls are executed one after another is indistinguishable from no batch at
 * all — it settles correctly and saves nothing. So these tests do not measure
 * elapsed time, which would be a flaky way to say "faster": they ask whether
 * two calls' execution **intervals overlap**, which is either true or false and
 * survives a slow machine.
 *
 * The verdict is read off a log of `start:`/`end:` marks rather than off a
 * clock. One call is given a delay so the overlap has a window to be seen in;
 * without it a fast call could finish before its sibling is even started and
 * the test would say "serial" about code that runs things together.
 */

const REQUEST = { sessionId: "s", turnId: "t", correlationId: "c", text: "read the project" };
const STOP: ReadonlyArray<ProviderEvent> = [
  { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false },
];

function scripted(
  script: ReadonlyArray<ReadonlyArray<ProviderEvent>>,
): { readonly requests: ProviderRequest[]; readonly port: ProviderPort } {
  const requests: ProviderRequest[] = [];
  let index = 0;

  return {
    requests,
    port: {
      async *stream(request) {
        requests.push(request);
        const events = script[index] ?? [];
        index += 1;
        for (const event of events) yield event;
      },
    },
  };
}

function askingFor(ids: ReadonlyArray<string>, name: string): ReadonlyArray<ProviderEvent> {
  return [
    ...ids.map(
      (toolCallId): ProviderEvent => ({
        type: "tool_call",
        toolCallId,
        name,
        arguments: { path: `${toolCallId}.js` },
      }),
    ),
    { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
  ];
}

const READ_SAFE = echoBinding({ name: "read_file", needsApproval: false, parallelSafe: true });
const READ_PLAIN = echoBinding({ name: "read_file", needsApproval: false });
const WRITE_PLAIN = echoBinding({ name: "write_file", sideEffect: "workspace_write", needsApproval: false });

/**
 * A tool port that records when each call ran and takes a per-call delay.
 */
function markingTools(
  bindings: ReadonlyArray<ToolBinding>,
  delayMs: (toolCallId: string) => number = () => 0,
): { readonly tools: ToolPort; readonly log: string[] } {
  const log: string[] = [];
  const tools: ToolPort = {
    snapshot: () => bindings,
    async execute(call) {
      log.push(`start:${call.toolCallId}`);
      const wait = delayMs(call.toolCallId);
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }

      log.push(`end:${call.toolCallId}`);

      return toolResult({ ok: true }, `OUT-${call.toolCallId}`);
    },
    async cancel() {},
  };

  return { tools, log };
}

/** True when `later` began before `earlier` finished: the two overlapped. */
function overlaps(log: ReadonlyArray<string>, earlier: string, later: string): boolean {
  const start = log.indexOf(`start:${later}`);
  const end = log.indexOf(`end:${earlier}`);
  return start >= 0 && end >= 0 && start < end;
}

function portsOf(provider: ProviderPort, tools: ToolPort): LoopPorts {
  return {
    profile: emptyProfileLoader(),
    permission: createFakePermission("approved"),
    tools,
    provider,
  };
}

function settledIds(result: Awaited<ReturnType<typeof runTurn>>): ReadonlyArray<string> {
  return result.transcript
    .filter((item) => item.kind === "tool_result")
    .map((item) => item.toolCallId);
}

test("two calls to a tool that declares parallelSafe overlap", async () => {
  const { tools, log } = markingTools([READ_SAFE], (id) => (id === "c1" ? 40 : 0));
  const provider = scripted([askingFor(["c1", "c2"], "read_file"), STOP]);
  const result = await runTurn(portsOf(provider.port, tools), REQUEST);

  assert.equal(result.state.terminalReason, "completed");
  // Before this package every batch was executed one call at a time, so c2
  // could not have started before c1 ended.
  assert.equal(
    overlaps(log, "c1", "c2"),
    true,
    `the second read must start before the first ends; log was ${JSON.stringify(log)}`,
  );
});

test("the same two calls without the declaration stay one after the other", async () => {
  const { tools, log } = markingTools([READ_PLAIN], (id) => (id === "c1" ? 40 : 0));
  const provider = scripted([askingFor(["c1", "c2"], "read_file"), STOP]);
  const result = await runTurn(portsOf(provider.port, tools), REQUEST);

  assert.equal(result.state.terminalReason, "completed");
  // The conservative half of the contract: an undeclared tool must not be
  // overlapped just because some other tool asked to be.
  assert.equal(
    overlaps(log, "c1", "c2"),
    false,
    `an undeclared tool must run alone; log was ${JSON.stringify(log)}`,
  );
});

test("an undeclared write waits for the reads it was batched with, and the reads still overlap", async () => {
  const { tools, log } = markingTools([READ_SAFE, WRITE_PLAIN], (id) =>
    id === "w1" ? 0 : 40,
  );
  const provider = scripted([
    [
      { type: "tool_call", toolCallId: "r1", name: "read_file", arguments: { path: "a.js" } },
      { type: "tool_call", toolCallId: "r2", name: "read_file", arguments: { path: "b.js" } },
      { type: "tool_call", toolCallId: "w1", name: "write_file", arguments: { path: "c.js" } },
      { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
    ],
    STOP,
  ]);
  const result = await runTurn(portsOf(provider.port, tools), REQUEST);

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(
    overlaps(log, "r1", "r2"),
    true,
    `the two declared reads must still overlap; log was ${JSON.stringify(log)}`,
  );
  // The exclusive half: a write that ran while a read was still running would
  // be a lock that does not lock.
  assert.ok(
    log.indexOf("start:w1") > log.indexOf("end:r1") &&
      log.indexOf("start:w1") > log.indexOf("end:r2"),
    `the write must start after both reads end; log was ${JSON.stringify(log)}`,
  );
});

test("results are recorded in id order even when the calls finish the other way round", async () => {
  // The second call finishes first: it is the one with no delay.
  const { tools } = markingTools([READ_SAFE], (id) => (id === "c1" ? 40 : 0));
  const provider = scripted([askingFor(["c1", "c2"], "read_file"), STOP]);
  const result = await runTurn(portsOf(provider.port, tools), REQUEST);

  assert.equal(result.state.terminalReason, "completed");
  // Concurrency is about when the work happens, never about the order it is
  // recorded in: a journal whose order depended on which read returned first
  // could not be replayed or compared run to run.
  assert.deepEqual(settledIds(result), ["c1", "c2"]);
});
