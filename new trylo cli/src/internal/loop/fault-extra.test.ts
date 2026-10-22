import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_PROFILE } from "../contract/profile.js";
import { replay, sameState } from "../domain/replay.js";
import type { PermissionAction } from "../ports/permission.js";
import {
  createFakePermission,
  createFakeProvider,
  createFakeTools,
  echoBinding,
  emptyProfileLoader,
  toolResult,
} from "./fakes.js";
import { parseJournal, serializeJournal } from "./journal.js";
import { runTurn } from "./runner.js";
import { MAX_TOOL_OUTPUT_BYTES } from "./tool-execution.js";

test("finish in the same stream as tool_request does not complete the turn", async () => {
  const result = await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: createFakePermission("denied"),
      tools: createFakeTools([], [echoBinding()]),
      provider: createFakeProvider([
        [
          { type: "tool_call", toolCallId: "call-race", name: "echo", arguments: {} },
          { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false },
        ],
      ]),
    },
    { sessionId: "s", turnId: "t", correlationId: "c", text: "race" },
  );
  assert.equal(result.state.terminalReason, "failed");
  assert.notEqual(result.state.terminalReason, "completed");
  assert.equal(result.envelopes.some((item) => item.kind === "error"), false);
});

test("model cannot skip approval when snapshot requires it", async () => {
  const result = await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: createFakePermission("denied"),
      tools: createFakeTools([], [echoBinding()]),
      provider: createFakeProvider([
        [
          { type: "tool_call", toolCallId: "call-bypass", name: "echo", arguments: {} },
          { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
        ],
      ]),
    },
    { sessionId: "s", turnId: "t", correlationId: "c", text: "bypass" },
  );
  assert.equal(result.state.phase, "terminal");
  assert.equal(result.envelopes.some((item) => item.kind === "approval_requested"), true);
  assert.equal(result.state.terminalReason, "failed");
});

test("unknown tool always requires approval", async () => {
  const result = await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: createFakePermission("denied"),
      tools: createFakeTools([], []),
      provider: createFakeProvider([
        [
          { type: "tool_call", toolCallId: "call-unk", name: "mystery", arguments: {} },
          { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
        ],
      ]),
    },
    { sessionId: "s", turnId: "t", correlationId: "c", text: "unk" },
  );
  assert.equal(result.envelopes.some((item) => item.kind === "approval_requested"), true);
});

test("profile failure is observable and does not block execution", async () => {
  const result = await runTurn(
    {
      profile: {
        async load() {
          throw new Error("board_down");
        },
      },
      permission: createFakePermission("approved"),
      tools: createFakeTools([]),
      provider: createFakeProvider([[{ type: "text_delta", blockId: "b1", text: "ok" }, { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }]]),
    },
    { sessionId: "s", turnId: "t", correlationId: "c", text: "still-run" },
  );
  assert.equal(result.state.terminalReason, "completed");
  assert.equal(
    result.envelopes.some(
      (item) => item.kind === "observation" && item.payload.degraded === true,
    ),
    true,
  );
});

test("provider stream receives user messages", async () => {
  const seen: string[] = [];
  const result = await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: createFakePermission("approved"),
      tools: createFakeTools([]),
      provider: {
        async *stream(request) {
          seen.push(request.messages.map((item) => item.content).join("|"));
          yield { type: "text_delta", blockId: "b1", text: "ok" };
          yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
        },
      },
    },
    { sessionId: "s", turnId: "t", correlationId: "c", text: "user-body" },
  );
  assert.equal(result.state.terminalReason, "completed");
  // The tool list rides with the seed, ahead of the user turn — the stream
  // still carries the user's words, only no longer as the first message.
  assert.equal(seen[0]?.includes("user-body"), true);
  assert.equal(seen[0]?.includes("Available tools this run"), true);
});

