import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProcessContext } from "../../../cmd/trylo/main.js";
import { readRuntimeIntent, runtimeScopePaths, tryAcquireRuntimeOwner } from "../../adapters/central-learning-runtime/files.js";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { centralBudgetProjection } from "../../learning/control/central-budget-state.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { CentralDeliberationRequest } from "../../learning/central/runtime/contracts.js";
import { createCentralAccountingFundingAtRoot } from "../../integration/learning-content/central-accounting-funding.js";
import { createCentralModelDeliberation } from "../../integration/central-learning/deliberation.js";
import { centralGenerationLimits } from "../../integration/central-learning/deliberation-generation.js";
import { readLearningChangeWire } from "../../integration/central-learning/change-test-support.js";
import type { ProviderEvent, ProviderPort, ProviderRequest } from "../../ports/provider.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import { handleCentralLearning } from "./commands-central-learning.js";
import { parseCentralLearning } from "./args-central-learning.js";
import { isCentralRuntimeConfiguration, type CentralRuntimeConfiguration } from "./central-runtime-configuration.js";
import { methodBoardRoot } from "./learning-sink.js";

test("public generation policy persists and resets without changing paused authority or unknown bills, and binds the actual local wire", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-runtime-generation-")), home = path.join(root, "profile"), workspace = path.join(root, "workspace");

  mkdirSync(home);
  mkdirSync(workspace);
  const owned = createProcessContext(), ctx = { ...owned, cwd: workspace, homeDir: root, env: { TRYLO_HOME: home }, stdout() {}, stderr() {} };
  const paths = runtimeScopePaths(home, workspace), boardRoot = methodBoardRoot(ctx.homeDir, ctx.env), at = "2026-11-06T00:00:00.000Z";
  const original: CentralRuntimeConfiguration = { schemaVersion: 1, providerId: "fixture", model: "local-generation-model",
    endpointHash: contentHashOf(""), accountId: "fixture-account", reasoningEffort: "low", workspaceId: "workspace:generation", userLearning: false,
    thoughtMaxTokens: 64000, allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 12000, maxCalls: 3, maxSteps: 3, maxPromptChars: 100000 },
    rootRef: { budgetId: "budget:original-generation", scope: workspace, openedSequence: 1, authorizationRef: "authorization:original-generation" } };
  const lease = tryAcquireRuntimeOwner(paths);
  assert.ok(lease.ok);
  assert.ok(lease.value.writeIntent({ schemaVersion: 1, homeRoot: paths.homeRoot, workspaceRoot: paths.workspaceRoot,
    enabled: false, recoveryPolicy: "paused", configuration: original, wakeSequence: 7, consumedSequence: 6,
    wakeReason: "original_source", sourceRefs: ["source:original"] }).ok);
  lease.value.close();

  try {
    const initial = readRuntimeIntent(paths);
    assert.ok(initial.ok && initial.value);
    const rootRef = original.rootRef!;
    const opened = await withBoardWriter(boardRoot, store => store.apply({ type: "coordinate_learning", commandId: "generation:open", issuedAt: at,
      action: { kind: "open_budget", expectedSequence: 0, budget: { schemaVersion: 1, budgetId: rootRef.budgetId, scope: workspace,
        unit: "total_model_tokens", limits: { tokens: 200000, calls: 10, steps: 10 }, authorizationRef: rootRef.authorizationRef } } }));
    assert.ok(opened.ok);
    const owner = { kind: "user_learning", ownerId: workspace } as const;

    for (const action of [
      { kind: "reserve_budget_usage", budgetId: rootRef.budgetId, scope: workspace, owner, reservationId: "generation:unknown", maxTokens: 80, expectedSequence: 1 },
      { kind: "settle_budget_usage", budgetId: rootRef.budgetId, scope: workspace, owner, reservationId: "generation:unknown", usage: { kind: "unknown", reason: "controlled_missing_bill" } },
    ] as const) {
      assert.ok((await withBoardWriter(boardRoot, store => store.apply({ type: "coordinate_learning", commandId: `generation:${action.kind}`, issuedAt: at, action }))).ok);
    }

    const before = await createBoardReader(boardRoot).load();
    assert.ok(before.ok);
    const parsed = parseCentralLearning(["runtime", "-"]);
    assert.ok(parsed.kind === "learn" && parsed.options.subsystem === "central");
    const command = parsed.options;
    const run = async (generationLimits: unknown) => {
      const lines: string[] = [];
      const code = await handleCentralLearning({ ...ctx, stdout: value => lines.push(value), readStdin: async () =>
        JSON.stringify({ workspaceRoot: workspace, action: "configure", patch: { generationLimits } }) }, command);
      assert.equal(lines.length, 1);
      return { code, reply: JSON.parse(lines[0]!) as Record<string, unknown> };
    };
    const policy = { defaultMaxOutputTokens: 32768, maxOutputTokens: 32768 };
    const configured = await run(policy);
    assert.equal(configured.code, EXIT_CODES.OK);
    assert.equal(configured.reply.enabled, false);
    const explicit = readRuntimeIntent(paths);
    assert.ok(explicit.ok && explicit.value);
    const saved = explicit.value.configuration;
    assert.ok(isCentralRuntimeConfiguration(saved));
    assert.ok(saved.generationLimits);
    const generationLimits = saved.generationLimits;
    assert.deepEqual(generationLimits, policy);
    assert.deepEqual({ ...explicit.value, configuration: original }, initial.value, "stop, pause, root, wake and connection survive the public patch");
    const afterConfigure = await createBoardReader(boardRoot).load();
    assert.ok(afterConfigure.ok);
    assert.deepEqual(afterConfigure.state, before.state);
    const invalid = await run({ defaultMaxOutputTokens: 32769, maxOutputTokens: 32768 });
    assert.equal(invalid.code, EXIT_CODES.USAGE);
    assert.equal(invalid.reply.reason, "runtime_configuration_patch_invalid");
    assert.deepEqual(readRuntimeIntent(paths), explicit);
    const funding = createCentralAccountingFundingAtRoot({ boardRoot, scope: workspace, budgetId: rootRef.budgetId,
      owner: { kind: "central_deliberation", ownerId: "central:generation" }, enabled: () => true, now: () => at });
    const wires: ProviderRequest[] = [];
    const provider = (): ProviderPort => ({ fork: () => provider(), async *stream(wire): AsyncGenerator<ProviderEvent> {
      wires.push(wire);
      const view = readLearningChangeWire(wire);
      yield { type: "tool_call", toolCallId: `decision:${wires.length}`, name: wire.tools[0]!.name,
        arguments: { checkpoint: view.checkpoint, changes: [], explanation: "No additional computation is selected." } };
      yield { type: "usage", usage: { mode: "snapshot", inputTokens: 10, outputTokens: 10, totalTokens: 20,
        cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };
      yield { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true };
    } });
    const input = async (configuration: CentralRuntimeConfiguration, operationId: string): Promise<CentralDeliberationRequest> => {
      const current = await funding.inspect();
      assert.ok(current.ok);

      return { schemaVersion: 1, scope: workspace, budgetId: rootRef.budgetId, stateRef: "state:generation", boardSequence: current.boardSequence,
        configuration: { schemaVersion: 1, configurationRef: `config:${operationId}`, authorizationRef: rootRef.authorizationRef,
          allowance: configuration.allowance,
          ...(configuration.thoughtMaxTokens === undefined ? {} : { thoughtMaxTokens: configuration.thoughtMaxTokens }),
          ...(configuration.generationLimits === undefined ? {} : { generationLimits: configuration.generationLimits }) },
        resources: { boardSequence: current.boardSequence, budgetId: rootRef.budgetId, limits: current.projection.budget.limits,
          occupied: current.projection.occupied, available: current.projection.available, status: current.projection.status, holdReason: current.projection.holdReason ?? null },
        state: { schemaVersion: 1, scope: workspace, intents: [], completed: [], running: [], materials: [], consumedSourceRefs: [] },
        materials: [], organization: [], opportunities: [], operation: { kind: "think", operationId, purpose: "Review the original uncertainty.",
          expectedChange: "Choose a useful bounded next step.", sourceRefs: [] } };
    };
    const model = createCentralModelDeliberation({ provider: provider(), model: saved.model, funding, outputMode: "tool", generationLimits });
    const selected = await input(saved, "operation:generation-32768"), beforePrepare = await funding.inspect();
    assert.ok(model.prepareDelivery);
    const prepared = await model.prepareDelivery(selected, new AbortController().signal);

    assert.deepEqual(prepared.configuration.generationLimits, policy);
    assert.equal(wires.length, 0);
    assert.deepEqual(await funding.inspect(), beforePrepare);
    await model.deliberate(prepared, new AbortController().signal);
    assert.equal(wires[0]?.maxOutputTokens, 32768);
    const bill = model.receipts()[0];
    assert.ok(bill);
    assert.ok(bill.maxTokens > 32768 && bill.maxTokens <= 64000);
    const envelope: { thisComputation: { maxTokens: number } } = JSON.parse(wires[0]!.messages.at(-1)!.content);

    assert.equal(envelope.thisComputation.maxTokens, bill.maxTokens, "the input-plus-output quote is the actual original reservation");
    const beforeRejected = await funding.inspect(), excessive = await input(saved, "operation:generation-too-large");

    await assert.rejects(model.deliberate({ ...excessive, operation: { ...excessive.operation, kind: "think", maxOutputTokens: 32769 } },
      new AbortController().signal), /central_deliberation_generation_capability_invalid/);
    assert.equal(wires.length, 1);
    assert.deepEqual(await funding.inspect(), beforeRejected, "numeric serialization legality never overrides the host cap");
    const technical = createCentralModelDeliberation({ provider: provider(), model: saved.model, funding, outputMode: "tool",
      generationLimits, contextWindow: 32768 });

    assert.ok(technical.prepareDelivery);
    await assert.rejects(technical.prepareDelivery(await input(saved, "operation:generation-context-too-small"), new AbortController().signal),
      /central_deliberation_context_capacity/);
    assert.equal(wires.length, 1);
    assert.deepEqual(await funding.inspect(), beforeRejected,
      "a declared total context ceiling includes input plus generation and never clamps or buys the chosen output");
    const beforeReset = await createBoardReader(boardRoot).load();
    assert.ok(beforeReset.ok);
    const reset = await run(null);
    assert.equal(reset.code, EXIT_CODES.OK);
    assert.equal(reset.reply.enabled, false);
    const legacy = readRuntimeIntent(paths);
    assert.ok(legacy.ok && legacy.value);
    assert.deepEqual(legacy.value, initial.value);
    assert.equal(Object.hasOwn(legacy.value.configuration, "generationLimits"), false);
    const afterReset = await createBoardReader(boardRoot).load();
    assert.ok(afterReset.ok);
    assert.deepEqual(afterReset.state, beforeReset.state);
    const old = legacy.value.configuration;
    assert.ok(isCentralRuntimeConfiguration(old));
    assert.deepEqual(centralGenerationLimits(), { defaultMaxOutputTokens: 8192, maxOutputTokens: 16384 });
    const legacyModel = createCentralModelDeliberation({ provider: provider(), model: old.model, funding, outputMode: "tool" });

    await legacyModel.deliberate(await input(old, "operation:generation-legacy"), new AbortController().signal);
    assert.equal(wires[1]?.maxOutputTokens, 8192);
    const final = await createBoardReader(boardRoot).load();
    assert.ok(final.ok);
    const projection = centralBudgetProjection(final.state, rootRef.budgetId);
    assert.ok(projection);
    const unknown = projection.budget.accounting?.find(row => row.reservationId === "generation:unknown");

    assert.ok(unknown?.state === "settled");
    assert.equal(unknown.usage.kind, "unknown");
    assert.equal(unknown.maxTokens, 80);
    assert.deepEqual(projection.occupied, { tokens: 120, calls: 3, steps: 3 });
    assert.equal(existsSync(paths.locatorPath), false, "configuration maintenance never launches an owner");
  } finally {
    owned.close();
    assert.equal(path.dirname(root), tmpdir());
    assert.match(path.basename(root), /^trylo-runtime-generation-/);
    rmSync(root, { recursive: true, force: true });
  }
});
