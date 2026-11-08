import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderEvent, ProviderPort } from "../ports/provider.js";
import type { ToolBinding, ToolPort } from "../ports/tools.js";
import type { ExecutionProgressPort, ProgressWriteOutcome } from "../ports/execution-progress.js";
import { createFakePermission, echoBinding, emptyProfileLoader, toolResult } from "./fakes.js";
import { runTurn, type LoopPorts } from "./runner.js";

/**
 * Durable intent for mutating tools (WP05 WP05.3, OPEN-WP05-2).
 *
 * The port contract (`ports/execution-progress.ts`) already requires that
 * `issue` acknowledge durability before a tool begins; this test proves the
 * loop honours it. A turn killed after the issue but before the settle must
 * leave the intent in the journal — that is what makes post-crash
 * reconciliation (WP01.3) possible instead of a guess about what ran.
 *
 * The verdict is read off one shared timeline: the progress port and the
 * tools write into the same log, so "before" means before. For every call,
 * `flush` < `issue` < `start`, and the whole issue phase precedes the whole
 * execution phase — a kill in between leaves intents without effects, which
 * is exactly the state `reconcileRequired` describes.
 */

const REQUEST = { sessionId: "s", turnId: "t", correlationId: "c", text: "run it" };
const STOP: ReadonlyArray<ProviderEvent> = [
  { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false },
];

function scripted(script: ReadonlyArray<ReadonlyArray<ProviderEvent>>): ProviderPort {
  let index = 0;
  return {
    async *stream() {
      const events = script[index] ?? [];
      index += 1;
      for (const event of events) yield event;
    },
  };
}

const WRITE = echoBinding({ name: "write_file", sideEffect: "workspace_write", needsApproval: false });

function timelinePorts(provider: ProviderPort, bindings: ReadonlyArray<ToolBinding>): { readonly ports: LoopPorts; readonly log: string[] } {
  const log: string[] = [];
  const ok: ProgressWriteOutcome = { ok: true };
  const progress: ExecutionProgressPort = {
    async flush() {
      log.push("flush");
      return ok;
    },
    async issue(key: string) {
      log.push(`issue:${key}`);
      return ok;
    },
    async settle(key: string) {
      log.push(`settle:${key}`);
      return ok;
    },
  };
  const tools: ToolPort = {
    snapshot: () => bindings,
    async execute(call) {
      log.push(`start:${call.toolCallId}`);
      return toolResult({ ok: true }, `OUT-${call.toolCallId}`);
    },
    async cancel() {},
  };

  return {
    ports: { profile: emptyProfileLoader(), permission: createFakePermission("approved"), tools, provider, progress },
    log,
  };
}

test("every issue is flushed first and executed after", async () => {
  const provider = scripted([
    [
      { type: "tool_call", toolCallId: "w1", name: "write_file", arguments: { path: "a.js" } },
      { type: "tool_call", toolCallId: "w2", name: "write_file", arguments: { path: "b.js" } },
      { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
    ],
    STOP,
  ]);
  const { ports, log } = timelinePorts(provider, [WRITE]);
  const result = await runTurn(ports, REQUEST);

  assert.equal(result.state.terminalReason, "completed");

  const positionOf = (mark: string): number => log.indexOf(mark);
  const issues = log.filter((mark) => mark.startsWith("issue:"));

  assert.ok(issues.length >= 2, `expected issues for both calls; timeline was ${JSON.stringify(log)}`);

  // Adjacent, not merely earlier: the flush is what makes THIS issue durable,
  // and a flush from three phases ago says nothing about this declaration. A
  // turn start flush elsewhere in the timeline must not satisfy this.
  for (const issue of issues) {
    const at = positionOf(issue);
    assert.equal(log[at - 1], "flush", `${issue} was not immediately preceded by a flush; timeline was ${JSON.stringify(log)}`);
  }

  // Every execution starts after every issue: a kill in between leaves
  // declared-but-unexecuted intents, never undeclared effects.
  const lastIssue = Math.max(...issues.map(positionOf));

  for (const id of ["w1", "w2"]) {
    const start = positionOf(`start:${id}`);
    assert.ok(start > lastIssue, `tool ${id} started before the issue phase ended; timeline was ${JSON.stringify(log)}`);
  }
});
