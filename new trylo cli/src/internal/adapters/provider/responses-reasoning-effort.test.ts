import assert from "node:assert/strict";
import { test } from "node:test";
import { buildResponsesBody } from "./responses.js";
import { buildProvider } from "../../surface/cli/provider-build.js";
import { createDenyAllPermission } from "../../surface/cli/permission.js";
import { parseArgs } from "../../surface/cli/args.js";

const request = { attemptId: "attempt", model: "model", messages: [{ role: "user" as const, content: "hello" }], tools: [] };
const base = { endpoint: "https://example.test/v1/responses", model: "model", apiKey: "local-test-only" };

test("Responses effort is independent of the public summary and absent by default", () => {
  const explicit = { ...base, reasoningEffort: "high" as const, reasoningSummary: "auto" as const };
  const sent = buildResponsesBody(explicit, request) as Record<string, unknown>;
  assert.deepEqual(sent.reasoning, { effort: "high", summary: "auto" });
  const effortOnly = { ...base, reasoningEffort: "low" as const };
  assert.deepEqual((buildResponsesBody(effortOnly, request) as Record<string, unknown>).reasoning, { effort: "low" });
  assert.equal(Object.hasOwn(buildResponsesBody(base, request) as object, "reasoning"), false);
});

test("a declared Responses provider accepts explicit effort through the production factory", () => {
  const provider = buildProvider({ providerId: "responses-test", providerKind: "openai-responses", ...base,
    workspaceRoot: process.cwd(), permission: createDenyAllPermission(), reasoningEffort: "high" });
  assert.ok("stream" in provider, "Responses must apply the selected effort rather than reject it");
});

test("CLI accepts minimal and xhigh without inventing a global effort default", () => {
  for (const effort of ["minimal", "xhigh"]) {
    assert.deepEqual(parseArgs(["run", `--reasoning-effort=${effort}`, "hello"]), {
      kind: "run", options: { message: ["hello"], readStdin: false, reasoningEffort: effort },
    });
  }
});
