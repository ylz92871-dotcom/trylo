import assert from "node:assert/strict";
import { test } from "node:test";
import { contextFromProfile } from "./context.js";
import { EMPTY_PROFILE } from "./profile.js";

test("profile failure keeps original messages", async () => {
  const port = contextFromProfile({
    async load() {
      throw new Error("board_down");
    },
  });
  const messages = [{ role: "user" as const, content: "keep me" }];
  const assembled = await port.assemble({ taskId: "t1", messages });

  assert.equal(assembled.degraded, true);
  assert.equal(assembled.degradedReason, "board_down");
  assert.deepEqual(assembled.messages, messages);
  assert.equal(assembled.profile.snapshotId, EMPTY_PROFILE.snapshotId);
  assert.equal("permission" in assembled.profile, false);
});

test("active learned rules are versioned context and current instruction stays last", async () => {
  const port = contextFromProfile({
    async load() {
      return {
        ...EMPTY_PROFILE,
        snapshotId: "snap-active",
        snapshotHash: "hash-active",
        learningMode: "full" as const,
        userRules: [{ versionId: "rule-v1", scope: "user", text: "prefer concise output" }],
        promptPatches: [
          { versionId: "prompt-v2", scope: "project", text: "include failure evidence" },
        ],
      };
    },
  });
  const messages = [{ role: "user" as const, content: "current instruction" }];
  const assembled = await port.assemble({ taskId: "t1", messages });

  assert.equal(assembled.degraded, false);
  assert.equal(assembled.messages[0]?.role, "system");
  assert.match(assembled.messages[0]?.content ?? "", /prompt_patch:prompt-v2/);
  assert.match(assembled.messages[0]?.content ?? "", /user_rule:rule-v1/);
  assert.deepEqual(assembled.messages.at(-1), messages[0]);
});