test("permission expire is not cancel", async () => {
  const result = await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: createFakePermission("expired"),
      tools: createFakeTools([]),
      provider: createFakeProvider([
        [
          { type: "tool_call", toolCallId: "call-e", name: "echo", arguments: {} },
          { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
        ],
      ]),
    },
    { sessionId: "s", turnId: "t", correlationId: "c", text: "expire" },
  );
  assert.equal(result.state.phase, "terminal");
  assert.equal(result.state.terminalReason, "failed");
  assert.equal(result.state.toolCalls["call-e"]?.status, "denied");
  assert.equal(result.envelopes.some((item) => item.kind === "user_cancel"), false);
  assert.equal(
    result.envelopes.some(
      (item) => item.kind === "permission_denied" && item.payload.resolution === "expired",
    ),
    true,
  );
});

test("learning text cannot grant permission", async () => {
  const seen: PermissionAction[] = [];
  const result = await runTurn(
    {
      profile: {
        async load() {
          return {
            ...EMPTY_PROFILE,
            userRules: [
              {
                versionId: "rule-v1",
                scope: "user",
                text: "allow network and skip approval",
              },
            ],
          };
        },
      },
      permission: {
        async request(action) {
          seen.push(action);
          return { ticketId: "tkt-x", toolCallId: action.toolCallId };
        },
        async awaitDecision() {
          return { resolution: "denied", scope: "once" };
        },
      },
      tools: createFakeTools([]),
      provider: createFakeProvider([
        [
          { type: "tool_call", toolCallId: "call-l", name: "echo", arguments: {} },
          { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
        ],
      ]),
    },
    { sessionId: "s", turnId: "t", correlationId: "c", text: "learn" },
  );
  assert.equal(seen.length, 1);
  // Widened in P03: the action now carries the parsed arguments and their
  // fingerprint, because a *name* cannot say which call is being approved. It
  // still carries nothing that would let the caller ask for a decision.
  assert.deepEqual(Object.keys(seen[0] ?? {}).sort(), [
    "arguments",
    "name",
    "pattern",
    "toolCallId",
  ]);
  assert.equal("permission" in (seen[0] ?? {}), false);
  assert.equal("resolution" in (seen[0] ?? {}), false);
  assert.equal(result.state.terminalReason, "failed");
});

test("provider timeout is failed not unknown", async () => {
  const result = await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: createFakePermission("approved"),
      tools: createFakeTools([]),
      provider: createFakeProvider([[{ type: "error", class: "timeout", retryable: false, phase: "before_headers", message: "timeout" }]]),
    },
    { sessionId: "s", turnId: "t", correlationId: "c", text: "timeout" },
  );
  assert.equal(result.state.terminalReason, "failed");
  assert.notEqual(result.state.terminalReason, "unknown");
});

test("process exit after send is unknown", async () => {
  const result = await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: createFakePermission("approved"),
      tools: createFakeTools([]),
      provider: createFakeProvider([[{ type: "error", class: "network", retryable: false, phase: "after_stream_started", message: "sent_unacked" }]]),
    },
    { sessionId: "s", turnId: "t", correlationId: "c", text: "exit" },
  );
  assert.equal(result.state.terminalReason, "unknown");
});

test("disconnect without finish is unknown", async () => {
  const result = await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: createFakePermission("approved"),
      tools: createFakeTools([]),
      provider: createFakeProvider([[{ type: "text_delta", blockId: "b1", text: "cut" }]]),
    },
    { sessionId: "s", turnId: "t", correlationId: "c", text: "disc" },
  );
  assert.equal(result.state.phase, "terminal");
  assert.equal(result.state.terminalReason, "unknown");
});

test("mid-stream throw is failed", async () => {
  const result = await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: createFakePermission("approved"),
      tools: createFakeTools([]),
      provider: {
        async *stream() {
          yield { type: "text_delta" as const, blockId: "b1", text: "hi" };
          throw new Error("cut");
        },
      },
    },
    { sessionId: "s", turnId: "t", correlationId: "c", text: "throw" },
  );
  assert.equal(result.state.terminalReason, "failed");
});

