import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "./args.js";
import { createStdioApproval, stdioAnswer, stdioPrompt } from "./stdio-control.js";

test("stdio requires explicit stream output and never accepts prompt argv", () => {
  for (const args of [
    ["run", "--permission-prompt-tool", "stdio", "-"],
    ["run", "--format", "stream-json", "--permission-prompt-tool", "stdio", "secret prompt"],
    ["run", "--format", "stream-json", "--permission-prompt-tool", "unknown", "-"],
  ]) assert.equal(parseArgs(args).kind, "error");
});

test("stdio only accepts user text, not attachments or assistant frames", () => {
  assert.equal(stdioPrompt('{"type":"user","message":{"role":"user","content":"hello"}}'), "hello");
  assert.equal(stdioPrompt('{"type":"user","message":{"role":"assistant","content":"hello"}}'), undefined);
  assert.equal(stdioPrompt('{"type":"user","message":{"role":"user","content":[{"type":"image"}]}}'), undefined);
});

test("an approval requires the current request id and a known decision", () => {
  const response = (id: string, behavior: string) => JSON.stringify({ type: "control_response", response: {
    subtype: "success", request_id: id, response: { behavior, updatedInput: { path: "different.txt" } },
  } });

  assert.equal(stdioAnswer(response("other", "allow"), "pending"), undefined);
  assert.equal(stdioAnswer(response("pending", "unknown"), "pending"), undefined);
  assert.deepEqual(stdioAnswer(response("pending", "allow"), "pending"), { resolution: "approved", scope: "once" });
  assert.equal(stdioAnswer("not json", "pending"), undefined);
});

test("a late approval is expired even when it has the correct request id", async () => {
  let now = 0;
  const frames: Array<Record<string, unknown>> = [];
  const ctx = { now: () => now, newId: () => "pending", stdout: (line: string) => frames.push(JSON.parse(line) as Record<string, unknown>),

    readLine: async () => {
      now = 600_000;
      return '{"type":"control_response","response":{"subtype":"success","request_id":"pending","response":{"behavior":"allow"}}}';
    },
  };
  const result = await createStdioApproval(ctx)({ toolCallId: "call", name: "write_file", arguments: { path: "proof.txt" }, pattern: "call" });

  assert.equal(result.resolution, "expired");
  assert.equal(frames[0]?.expires_at, 600_000);
  assert.equal(frames[1]?.type, "control_cancel_request");
});
