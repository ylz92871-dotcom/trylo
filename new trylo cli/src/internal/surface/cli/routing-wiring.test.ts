import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ReadRoutingConditions, ReadRoutingOpportunity, ReadRoutingPort, ReadRoutingRecord } from "../../ports/read-routing.js";
import { object } from "../../learning/reward/validate.js";
import { createDenyAllPermission } from "./permission.js";
import { createRunExecution } from "./run-execution-wiring.js";
import { wirePorts } from "./wiring.js";
import { methodBoardRoot } from "./learning-sink.js";
import { toolReadStrategyFor } from "./tool-read-strategy.js";

type ReadTopics = NonNullable<Parameters<typeof toolReadStrategyFor>[1]>;

test("formal all/tool modes bind and offer to the existing topic owner without running a study; the port reads real files", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "trylo-tool-read-factory-"));

  t.after(() => rm(root, { recursive: true, force: true }));
  let trials = 0, actual: ReadRoutingPort | undefined;
  const offered: ReadRoutingOpportunity[] = [];

  for (const mode of ["all", "tool"] as const) {
    const env = { TRYLO_HOME: path.join(root, mode) };
    const bound: Parameters<ReadTopics["bindReadRuntime"]>[0][] = [];
    const topics: ReadTopics = { ownsReadRouting: true,
      bindReadRuntime(runtime) { bound.push(runtime); }, offerReadOpportunity(opportunity) { offered.push(opportunity); } };
    const port = toolReadStrategyFor({ workspaceRoot: root, sessionId: `session-${mode}`, turnId: "turn", now: () => 100,
      learning: { switch: mode, homeDir: root, env } }, topics);

    assert.ok(port);
    assert.equal(bound.length, 1);
    assert.equal(typeof port.choose, "function");
    assert.equal(port.record, bound[0]!.record);
    const opportunity: ReadRoutingOpportunity = { executionId: `pending-${mode}`,
      conditions: { fileBytes: 20, range: "bounded", streaming: true }, requiredBytes: 100,

      async trial() {
        trials += 1;
        throw new Error("offer executed a trial without the central grant");
      } };

    port.offer(opportunity);
    assert.equal(offered.at(-1), opportunity);
    assert.equal(trials, 0);
    assert.equal(existsSync(methodBoardRoot(root, env)), false, "factory/bind/offer must not create a Board or dispatch work");
    actual = port;
  }

  assert.ok(actual);
  await writeFile(path.join(root, "source.txt"), "first\nsecond\nthird\n");
  const execution = createRunExecution(root, { shellIsolation: "host", homeDir: root, env: { TRYLO_HOME: path.join(root, "tool") } });

  t.after(() => execution.close());
  const wired = wirePorts({ providerId: "fixture", model: "default", endpoint: "", apiKey: undefined,
    workspaceRoot: root, permission: createDenyAllPermission(), execution, readRouting: actual });

  assert.ok(!("code" in wired));
  t.after(() => wired.close());
  const read = await wired.ports.tools.execute({ toolCallId: "factory-read", name: "read_file",
    arguments: { path: "source.txt", offset: 1, limit: 1 } }, new AbortController().signal);

  assert.equal(read.outcome, "result");
  if (read.outcome !== "result") return;

  assert.equal(read.value.content, "second\n");
  assert.ok(object(read.value.routing));
  assert.equal(read.value.routing.actualPath, "stream");
  assert.equal(offered.at(-1)?.executionId, "factory-read");
  assert.equal(trials, 0, "normal execution only registers the deferred opportunity");
});

test("other learning modes do not create a tool read strategy or bind topic work", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "trylo-tool-read-modes-"));

  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { TRYLO_HOME: path.join(root, "profile") };
  const base = { workspaceRoot: root, sessionId: "session", turnId: "turn", now: () => 100 };
  const unexpected = (): never => { throw new Error("non-tool mode bound or offered read-learning work"); };
  const topics: ReadTopics = { ownsReadRouting: true, bindReadRuntime: unexpected, offerReadOpportunity: unexpected };

  assert.equal(toolReadStrategyFor(base, topics), undefined);

  for (const mode of ["method", "user", "off", "invalid"]) {
    assert.equal(toolReadStrategyFor({ ...base, learning: { switch: mode, homeDir: root, env } }, topics), undefined);
  }

  assert.equal(existsSync(methodBoardRoot(root, env)), false);
});

test("surface wiring drives the real read_file strategy, preserves its version, and keeps the catalog", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "trylo-routing-wiring-"));

  t.after(() => rm(root, { recursive: true, force: true }));
  const text = "first\nsecond\nthird\n";

  await writeFile(path.join(root, "source.txt"), text);
  const records: ReadRoutingRecord[] = [];
  const choices: { executionId: string; conditions: ReadRoutingConditions }[] = [];
  const readRouting: ReadRoutingPort = {
    choose: async input => {
      choices.push({ executionId: input.executionId, conditions: input.conditions });
      return { path: "whole", reason: "learned_policy", versionId: "surface-route-v1" };
    },

    record: async input => { records.push(input); },
  };
  // No shell is called. Lending a host resource avoids constructing the native
  // Windows confinement bridge merely to test the independent file read path.
  const execution = createRunExecution(root, { shellIsolation: "host", homeDir: root,
    env: { TRYLO_HOME: path.join(root, "profile") } });

  t.after(() => execution.close());
  const input = { providerId: "fixture", model: "default", endpoint: "", apiKey: undefined,
    workspaceRoot: root, permission: createDenyAllPermission(), execution };
  const plain = wirePorts(input);
  const routed = wirePorts({ ...input, readRouting });

  assert.ok(!("code" in plain));
  assert.ok(!("code" in routed));
  t.after(() => plain.close());
  t.after(() => routed.close());
  assert.equal(routed.toolCatalogHash, plain.toolCatalogHash);
  assert.deepEqual(routed.ports.tools.snapshot(), plain.ports.tools.snapshot());
  const call = { toolCallId: "surface-read", name: "read_file", arguments: { path: "source.txt", offset: 1, limit: 1 } };
  const ordinary = await plain.ports.tools.execute(call, new AbortController().signal);

  assert.equal(ordinary.outcome, "result");

  if (ordinary.outcome !== "result") return;

  assert.equal(Object.hasOwn(ordinary.value, "routing"), false);
  const result = await routed.ports.tools.execute(call, new AbortController().signal);

  assert.equal(result.outcome, "result");

  if (result.outcome !== "result") return;

  assert.equal(result.value.content, "second\n");
  assert.equal(result.value.content, ordinary.value.content);
  assert.equal(result.output, ordinary.output);
  assert.deepEqual(choices, [{ executionId: "surface-read",
    conditions: { fileBytes: Buffer.byteLength(text), range: "bounded", streaming: true } }]);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.actualPath, "whole");
  assert.equal(records[0]!.decision.versionId, "surface-route-v1");
  assert.equal(records[0]!.outcome, "completed");
  assert.equal(records[0]!.bytesRead, Buffer.byteLength(text));
  const receipt = result.value.routing;

  assert.ok(object(receipt));
  assert.equal(receipt.actualPath, "whole");
  const decision = receipt.decision;

  assert.ok(object(decision));
  assert.equal(decision.versionId, "surface-route-v1");
});