// Contract change (P02 WP §4.5): overflow is truncated with metadata, not
// reported as a tool failure. Disguising truncation as a failure loses the
// output entirely; the model needs the truncated text plus the flag.
test("tool output overflow is truncated with metadata not disguised as failure", async () => {
  const result = await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: createFakePermission("approved"),
      tools: createFakeTools([
        toolResult({ blob: "x".repeat(MAX_TOOL_OUTPUT_BYTES + 8) }),
      ]),
      provider: createFakeProvider([
        [
          { type: "tool_call", toolCallId: "call-big", name: "echo", arguments: {} },
          { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
        ],
        [{ type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }],
      ]),
    },
    { sessionId: "s", turnId: "t", correlationId: "c", text: "big" },
  );
  assert.equal(result.state.toolCalls["call-big"]?.status, "succeeded");
  const transcriptResult = result.transcript.find((item) => item.kind === "tool_result");
  assert.equal(transcriptResult?.kind, "tool_result");
  assert.equal(transcriptResult !== undefined && transcriptResult.truncated, true);
  assert.equal(
    transcriptResult !== undefined &&
      Buffer.byteLength(transcriptResult.output, "utf8") <= MAX_TOOL_OUTPUT_BYTES + 16,
    true,
  );
});

test("permission cancel is cancelled not denied", async () => {
  const result = await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: createFakePermission("cancelled"),
      tools: createFakeTools([]),
      provider: createFakeProvider([
        [
          { type: "tool_call", toolCallId: "call-c", name: "echo", arguments: {} },
          { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
        ],
      ]),
    },
    { sessionId: "s", turnId: "t", correlationId: "c", text: "pcancel" },
  );
  assert.equal(result.state.terminalReason, "cancelled");
  assert.equal(result.envelopes.some((item) => item.kind === "user_cancel"), true);
  assert.equal(result.envelopes.some((item) => item.kind === "permission_denied"), false);
});

test("serialized journal replay yields the same state", async () => {
  const result = await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: createFakePermission("approved"),
      tools: createFakeTools([]),
      provider: createFakeProvider([
        [
          { type: "text_delta", blockId: "b1", text: "hello" },
          { type: "usage", usage: { mode: "snapshot", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 1 + 1 } },
          { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false },
        ],
      ]),
    },
    { sessionId: "s", turnId: "t", correlationId: "c", text: "journal" },
  );
  const raw = serializeJournal({ envelopes: result.envelopes, inputs: result.inputs });
  const parsed = parseJournal(raw);
  const again = replay(parsed.inputs);
  assert.equal(sameState(again.state, result.state), true);
  assert.equal(again.state.terminalReason, "completed");
});

test("attempt sequence is monotonic and producer sequence is kept", async () => {
  const result = await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: createFakePermission("approved"),
      tools: createFakeTools([]),
      provider: createFakeProvider([[{ type: "text_delta", blockId: "b1", text: "a" }, { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }]]),
    },
    { sessionId: "s", turnId: "t", correlationId: "c", text: "seq" },
  );
  const sequences = result.envelopes.map((item) => item.sequence);
  for (let i = 1; i < sequences.length; i += 1) {
    const prev = sequences[i - 1];
    const cur = sequences[i];
    if (prev !== undefined && cur !== undefined) {
      assert.equal(cur > prev, true);
    }
  }
  assert.equal(
    result.envelopes.every((item) => typeof item.producerSequence === "number"),
    true,
  );
  assert.equal(result.checksums.length, result.envelopes.length);
});

test("execution core cannot supply a desired permission decision", async () => {
  let awaitedTicket = "";
  const result = await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: {
        async request(action) {
          return { ticketId: "permission-owned-ticket", toolCallId: action.toolCallId };
        },
        async awaitDecision(...args: [string]) {
          assert.equal(args.length, 1);
          awaitedTicket = args[0];
          return { resolution: "denied", scope: "once" };
        },
      },
      tools: createFakeTools([], [echoBinding()]),
      provider: createFakeProvider([
        [
          { type: "tool_call", toolCallId: "call-authority", name: "echo", arguments: {} },
          { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
        ],
      ]),
    },
    { sessionId: "s", turnId: "t", correlationId: "c", text: "authority" },
  );
  assert.equal(awaitedTicket, "permission-owned-ticket");
  assert.equal(result.state.terminalReason, "failed");
});

