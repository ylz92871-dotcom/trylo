import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { encodeLine, createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import type { SessionRecord } from "../../ports/session.js";
import type { Envelope, JsonObject } from "../../protocol/envelope.js";
import { createToolRewardSensor } from "../../integration/reward/journal-sensor.js";
import { createRewardBoardPort } from "../../integration/reward/board-port.js";
import { readFeedbackExplanation } from "../../integration/reward/explanation-reader.js";
import { dispatch } from "./commands.js";
import { parseArgs } from "./args.js";
import { FEEDBACK_OUTPUT_BYTES } from "./feedback-read-view.js";
import { sessionPath } from "./session-paths.js";
import type { CliContext } from "./context.js";

const sessionId = "feedback-contract-session", at = "2026-11-04T09:00:00.000Z";
const toolName = `tool_${"\u0001".repeat(500)}`;

function sourceFixture() {
  const records: SessionRecord[] = [], events: Envelope[] = [];
  const add = (type: SessionRecord["type"], payload: JsonObject, turnId?: string) => {
    records.push({ formatVersion: "1", sequence: records.length, sessionId, at, type, payload,
      ...(turnId === undefined ? {} : { turnId }) });
  };

  add("session_start", { fingerprint: { schemaVersion: "1", providerId: "fixture", model: "fixture", toolCatalogHash: "tools", workspaceId: "workspace" } });
  let counter = 0;
  const emit = (turnId: string, kind: string, payload: JsonObject) => {
    const event: Envelope = { protocolVersion: "0.0", eventId: `evt-${++counter}`, sequence: counter - 1, timestamp: at,
      producerId: "loop", producerSequence: counter, sessionId, turnId, attemptId: `attempt-${turnId}`, kind, payload };
    events.push(event);
    add("envelope", { envelope: { ...event } }, turnId);
  };

  add("turn_start", { toolCatalogHash: "tools" }, "first");
  add("envelope", { envelope: { protocolVersion: "0.0", eventId: "boot", sequence: 0, timestamp: at,
    producerId: "loop", producerSequence: 0, kind: "terminal", payload: { reason: "completed" } } }, "first");
  let through = 0;

  for (let i = 0; i < 10; i++) {
    emit("first", "tool_use", { toolCallId: `call-${i}`, name: toolName });
    through = records.length - 1;
    if (i === 9) continue;
    if (i === 2) emit("first", "observation", { toolCallId: `call-${i}`, refused: true });
    emit("first", "tool_result", { toolCallId: `call-${i}`, status: i === 1 || i === 2 ? "failed" : "succeeded" });
  }

  add("terminal", { reason: "completed" }, "first");
  add("turn_start", { toolCatalogHash: "tools" }, "second");
  counter = 0;
  emit("second", "tool_use", { toolCallId: "call-0", name: toolName });
  emit("second", "tool_result", { toolCallId: "call-0", status: "succeeded" });
  emit("second", "tool_use", { toolCallId: "open", name: toolName });

  return { records, events, through };
}

async function boardBytes(root: string): Promise<readonly [string, string][]> {
  const files = await readdir(root).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  return Promise.all(files.sort().map(async name => [name, await readFile(path.join(root, name), "utf8")] as [string, string]));
}

test("explicit feedback CLI reads the full source cohort without task IO; presentation caps preserve latest old-unit revision", async () => {
  const parent = testScratchPath("feedback-read-contract"), prefix = path.join(parent, "fixture-");

  await mkdir(parent, { recursive: true });
  const home = await mkdtemp(prefix);
  const file = sessionPath(home, { TRYLO_HOME: home }, sessionId), boardRoot = path.join(home, "learning", "board");
  const fixture = sourceFixture(), output: string[] = [];
  const unexpected = (): never => { throw new Error("feedback read constructed task IO"); };
  const ctx: CliContext = { homeDir: home, env: { TRYLO_HOME: home }, cwd: home, nodeVersion: "v24", stdinIsTty: false,
    readFile: unexpected, readDir: unexpected, writeFile: unexpected, isDirectory: unexpected, readStdin: unexpected,
    readLine: unexpected, readSecret: unexpected, stdout: text => output.push(text), stderr: unexpected, now: unexpected, newId: unexpected };

  try {
    await mkdir(path.dirname(file), { recursive: true });
    const raw = fixture.records.map(row => encodeLine(row.sequence, row)).join("");
    await writeFile(file, raw);
    const args = ["learn", "feedback", "--session", sessionId, "--through", String(fixture.through)];

    assert.equal(await dispatch(parseArgs(args), ctx), 0);
    const first = JSON.parse(output.at(-1)!);

    assert.equal(first.reported.population, 10);
    assert.equal(first.unitCards.shown, 8);
    assert.equal(first.unitCards.omitted, 2);
    assert.equal(first.source.observedRequests, 12);
    assert.ok(first.source.observedThrough > first.source.cohortThrough);
    assert.equal(first.unitCards.items[0].registeredAt, fixture.through);
    assert.deepEqual(await boardBytes(boardRoot), [], "a historical read does not create a Board");

    const ledger = createRewardBoardPort(boardRoot), sensor = createToolRewardSensor({ scope: "workspace", environment: "fixture-v1" });
    let originalExposure: string | undefined;

    for (const event of fixture.events) for (const item of sensor.capture(event)) {
      const result = item.kind === "exposure" ? await ledger.expose(item.exposure) : await ledger.feedback(item.feedback);
      assert.ok(result.ok);
      if (item.kind === "exposure" && originalExposure === undefined) originalExposure = item.exposure.id;
    }

    const read = await ledger.read();
    assert.ok(read.ok);
    const exposure = read.records.exposures.find(row => row.id === originalExposure)!;
    let previous: string | undefined;

    for (let i = 0; i < 20; i++) {
      const id = `revision-${"\u0001".repeat(400)}-${i}`;
      const result = await ledger.feedback({ schemaVersion: 1, id, exposureId: exposure.id, source: { ...exposure.source, eventId: id },
        origin: "user", evidenceIds: [`evidence-${id}`], observedAt: Date.parse(at) + 100 + i,
        outcome: { kind: "measured", value: i % 2 === 0 ? -1 : 1, confidence: 1, noiseVariance: 1 },
        attribution: { kind: "linked", shares: [{ target: exposure.targets[0]!, share: 1 }] },
        ...(previous === undefined ? {} : { supersedes: previous }) });
      assert.ok(result.ok);
      previous = id;
    }

    const before = await boardBytes(boardRoot);
    const programmatic = await readFeedbackExplanation({ enabled: () => true, sessionId, through: fixture.through, delta: 0.05,
      source: createNdjsonSessionStore({ path: file }), board: createBoardReader(boardRoot) });
    assert.ok(programmatic.ok);
    assert.deepEqual(programmatic.reported.counts, { success: 7, failure: 1, closedOther: 1, pending: 1 });
    assert.equal(await dispatch(parseArgs(args), ctx), 0);
    const rendered = output.at(-1)!, cli = JSON.parse(rendered);

    assert.equal(Buffer.byteLength(rendered, "utf8") <= FEEDBACK_OUTPUT_BYTES, true);
    assert.equal(cli.display.compact, true);
    assert.equal(cli.unitCards.omitted, 10);
    assert.deepEqual(cli.reported.counts, programmatic.reported.counts);
    assert.deepEqual(cli.reported.conditionalMeanBands, programmatic.reported.conditionalMeanBands);
    assert.equal(cli.legacyRevision.status, "compared");
    assert.equal(cli.legacyRevision.unitId, exposure.id);
    assert.equal(cli.legacyRevision.afterFeedbackCount, cli.legacyRevision.beforeFeedbackCount + 1);
    assert.equal(cli.questions.shown, 4);
    assert.ok(cli.questions.groups.every((group: { shown: number }) => group.shown === 1));
    assert.deepEqual(await boardBytes(boardRoot), before);
    assert.equal(await readFile(file, "utf8"), raw);
    const child = spawnSync(process.execPath, [fileURLToPath(new URL("../../../cmd/trylo/main.js", import.meta.url)), ...args],
      { cwd: home, env: { ...process.env, TRYLO_HOME: home }, encoding: "utf8", maxBuffer: FEEDBACK_OUTPUT_BYTES * 2 });

    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).reported.population, 10);
    assert.deepEqual(await boardBytes(boardRoot), before);
    assert.equal(await readFile(file, "utf8"), raw);
    assert.equal((await readdir(path.dirname(file))).some(name => name.endsWith(".lock")), false);
  } finally {
    assert.ok(path.resolve(home).startsWith(prefix));
    await rm(home, { recursive: true, force: true });
  }
});

test("feedback flags require a session and cannot change the cohort by turn/action or accept invalid budgets", () => {
  for (const tail of [[], ["--session", "../escape"], ["--session", sessionId, "--delta", "NaN"],
    ["--session", sessionId, "--through", "9007199254740992"], ["--session", sessionId, "--turn", "first"],
    ["--session", sessionId, "--session", sessionId]]) assert.equal(parseArgs(["learn", "feedback", ...tail]).kind, "error");
});
