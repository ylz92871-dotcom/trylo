import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProcessContext } from "../../../cmd/trylo/main.js";
import type { ProviderPort, ProviderRequest } from "../../ports/provider.js";
import type { JsonObject } from "../../protocol/envelope.js";
import { executeTurn, isTurnFailure } from "./host.js";
import { prepareRun, isRunFailure } from "./run-command.js";
import { createDenyAllPermission } from "./permission.js";
import { centralLearningTurnFactory } from "./central-learning-turn.js";
import { CENTRAL_LEARNING_INSTRUCTION, INDEPENDENT_CENTRAL_LEARNING_INSTRUCTION } from "./central-learning-instruction.js";

const object = (value: unknown): JsonObject => {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as JsonObject;
};

test("the same real PA first request uses independent guidance and schema while explicit legacy retains its content protocol", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-pa-mode-")), home = path.join(root, "profile");
  mkdirSync(home);
  const owned = createProcessContext(), captured: { mode: string; request: ProviderRequest }[] = [];
  const ctx = { ...owned, cwd: root, homeDir: root, env: { TRYLO_HOME: home }, stdout() {}, stderr() {} };
  const userText = "Summarize the supplied task requirements and continue my work; report a concrete learning opportunity only when relevant.";

  try {
    for (const independent of [true, false]) {
      const mode = independent ? "independent" : "legacy";
      const scaffold = await prepareRun(ctx, { sink: ctx, permissionMode: "non_interactive", options: {
        message: [], readStdin: false, provider: "fixture", session: `pa-mode-${mode}`, format: "stream-json",
        centralLearning: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 100000, maxCalls: 2, maxSteps: 2, maxPromptChars: 100000 } } });

      assert.equal(isRunFailure(scaffold), false);
      if (isRunFailure(scaffold)) throw new Error(scaffold.message);

      const requests: ProviderRequest[] = [];
      const provider: ProviderPort = { fork: () => provider, async *stream(request) {
        requests.push(request);
        yield { type: "text_delta", blockId: "answer", text: "Acknowledged the user's task." };
        yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
      } };
      const turnId = `pa-mode-${mode}`;

      try {
        assert.ok(scaffold.session);
        assert.ok(scaffold.execution);
        const source = independent ? scaffold : { ...scaffold, centralLearningOnlyIssueId: "issue:explicit-legacy" };
        const result = await executeTurn({ text: userText, sessionId: scaffold.sessionId, turnId, correlationId: "same-pa-task",
          workspaceRoot: scaffold.workspaceRoot, workspaceId: scaffold.workspaceId, checkpointRoot: scaffold.checkpointRoot,
          providerId: scaffold.providerId, providerKind: scaffold.providerKind, model: scaffold.model, endpoint: scaffold.endpoint,
          apiKey: scaffold.apiKey, session: scaffold.session, execution: scaffold.execution, permission: createDenyAllPermission(),
          format: "stream-json", sink: ctx, now: ctx.now, maxIterations: 1, providerGuard: () => provider,
          collaborationLearning: { homeDir: ctx.homeDir, env: ctx.env }, centralLearning: centralLearningTurnFactory({
            ctx, scaffold: source, turnId, permissionChoice: {}, ...(independent ? { independent: true } : {}) }) });

        assert.equal(isTurnFailure(result), false, JSON.stringify(result));
        assert.equal(requests.length, 1, "only the first business request is captured");
        const request = requests[0]!;
        captured.push({ mode, request });
        assert.ok(request.messages.some(message => message.role === "user" && message.content.includes(userText)));
        const central = request.tools.find(tool => tool.name === "central_learning");
        assert.ok(central);
        const properties = object(central.parameters.properties), operations = object(properties.operation).enum;
        const instructions = request.messages.map(message => message.content).join("\n");

        if (independent) {
          assert.ok(instructions.includes(INDEPENDENT_CENTRAL_LEARNING_INSTRUCTION));
          assert.ok(!instructions.includes(CENTRAL_LEARNING_INSTRUCTION));
          assert.doesNotMatch(instructions, /complete the returned apply_known|host combines current content|PA content analysis remains/i);
          assert.deepEqual(operations, ["inspect", "read_response", "resume"]);
          assert.equal(Object.hasOwn(properties, "stageRef"), false);
          assert.match(central.description, /separate bounded public checkpoint/);
        } else {
          assert.ok(instructions.includes(CENTRAL_LEARNING_INSTRUCTION));
          assert.ok(!instructions.includes(INDEPENDENT_CENTRAL_LEARNING_INSTRUCTION));
          assert.ok(Array.isArray(operations) && operations.includes("apply_known") && operations.includes("residual_review"));
          assert.equal(Object.hasOwn(properties, "stageRef"), true);
          assert.match(central.description, /allocates\/dispatches/);
        }
      } finally { try { await scaffold.close(); } finally { await scaffold.execution?.close(); } }
    }
    if (process.env.TRYLO_PA_MODE_EVIDENCE !== undefined) writeFileSync(process.env.TRYLO_PA_MODE_EVIDENCE,
      JSON.stringify({ userText, externalCalls: 0, businessRequests: captured.length,
        captures: captured.map(({ mode, request }) => ({ mode, messages: request.messages,
          centralLearning: request.tools.find(tool => tool.name === "central_learning") })) }, null, 2));
  } finally {
    owned.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^trylo-pa-mode-/);
    rmSync(root, { recursive: true, force: true });
  }
});
