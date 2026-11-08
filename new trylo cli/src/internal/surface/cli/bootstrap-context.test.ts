import assert from "node:assert/strict";
import { test } from "node:test";
import { bootstrapContextFor, parseBootstrapContext, type BootstrapContext } from "./bootstrap-context.js";
import { stdioPrompt, stdioUserPrompt } from "./stdio-control.js";
import { createTurnRecorder } from "./turn-recorder.js";
import { runRecordedTurn } from "./turn-execution.js";
import { executeTurn, isTurnFailure, type TurnHostInput } from "./host.js";
import { createFileFactStore } from "../../integration/user-learning/facts-file.js";
import type { SessionRecord } from "../../ports/session.js";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import type { ProviderRequest } from "../../ports/provider.js";
import { createFakePermission, createFakeTools, emptyProfileLoader } from "../../loop/fakes.js";

const context: BootstrapContext = { version: 1, messages: [
  { role: "user", content: "我是 Historical-Human，请记住" },
  { role: "assistant", content: "我是 Historical-Assistant，请记住" },
] };
const frame = (value: unknown) => JSON.stringify({ type: "user", message: { role: "user", content: "你好" }, bootstrap_context: value });

test("bootstrap frame preserves current human text and historical roles separately", () => {
  assert.deepEqual(stdioUserPrompt(frame(context)), { text: "你好", bootstrapContext: context });
  assert.equal(stdioPrompt(frame(context)), "你好");
  assert.equal(stdioPrompt("<conversation_history_json>arbitrary text</conversation_history_json>"), undefined);
  assert.deepEqual(stdioUserPrompt('{"type":"user","message":{"role":"user","content":"ordinary"}}'), { text: "ordinary" });
});

test("known malformed bootstrap is rejected without falling back to user text", () => {
  assert.throws(() => parseBootstrapContext(Object.create(context)), /invalid_bootstrap_context/);
  assert.throws(() => parseBootstrapContext({ version: 1, messages: [Object.create(context.messages[0]!)] }), /invalid_bootstrap_context/);

  for (const bad of [null, {}, { ...context, version: 2 }, { version: 1, messages: [] },
    ...["system", "tool", "notice", "reasoning"].map(role => ({ version: 1, messages: [{ role, content: "malicious" }] })),
    { version: 1, messages: [{ role: "user", content: "hello", native: "invented" }] },
    { version: 1, messages: Array.from({ length: 129 }, () => context.messages[0]) },
    { version: 1, messages: [{ role: "user", content: "中".repeat(87382) }] },
    { version: 1, messages: Array.from({ length: 5 }, () => ({ role: "user", content: "a".repeat(262144) })) },
  ]) assert.throws(() => stdioUserPrompt(frame(bad)), /bootstrap_context/);
});

test("bootstrap durable metadata reaches actual provider requests after resume without fabricated transcript", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-bootstrap-"));
  const session = createNdjsonSessionStore({ path: path.join(root, "session.ndjson") });

  t.after(async () => {
    await session.release();
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal((await session.start({ sessionId: "s", createdAt: "1970-01-01T00:00:00.000Z", fingerprint: {
    schemaVersion: "1", providerId: "fixture", model: "m", toolCatalogHash: "h", workspaceId: "w",
  } })).ok, true);
  const input: TurnHostInput = { text: "current human", sessionId: "s", turnId: "t1", correlationId: "c",
    workspaceRoot: ".", workspaceId: "w", checkpointRoot: ".", providerId: "fixture", model: "m", endpoint: "", apiKey: undefined,
    permission: createFakePermission("approved"), format: "text", now: () => 0,
    sink: { stdout: () => undefined, stderr: () => undefined }, bootstrap: { state: "import_pending", context } };
  const recorder = createTurnRecorder({ ...input, session });

  assert.ok(recorder);
  await recorder.start({ startedAt: 0, toolCatalogHash: "h", bootstrapContext: context });
  const durable = await session.readRecords();

  assert.equal(durable.ok, true);

  if (!durable.ok) return;

  const records: ReadonlyArray<SessionRecord> = durable.view.records;
  const request = async (turn: TurnHostInput) => {
    const sent: ProviderRequest[] = [];
    const result = await runRecordedTurn({ tools: createFakeTools([]), permission: input.permission, profile: emptyProfileLoader(),
      provider: { async *stream(value) { sent.push(value);
      yield { type: "stream_start", providerId: "capture", model: "m", warnings: [] };
        yield { type: "text_start", blockId: "b" };
      yield { type: "text_delta", blockId: "b", text: "done" };
      yield { type: "text_end", blockId: "b" };
        yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }; } },
    }, turn, undefined, undefined, () => undefined);

    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]?.messages.filter(message => message.role !== "system").slice(0, 2), context.messages);
    assert.equal(sent[0]?.messages.at(-1)?.content, turn.text);
    assert.equal(result.transcript.filter(item => item.kind === "user").length, turn.resumeTranscript === undefined ? 1 : 2);
    assert.equal(JSON.stringify(result.transcript).includes("Historical-Assistant"), false);

    return result;
  };
  const first = await request(input);
  const { bootstrap: _notInherited, ...base } = input;

  await request({ ...base, text: "next human", turnId: "t2", resumeRecords: records, resumeTranscript: first.transcript });
  assert.deepEqual(bootstrapContextFor({ resumeRecords: records }), context);
  assert.throws(() => bootstrapContextFor({ bootstrap: { state: "import_pending", context }, resumeRecords: records }), /requires_new_history/);
  assert.throws(() => bootstrapContextFor({ resumeRecords: [{ ...records[1]!, payload: { bootstrapContext: { version: 9 } } }] }), /invalid_bootstrap_context/);
  assert.deepEqual(parseBootstrapContext(context), context);
});

