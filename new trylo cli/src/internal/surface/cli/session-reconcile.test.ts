import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import { SESSION_FORMAT_VERSION } from "../../ports/session.js";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { runTurn } from "../../loop/runner.js";
import { createFakePermission, createFakeProvider, echoBinding, emptyProfileLoader } from "../../loop/fakes.js";
import type { ToolPort } from "../../ports/tools.js";
import type { ProviderEvent } from "../../ports/provider.js";
import { parseArgs } from "./args.js";
import { dispatch } from "./commands.js";
import type { CliContext } from "./context.js";
import { openSession } from "./session-open.js";
import { createTurnRecorder } from "./turn-recorder.js";

/**
 * Manual reconciliation of actions whose outcome the run could not prove
 * (WP01.3).
 *
 * The failure this closes is not "a tool failed" — it is "a tool crossed the
 * line and then nobody could say whether it landed". That state has to stop the
 * session from resuming, and the only thing allowed to start it again is a
 * person naming the action and what they checked. Every test here drives the
 * real command surface (`parseArgs` + `dispatch`) against a real journal on
 * disk, because a reconcile that only worked in memory would be the same bug
 * wearing a different hat.
 */

const FINGERPRINT = {
  schemaVersion: SESSION_FORMAT_VERSION,
  workspaceId: "w",
  providerId: "fixture",
  model: "m",
  toolCatalogHash: "h",
} as const;

const AT = "1970-01-01T00:00:00.000Z";

function tempHome(): string {
  return mkdtempSync(join(os.tmpdir(), "trylo-reconcile-"));
}

function sessionFile(root: string, id: string): string {
  return join(root, ".trylo", "sessions", `${id}.ndjson`);
}

function ctxOf(root: string): { ctx: CliContext; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CliContext = {
    env: {},
    homeDir: root,
    cwd: root,
    nodeVersion: "v22.0.0",
    stdinIsTty: false,
    readFile: () => undefined,
    isDirectory: () => false,
    readDir: () => [],
    writeFile: () => true,
    readStdin: async () => "",
    readLine: async () => undefined,
    readSecret: async () => undefined,
    stdout: text => out.push(text),
    stderr: text => err.push(text),
    now: () => 0,
    newId: prefix => `${prefix}-1`,
  };
  return { ctx, out, err };
}

async function cli(root: string, argv: ReadonlyArray<string>): Promise<{ code: number; out: string; err: string }> {
  const { ctx, out, err } = ctxOf(root);
  const code = await dispatch(parseArgs(argv), ctx);
  return { code, out: out.join(""), err: err.join("") };
}

/**
 * A tool host that loses contact: the adapter throws, which is the one outcome
 * that is neither success nor failure.
 */
function lostToolHost(): ToolPort {
  return {
    snapshot: () => [echoBinding({ needsApproval: false })],
    async execute() {
      throw new Error("connection to the tool host was lost");
    },
    async cancel() {},
  };
}

