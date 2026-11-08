import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExpertConfiguration, ExpertRequest, ExpertVersion } from "../../subagent/experts/index.js";
import { createExpertLibraryHost } from "./host.js";

test("host rejects mismatched member and workspace tool context before library lookup or execution", () => {
  const host = createExpertLibraryHost({ rootDir: "unused-expert-context-contract", model: "m", maxOutputTokens: 100,
    permission: { async request() { throw new Error("No approval should be requested"); }, async awaitDecision() { throw new Error("No approval should be requested"); } },
    provider: { async *stream() { throw new Error("No model call should be started"); } },
    availableToolNames: () => [], async executeAuthorized() { throw new Error("No tool should be executed"); } });
  const input = { memberId: "memberB", runId: "run", task: "check", surface: "code" as const, catalog: [],
    parent: { model: "m", allowedTools: [], maxIterations: 5 }, signal: new AbortController().signal,
    toolContext: { memberId: "memberA", scope: "workspace" } };

  assert.throws(() => host.instantiate({ expertId: "absent" }, input), { code: "invalid_input" });
  assert.throws(() => host.instantiate({ expertId: "absent" }, { ...input,
    toolContext: { memberId: "memberB", scope: "workspaceA" }, useScope: { workspaceId: "workspaceB", taskId: "task" } }), { code: "invalid_input" });
});

test("production host composes trusted gestures, resource construction, durable save and member configuration", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "trylo-expert-host-"));
  const source = { kind: "community" as const, title: "API methods", uri: "https://docs.example.test/api", excerpt: "Inspect exported API types and verify consumer compatibility." };
  const configuration: ExpertConfiguration = { displayName: "API contracts", specialty: "TypeScript API compatibility", baseRole: "worker",
    situations: ["Exported API changes"], responsibilities: ["Inspect consumer contracts"], constraints: ["Preserve public signatures"],
    collaboration: ["Report contract evidence to reviewer"], role: { name: "worker", description: "API contract specialist" },
    toolRefs: ["runtime:read_file"], sources: [source], methods: [{ title: "Check consumers", instructions: "Inspect exported types and their consumers before suggesting changes.", sourceUris: [source.uri] }] };
  let prompts = 0;
  let modelCalls = 0;
  const options = { rootDir, model: "m", maxOutputTokens: 1000,
    permission: { async request() {
      prompts += 1;
      throw new Error("Trusted exact gestures should not prompt twice");
    }, async awaitDecision() { throw new Error("No pending permission ticket"); } },
    provider: { async *stream() {
      modelCalls += 1;
      yield { type: "text_delta" as const, blockId: "b", text: JSON.stringify(configuration) };
      yield { type: "finish" as const, reason: "stop" as const, rawReason: "stop", requiresFollowUp: false };
    } },
    availableToolNames: () => ["web_search", "web_fetch", "read_file"],
    async executeAuthorized(call: { readonly name: string }) {
      return call.name === "web_search" ? { outcome: "result" as const, value: { sources: [{ url: source.uri, title: source.title }] }, output: "Search result", truncated: false }
        : { outcome: "result" as const, value: { url: source.uri, status: 200 }, output: source.excerpt, truncated: false };
    } };

  try {
    const host = createExpertLibraryHost(options);
    const request = await host.executeUserAction({ operation: "submit", origin: "settings", instruction: "Create an API contract specialist" }) as ExpertRequest;

    assert.equal(request.state, "authorized");
    await host.execute({ operation: "build", requestId: request.requestId });
    await host.executeUserAction({ operation: "retain", requestId: request.requestId, result: { kind: "save" } });
    const reopened = createExpertLibraryHost(options);
    const versions = await reopened.execute({ operation: "query", text: "TypeScript" }) as ExpertVersion[];

    assert.equal(versions.length, 1);
    const instance = await reopened.instantiate({ expertId: versions[0]!.expertId, version: 1 }, {
      memberId: "worker-api", runId: "team-api", task: "Check API consumers", surface: "code", catalog: [],
      parent: { model: "m", allowedTools: [], maxIterations: 5 }, signal: new AbortController().signal,
      toolContext: { memberId: "worker-api", scope: "workspace-api" } });

    assert.equal(instance.identity.expertId, request.expertId);
    assert.match(instance.member.role.prompt!, /Check consumers/);
    assert.equal(instance.toolResolutions[0]?.state, "pending");
    assert.equal(prompts, 0);
    assert.equal(modelCalls, 1);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});