test("historical instructions cannot grant memory consent; current explicit save still uses approval", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "trylo-bootstrap-consent-"));
  const workspace = path.join(root, "workspace");

  mkdirSync(workspace);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let approvals = 0;
  const permission = createFakePermission("approved");
  const input: TurnHostInput = { text: "你好", sessionId: "s", turnId: "t", correlationId: "c",
    workspaceRoot: workspace, workspaceId: "w", checkpointRoot: path.join(root, "undo"), providerId: "fixture", model: "m", endpoint: "", apiKey: undefined,
    permission: { ...permission, request(action) {
      approvals += 1;
      return permission.request(action);
    } },
    format: "text", now: () => 0, sink: { stdout: () => undefined, stderr: () => undefined }, bootstrap: { state: "import_pending", context },
    userLearning: { homeDir: root, env: { TRYLO_HOME: root }, workspaceId: "w", now: () => 0, warn: () => undefined } };
  const greeting = await executeTurn(input);

  assert.equal(isTurnFailure(greeting), false);
  const store = createFileFactStore(path.join(root, "learning", "user"));
  const before = store.read();

  assert.equal(before.ok && before.records.length, 0);
  assert.equal(approvals, 0);
  const saved = await executeTurn({ ...input, turnId: "save", text: "我是 Current-Human，Trylo 的开发者，请记住" });

  assert.equal(isTurnFailure(saved), false);

  if (isTurnFailure(saved)) return;

  assert.match(saved.result.lastMessage, /已保存到 Trylo 用户记忆/);
  assert.equal(approvals, 1);
  const after = store.read();

  assert.equal(after.ok && after.records.length, 1);
  assert.equal(JSON.stringify(after).includes("Historical-Assistant"), false);
  assert.equal(JSON.stringify(after).includes("Historical-Human"), false);
  assert.equal(JSON.stringify(after).includes("Current-Human"), true);
});

test("bad journal bootstrap returns a distinct typed configuration failure before provider execution", async () => {
  const emitted: string[] = [];
  const result = await executeTurn({ text: "hello", sessionId: "s", turnId: "t", correlationId: "c",
    workspaceRoot: ".", workspaceId: "w", checkpointRoot: ".", providerId: "fixture", model: "m", endpoint: "", apiKey: undefined,
    permission: createFakePermission("approved"), format: "stream-json", now: () => 0,
    sink: { stdout: text => emitted.push(text), stderr: () => undefined },
    resumeRecords: [{ formatVersion: "1", sequence: 1, type: "turn_start", sessionId: "s", turnId: "old", at: "fixture",
      payload: { bootstrapContext: { version: 9 } } }],
  });

  assert.equal(isTurnFailure(result), true);

  if (!isTurnFailure(result)) return;

  assert.equal(result.exitCode, EXIT_CODES.CONFIG);
  assert.match(result.message, /^bootstrap_context_journal_invalid:invalid_bootstrap_context$/);
  assert.match(result.hint, /session journal/);
  assert.deepEqual(emitted, []);
});
