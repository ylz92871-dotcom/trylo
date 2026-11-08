import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { EMPTY_PROFILE } from "../contract/profile.js";
import { bindProfilePort } from "../knowledge/assemble.js";
import { createIngest } from "../knowledge/ingest.js";
import { createFragmentStore } from "../knowledge/store.js";
import { createFakePermission, createFakeTools, echoBinding, toolResult } from "../loop/fakes.js";
import { runTurn } from "../loop/runner.js";

test("an explicit correction reaches the next execution boundary", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "trylo-profile-integration-"));
  try {
    const store = createFragmentStore(rootDir);

    await createIngest(store).recordCorrection("prefer concise output", "user correction");
    const seen: string[][] = [];
    const result = await runTurn(
      {
        profile: bindProfilePort(store),
        permission: createFakePermission("approved"),
        tools: createFakeTools([]),
        provider: {
          async *stream(request) {
            seen.push(request.messages.map((message) => message.content));
            yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
          },
        },
      },
      { sessionId: "s", turnId: "t-next", correlationId: "c", text: "current task" },
    );

    assert.equal(result.state.terminalReason, "completed");
    assert.match(seen[0]?.[0] ?? "", /prefer concise output/);
    assert.equal(seen[0]?.at(-1), "current task");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("a turn freezes one profile across multiple provider streams", async () => {
  let loads = 0;
  const seen: string[][] = [];
  const result = await runTurn(
    {
      profile: {
        async load() {
          loads += 1;
          return {
            ...EMPTY_PROFILE,
            snapshotId: `snap-${loads}`,
            snapshotHash: `hash-${loads}`,
            learningMode: "full" as const,
            userRules: [
              { versionId: `rule-${loads}`, scope: "user", text: `profile-${loads}` },
            ],
          };
        },
      },
      permission: createFakePermission("approved"),
      tools: createFakeTools(
        [toolResult({ ok: true })],
        [echoBinding({ needsApproval: false })],
      ),
      provider: {
        async *stream(request) {
          seen.push(request.messages.map((message) => message.content));

          if (seen.length === 1) {
            yield { type: "tool_call", toolCallId: "call-1", name: "echo", arguments: {} };
            // A stream that asked for tools still declares why it stopped.
            yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
            return;
          }

          yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
        },
      },
    },
    { sessionId: "s", turnId: "t-frozen", correlationId: "c", text: "current task" },
  );

  assert.equal(result.state.terminalReason, "completed");
  assert.equal(loads, 1);
  assert.equal(seen.length, 2);
  assert.equal(seen.every((messages) => messages[0]?.includes("profile-1")), true);
  assert.equal(seen.some((messages) => messages[0]?.includes("profile-2")), false);
});