/** A real run whose one tool call crossed the line and never reported back. */
async function buildUnknownSession(root: string, id: string, turnId = "t1"): Promise<void> {
  const session = createNdjsonSessionStore({ path: sessionFile(root, id) });
  await session.start({ sessionId: id, createdAt: AT, fingerprint: FINGERPRINT });
  const recorder = createTurnRecorder({ session, sessionId: id, turnId, now: () => 0 });
  if (recorder === undefined) throw new Error("recorder missing");
  await recorder.start({ startedAt: 0, toolCatalogHash: "h" });
  // `tool_call`, not fragments: a call closed by `tool_input_end` is the one
  // shape that reaches the reducer without ever becoming a transcript item, and
  // this test is about what the journal can show, not about that path.
  const events: ProviderEvent[] = [
    { type: "stream_start", providerId: "fixture", model: "m", warnings: [] },
    { type: "tool_call", toolCallId: "c1", name: "echo", arguments: { text: "hi" } },
    // The provider succeeded; it is the subsequent tool execution that loses
    // its acknowledgement, which is the effect reconciliation must recover.
    { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
  ];
  // The run stops the moment an unknown outcome is durable; that is the point.
  await runTurn({
    profile: emptyProfileLoader(),
    permission: createFakePermission("approved"),
    progress: recorder.progress,
    provider: createFakeProvider([events]),
    tools: lostToolHost(),
  }, { sessionId: id, turnId, correlationId: "c", text: "go" }).catch(() => undefined);
  await session.release();
}

/** A journal stopped between issuing an action and hearing anything back. */
async function buildDanglingSession(root: string, id: string): Promise<void> {
  const session = createNdjsonSessionStore({ path: sessionFile(root, id) });
  await session.start({ sessionId: id, createdAt: AT, fingerprint: FINGERPRINT });
  await session.append({ type: "turn_start", sessionId: id, turnId: "t9", at: AT, payload: { toolCatalogHash: "h" } });
  await session.append({
    type: "transcript_item",
    sessionId: id,
    turnId: "t9",
    at: AT,
    payload: { kind: "tool_call", sequence: 0, toolCallId: "c9", name: "echo", arguments: { text: "hi" } },
  });
  await session.append({ type: "effect_issued", sessionId: id, turnId: "t9", at: AT, payload: { key: "tool:c9" } });
  await session.release();
}

async function recordsOf(root: string, id: string) {
  const session = createNdjsonSessionStore({ path: sessionFile(root, id) });
  const attached = await session.attach();
  if (!attached.ok) throw new Error(`attach failed: ${attached.code}`);
  const view = await session.readRecords();
  const read = await session.read();
  await session.release();
  if (!view.ok) throw new Error(`readRecords failed: ${view.code}`);
  if (!read.ok) throw new Error(`read failed: ${read.code}`);
  return { records: view.view.records, session: read.session };
}

test("listing names the action, its turn, its journal sequence and its arguments", async () => {
  const root = tempHome();
  try {
    await buildUnknownSession(root, "s1");
    const file = sessionFile(root, "s1");
    const before = readFileSync(file, "utf8");
    const listed = await cli(root, ["session", "reconcile", "s1"]);
    assert.equal(listed.code, EXIT_CODES.CONFIG, "a session with unknowns stays blocked");
    assert.match(listed.out, /turn t1/);
    assert.match(listed.out, /tool:c1/);
    assert.match(listed.out, /issued at journal sequence \d+/);
    assert.match(listed.out, /echo/);
    assert.match(listed.out, /"text":"hi"/);
    assert.equal(readFileSync(file, "utf8"), before, "listing must not append a single byte");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--json carries the same facts for a script", async () => {
  const root = tempHome();
  try {
    await buildUnknownSession(root, "s1");
    const listed = await cli(root, ["session", "reconcile", "s1", "--json"]);
    const parsed = JSON.parse(listed.out) as { pending: Array<{ key: string; turn: string; tool: string }> };
    assert.equal(parsed.pending.length, 1);
    assert.equal(parsed.pending[0]?.key, "tool:c1");
    assert.equal(parsed.pending[0]?.turn, "t1");
    assert.equal(parsed.pending[0]?.tool, "echo");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a verdict records what the person determined, and who determined it", async () => {
  const root = tempHome();
  try {
    await buildUnknownSession(root, "s1");
    const recorded = await cli(root, [
      "session", "reconcile", "s1",
      "--turn", "t1", "--key", "tool:c1",
      "--outcome", "committed",
      "--evidence", "ls -l showed the file written at 10:04",
    ]);
    assert.equal(recorded.code, EXIT_CODES.OK, recorded.err);
    const { records, session } = await recordsOf(root, "s1");
    const committed = records.find(record => record.type === "effect_committed");
    assert.equal(committed?.payload["key"], "tool:c1");
    assert.equal(committed?.payload["verifiedBy"], "user-manual", "the record must say a person decided this");
    assert.equal(committed?.payload["evidence"], "ls -l showed the file written at 10:04");
    assert.equal(typeof committed?.payload["issuedAtSequence"], "number", "the verdict must name the issue it settles");
    assert.deepEqual(session.pendingEffects, [], "the session is no longer blocked");
    assert.equal(
      session.transcript.filter(item => item.kind === "tool_result" && item.toolCallId === "c1").length,
      1,
      "the one result the run itself recorded stays the only one; a verdict adds no second answer",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repeating the same verdict is a no-op; contradicting it is refused", async () => {
  const root = tempHome();
  try {
    await buildUnknownSession(root, "s1");
    const verdict = ["session", "reconcile", "s1", "--turn", "t1", "--key", "tool:c1", "--outcome", "committed", "--evidence", "checked the file"];
    assert.equal((await cli(root, verdict)).code, EXIT_CODES.OK);
    const after = await recordsOf(root, "s1");
    const again = await cli(root, verdict);
    assert.equal(again.code, EXIT_CODES.OK, "the same verdict repeated must be idempotent");
    assert.match(again.out, /already recorded/);
    const repeated = await recordsOf(root, "s1");
    assert.equal(repeated.records.length, after.records.length, "an idempotent verdict appends nothing");

    const conflict = await cli(root, ["session", "reconcile", "s1", "--turn", "t1", "--key", "tool:c1", "--outcome", "failed", "--evidence", "changed my mind"]);
    assert.equal(conflict.code, EXIT_CODES.CONFIG, "a second verdict may not overwrite the first");
    assert.match(conflict.err, /already recorded as committed/);
    const kept = await recordsOf(root, "s1");
    assert.equal(kept.records.length, after.records.length, "a refused verdict appends nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a verdict without evidence, or with an outcome outside the set, is refused", async () => {
  const root = tempHome();
  try {
    await buildUnknownSession(root, "s1");
    const file = sessionFile(root, "s1");
    const before = readFileSync(file, "utf8");
    const partial = await cli(root, ["session", "reconcile", "s1", "--turn", "t1", "--key", "tool:c1", "--outcome", "committed"]);
    assert.equal(partial.code, EXIT_CODES.USAGE, "a verdict must say what was checked");
    const bogus = await cli(root, ["session", "reconcile", "s1", "--turn", "t1", "--key", "tool:c1", "--outcome", "probably", "--evidence", "looked fine"]);
    assert.equal(bogus.code, EXIT_CODES.USAGE);
    assert.match(bogus.err, /unknown outcome/);
    assert.equal(readFileSync(file, "utf8"), before, "a refused verdict writes nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a call torn by the journal's own repair is not answered with an invented result", async () => {
  const root = tempHome();
  try {
    await buildDanglingSession(root, "s2");
    const listed = await cli(root, ["session", "reconcile", "s2"]);
    assert.equal(listed.code, EXIT_CODES.CONFIG);
    assert.match(listed.out, /only the issued intent survived/, "the unanswered request is torn before anyone reads it");

    const recorded = await cli(root, [
      "session", "reconcile", "s2",
      "--turn", "t9", "--key", "tool:c9",
      "--outcome", "committed",
      "--evidence", "the file is there",
    ]);
    assert.equal(recorded.code, EXIT_CODES.OK, recorded.err);
    const { records, session } = await recordsOf(root, "s2");
    assert.equal(
      records.filter(record => record.type === "transcript_item" && record.payload["kind"] === "tool_result").length,
      0,
      "a verdict settles the effect; it must never manufacture the output nobody captured",
    );
    assert.equal(records.filter(record => record.type === "effect_committed").length, 1);
    assert.deepEqual(session.pendingEffects, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the same key in two turns: settling one turn leaves the other unresolved", async () => {
  const root = tempHome();
  try {
    const session = createNdjsonSessionStore({ path: sessionFile(root, "s3") });
    await session.start({ sessionId: "s3", createdAt: AT, fingerprint: FINGERPRINT });
    for (const turnId of ["t1", "t2"]) {
      await session.append({ type: "turn_start", sessionId: "s3", turnId, at: AT, payload: { toolCatalogHash: "h" } });
      await session.append({ type: "effect_issued", sessionId: "s3", turnId, at: AT, payload: { key: "tool:c1" } });
    }
    await session.release();

    const listed = await cli(root, ["session", "reconcile", "s3"]);
    assert.equal(listed.code, EXIT_CODES.CONFIG);
    assert.match(listed.out, /2 unresolved/);

    const one = await cli(root, ["session", "reconcile", "s3", "--turn", "t2", "--key", "tool:c1", "--outcome", "failed", "--evidence", "nothing was written"]);
    assert.equal(one.code, EXIT_CODES.OK, one.err);
    const { session: after } = await recordsOf(root, "s3");
    assert.equal(after.pendingEffects.length, 1, "the other turn's issue is untouched");
    assert.equal(after.pendingEffects[0]?.turnId, "t1");
    assert.equal(after.pendingEffects[0]?.key, "tool:c1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a reconciled session opens for resume and the action is not repeated", async () => {
  const root = tempHome();
  try {
    await buildUnknownSession(root, "s1");
    const { ctx } = ctxOf(root);
    const options = { resume: "s1", message: [], readStdin: false };
    const blocked = await openSession(ctx, options, FINGERPRINT);
    assert.equal(blocked.kind, "failed", "an unproven action must block a resume");

    const recorded = await cli(root, ["session", "reconcile", "s1", "--turn", "t1", "--key", "tool:c1", "--outcome", "committed", "--evidence", "the file exists"]);
    assert.equal(recorded.code, EXIT_CODES.OK, recorded.err);

    const opened = await openSession(ctx, options, FINGERPRINT);
    assert.equal(opened.kind, "resume", "a reconciled session must resume");
    if (opened.kind === "resume") {
      const results = opened.transcript.filter(item => item.kind === "tool_result" && item.toolCallId === "c1");
      assert.equal(results.length, 1, "one answer, so the resumed request cannot ask the model to do it again");
      await opened.session.release();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a session with nothing unresolved lists clean and exits 0", async () => {
  const root = tempHome();
  try {
    const session = createNdjsonSessionStore({ path: sessionFile(root, "s4") });
    await session.start({ sessionId: "s4", createdAt: AT, fingerprint: FINGERPRINT });
    await session.append({ type: "turn_start", sessionId: "s4", turnId: "t1", at: AT, payload: { toolCatalogHash: "h" } });
    await session.release();
    const listed = await cli(root, ["session", "reconcile", "s4"]);
    assert.equal(listed.code, EXIT_CODES.OK);
    assert.match(listed.out, /nothing to reconcile/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a session held by another process is not reconciled", async () => {
  const root = tempHome();
  try {
    await buildUnknownSession(root, "s1");
    const holder = createNdjsonSessionStore({ path: sessionFile(root, "s1") });
    const attached = await holder.attach();
    assert.equal(attached.ok, true, "the holder takes the single-writer lock");
    const busy = await cli(root, ["session", "reconcile", "s1"]);
    assert.equal(busy.code, EXIT_CODES.CONFIG);
    assert.match(busy.err, /lock/);
    await holder.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a session that does not exist is named as such, not treated as empty", async () => {
  const root = tempHome();
  try {
    const missing = await cli(root, ["session", "reconcile", "nope"]);
    assert.equal(missing.code, EXIT_CODES.CONFIG);
    assert.match(missing.err, /no such session/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
