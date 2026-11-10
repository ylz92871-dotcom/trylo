import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { test } from "node:test";
import { emptyProfileLoader } from "../../loop/fakes.js";
import { runTurn } from "../../loop/runner.js";
import { testScratchPath } from "../../testing/scratch.js";
import { createAllowToolsPermission, createInteractivePermission } from "../../surface/cli/permission.js";
import { projectEnvelopeSequence } from "../../surface/cli/stream-projection.js";
import { createStdioApproval } from "../../surface/cli/stdio-control.js";
import { createMediaGenerationTools } from "./index.js";

test("a generated image survives the real execution journal and CLI stream as a metadata reference", async () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=";
  const tools = createMediaGenerationTools({ workspaceRoot: mkdtempSync(testScratchPath("media-stream-")), configuration: {
    browserFallback: true, image: { enabled: true, protocol: "openai-images", endpoint: "https://provider.invalid", model: "image", apiKey: "PRIVATE_KEY" },
  }, fetch: async () => Response.json({ data: [{ b64_json: png }] }) });
  let requests = 0;
  const result = await runTurn({ tools, permission: createAllowToolsPermission(new Set(["image_generate"])), profile: emptyProfileLoader(), provider: {
    async *stream() {
      if (++requests === 1) {
        yield { type: "tool_call", toolCallId: "image", name: "image_generate", arguments: { prompt: "A scene" } };
        yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
      } else {
        yield { type: "text_delta", blockId: "answer", text: "Image saved." };
        yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
      }
    },
  } }, { sessionId: "image", turnId: "turn", correlationId: "image", text: "Create the image." });
  const stream = projectEnvelopeSequence(result.envelopes);
  const receipt = stream.find(event => event.type === "tool_result");
  assert.ok(receipt?.type === "tool_result" && receipt.generatedMedia?.[0]?.mimeType === "image/png");
  const publicBytes = JSON.stringify([result.envelopes, result.transcript, stream]);
  assert.equal(publicBytes.includes(png), false);
  assert.equal(publicBytes.includes("PRIVATE_KEY"), false);
});

for (const decision of ["allow", "deny", "transport-error"] as const) {
  test(`media generation through the real turn and stdio approval preserves ${decision}`, async () => {
    let apiCalls = 0, modelCalls = 0;
    const frames: unknown[] = [];
    const requestApproval = createStdioApproval({ now: () => 0, newId: () => "media-approval",
      stdout: line => frames.push(JSON.parse(line)),
      async readLine() {
        if (decision === "transport-error") throw new Error("host disconnected");
        return JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "media-approval",
          response: { behavior: decision } } });
      },
    });
    const tools = createMediaGenerationTools({ workspaceRoot: mkdtempSync(testScratchPath("media-permission-")),
      configuration: { browserFallback: true, video: { enabled: true, protocol: "ark-video", endpoint: "https://provider.invalid",
        model: "configured-model", apiKey: "private-key" } },
      fetch: async () => { apiCalls++; return Response.json({ id: "remote-video-task" }); },
    });
    const permission = createInteractivePermission({ prompt() {}, async readLine() { throw new Error("stdio owns input"); }, requestApproval });
    const result = await runTurn({ tools, permission, profile: emptyProfileLoader(), provider: {
      async *stream(request) {
        if (++modelCalls === 1) {
          yield { type: "tool_call", toolCallId: "video-create", name: "video_generate", arguments: { prompt: "A calm scene" } };
          yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
        } else {
          const reply = request.messages.find(item => item.role === "tool" && item.toolCallId === "video-create");
          assert.ok(reply, "the exact tool result must reach the next model request");
          if (decision === "allow") assert.match(reply.content, /job_id/);
          else assert.match(reply.content, /did not run/);
          yield { type: "text_delta", blockId: "answer", text: "The generation status is recorded." };
          yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
        }
      },
    } }, { sessionId: "media", turnId: decision, correlationId: "test", text: "Generate a video." });
    assert.equal(apiCalls, decision === "allow" ? 1 : 0);
    assert.equal(modelCalls, 2);
    assert.equal(result.state.terminalReason, "completed");
    assert.equal(frames.length > 0, true);
  });
}
