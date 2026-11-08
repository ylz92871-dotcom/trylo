import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "./args.js";
import { resolveRequestOptions } from "./run-request-options.js";
import { createOpenAiCompatibleProvider } from "../../adapters/provider/openai-compatible.js";
import { createWarmRegistry } from "../../adapters/provider/warm.js";
import { buildProvider } from "./provider-build.js";
import { createDenyAllPermission } from "./permission.js";

test("a run can explicitly request reasoning effort without changing its model", () => {
  assert.deepEqual(parseArgs(["run", "--reasoning-effort=high", "work"]), {
    kind: "run", options: { message: ["work"], readStdin: false, reasoningEffort: "high" },
  });
});

test("chat wire sends the requested effort and leaves the default body unchanged", async () => {
  const bodies: Record<string, unknown>[] = [];
  const config = { model: "model", endpoint: "https://example.test/chat/completions", apiKey: "fixture-key",

    fetchImpl: async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response('data: {"choices":[{"index":0,"delta":{"content":"READY"},"finish_reason":"stop"}]}\n\n',
        { headers: { "Content-Type": "text/event-stream" } });
    } };
  const highConfig = { ...config, reasoningEffort: "high" as const };

  for (const provider of [createOpenAiCompatibleProvider(config), createOpenAiCompatibleProvider(highConfig)]) {
    for await (const event of provider.stream({ attemptId: "a", model: "model", messages: [{ role: "user", content: "hello" }], tools: [] }, new AbortController().signal)) {
      assert.notEqual(event.type, "error");
    }
  }

  assert.equal(Object.hasOwn(bodies[0]!, "reasoning_effort"), false);
  assert.equal(bodies[1]?.reasoning_effort, "high");
});

test("resolved request snapshots carry explicit reasoning effort across a connection switch", () => {
  const options = { message: [], readStdin: false, reasoningEffort: "high" as const };
  const resolved = resolveRequestOptions({ readFile: () => undefined }, options, { model: "model", declaredModels: [] });
  assert.deepEqual(resolved, { reasoningEffort: "high" });
});

test("warm adapters do not reuse a different reasoning effort", () => {
  const warm = createWarmRegistry();
  const input = { providerId: "openai-compatible", model: "model", endpoint: "https://example.test/chat/completions",
    apiKey: "fixture-key", workspaceRoot: process.cwd(), permission: createDenyAllPermission(), warm,
    reasoningEffort: "high" as const };
  const high = buildProvider(input);
  const noneInput = { ...input, reasoningEffort: "none" as const };
  const none = buildProvider(noneInput);

  assert.notEqual(high, none);
  assert.equal(warm.stats().builds, 2);
});

test("an unsupported wire refuses effort rather than silently ignoring it", () => {
  const input = { providerId: "fixture", model: "model", endpoint: "", apiKey: undefined,
    workspaceRoot: process.cwd(), permission: createDenyAllPermission(), reasoningEffort: "high" as const };
  const result = buildProvider(input);
  assert.ok("code" in result);
  if ("code" in result) assert.equal(result.code, "unsupported_reasoning_effort");
});