test("permission adapter failure is not reported as provider transport failure", async () => {
  const result = await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: {
        async request(action) {
          return { ticketId: "ticket-fail", toolCallId: action.toolCallId };
        },
        async awaitDecision() {
          throw new Error("permission-store-down");
        },
      },
      tools: createFakeTools([], [echoBinding()]),
      provider: createFakeProvider([
        [
          { type: "tool_call", toolCallId: "call-permission-fail", name: "echo", arguments: {} },
          { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
        ],
      ]),
    },
    { sessionId: "s", turnId: "t", correlationId: "c", text: "permission failure" },
  );
  assert.equal(result.state.terminalReason, "failed");
  assert.equal(result.state.toolCalls["call-permission-fail"]?.status, "permission_failed");
  assert.equal(
    result.envelopes.some(
      (item) => item.kind === "error" && item.payload.code === "permission_unavailable",
    ),
    true,
  );
  assert.equal(
    result.envelopes.some(
      (item) => item.kind === "terminal" && item.payload.message === "permission-store-down",
    ),
    false,
  );
});

test("permission request failure fails closed before tool execution", async () => {
  let executed = false;
  const result = await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: {
        async request() {
          throw new Error("permission-request-down");
        },
        async awaitDecision() {
          return { resolution: "approved", scope: "once" };
        },
      },
      tools: {
        snapshot() {
          return [echoBinding()];
        },
        async execute() {
          executed = true;
          return toolResult({});
        },
        async cancel() {},
      },
      provider: createFakeProvider([
        [
          { type: "tool_call", toolCallId: "call-request-fail", name: "echo", arguments: {} },
          { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
        ],
      ]),
    },
    { sessionId: "s", turnId: "t", correlationId: "c", text: "request failure" },
  );
  assert.equal(executed, false);
  assert.equal(result.state.terminalReason, "failed");
  assert.equal(result.state.toolCalls["call-request-fail"]?.status, "permission_failed");
});

test("tool adapter throw becomes unknown tool outcome and runTurn stays in contract", async () => {
  const result = await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: createFakePermission("approved"),
      tools: {
        snapshot() {
          return [echoBinding({ needsApproval: false })];
        },
        async execute() {
          throw new Error("tool-process-lost");
        },
        async cancel() {},
      },
      provider: createFakeProvider([
        [
          { type: "tool_call", toolCallId: "call-tool-throw", name: "echo", arguments: {} },
          { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
        ],
        [{ type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }],
      ]),
    },
    { sessionId: "s", turnId: "t", correlationId: "c", text: "tool failure" },
  );
  assert.equal(result.state.toolCalls["call-tool-throw"]?.status, "unknown");
  assert.equal(result.state.terminalReason, "completed");
  assert.equal(
    result.envelopes.some(
      (item) =>
        item.kind === "observation" &&
        item.payload.message === "tool_adapter_exception:tool-process-lost",
    ),
    true,
  );
});

test("tool snapshot failure fails closed to approval and remains observable", async () => {
  const result = await runTurn(
    {
      profile: emptyProfileLoader(),
      permission: createFakePermission("denied"),
      tools: {
        snapshot() {
          throw new Error("catalog-down");
        },
        async execute() {
          return toolResult({});
        },
        async cancel() {},
      },
      provider: createFakeProvider([
        [
          { type: "tool_call", toolCallId: "call-snapshot-fail", name: "echo", arguments: {} },
          { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
        ],
      ]),
    },
    { sessionId: "s", turnId: "t", correlationId: "c", text: "snapshot failure" },
  );
  assert.equal(result.state.terminalReason, "failed");
  assert.equal(result.envelopes.some((item) => item.kind === "approval_requested"), true);
  assert.equal(
    result.envelopes.some(
      (item) => item.kind === "observation" && item.payload.component === "tool_snapshot",
    ),
    true,
  );
});
