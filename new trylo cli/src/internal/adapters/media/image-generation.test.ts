import assert from "node:assert/strict";
import test from "node:test";
import { createImageGenerationTools, GENERATE_IMAGE_TOOL } from "./image-generation.js";
import type { ToolCallRequest } from "../../ports/tools.js";

/**
 * WP19.3 (C59) contract: no backend means no tool — not a tool that fails —
 * and a backend whose bytes are not an image fails the gate, not the model.
 */

const PNG = Uint8Array.from([
  // Structurally whole 1x1 PNG: signature + IHDR + empty IDAT + IEND.
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x00, 0x49, 0x44, 0x41,
  0x54, 0x35, 0xaf, 0x06, 0x1e, 0x00, 0x00, 0x00,
  0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60,
  0x82,
]);

function callFor(prompt: string): ToolCallRequest {
  return { toolCallId: "c1", name: GENERATE_IMAGE_TOOL, arguments: { prompt } };
}

test("without a backend the tool is absent from the catalog and refuses direct calls", async () => {
  const tools = createImageGenerationTools({});

  assert.deepEqual(tools.snapshot(), []);
  const refused = await tools.execute(callFor("a red circle"), new AbortController().signal);

  assert.equal(refused.outcome, "error");

  if (refused.outcome === "error") {
    assert.equal(refused.code, "image_generation_unavailable");
  }
});

test("an empty prompt refuses before any backend is touched", async () => {
  let calls = 0;
  const tools = createImageGenerationTools({
    backend: {
      async generate() {
        calls += 1;
        return { ok: true as const, artifact: { bytes: PNG } };
      },
    },
  });
  const refused = await tools.execute(
    { toolCallId: "c1", name: GENERATE_IMAGE_TOOL, arguments: { prompt: "  " } },
    new AbortController().signal,
  );

  assert.equal(refused.outcome, "error");

  if (refused.outcome === "error") {
    assert.equal(refused.code, "invalid_arguments");
  }

  assert.equal(calls, 0);
});

test("a backend image validates through the same guard as a local file", async () => {
  const tools = createImageGenerationTools({
    backend: {
      async generate() {
        return { ok: true as const, artifact: { bytes: PNG } };
      },
    },
  });
  const outcome = await tools.execute(callFor("a red circle"), new AbortController().signal);

  assert.equal(outcome.outcome, "result");

  if (outcome.outcome === "result") {
    assert.equal(outcome.value.mediaType, "image/png");
    assert.ok(!outcome.output.includes(outcome.value.dataUrl as string));
  }
});

test("non-image service bytes fail the gate and a denying catalog fails first", async () => {
  const tools = createImageGenerationTools({
    backend: {
      async generate() {
        return { ok: true as const, artifact: { bytes: new TextEncoder().encode("not an image") } };
      },
    },
  });
  const failed = await tools.execute(callFor("a red circle"), new AbortController().signal);

  assert.equal(failed.outcome, "error");

  if (failed.outcome === "error") {
    assert.equal(failed.code, "image_generation_failed");
  }

  const gated = createImageGenerationTools({
    backend: {
      async generate() {
        return { ok: true as const, artifact: { bytes: PNG } };
      },
    },
    catalog: { models: [{ id: "lab-7b", inputModalities: ["text"], toolKinds: ["function"] }] },
    modelId: "lab-7b",
  });
  const denied = await gated.execute(callFor("a red circle"), new AbortController().signal);

  assert.equal(denied.outcome, "error");

  if (denied.outcome === "error") {
    assert.equal(denied.code, "model_unsupported");
  }
});
