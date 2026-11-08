import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import type { SessionPort, SessionRecord } from "../../ports/session.js";
import { providerPositiveNoteRef, providerWaitObservationHash, type ProviderWaitObservation } from "../../learning/central/runtime/provider-positive.js";
import { sessionRecordPublicText } from "../../integration/learning-content/sources/session-decode.js";
import { createCentralRuntimeSource } from "../../integration/central-learning/runtime-source.js";
import { createRuntimeSessionMaterials } from "./central-runtime-materials-session.js";
import { createCentralRuntimeMaterials } from "./central-runtime-materials.js";
import type { CliContext } from "./context.js";
import { methodBoardRoot } from "./learning-sink.js";
import { sessionPath } from "./session-paths.js";

const signal = new AbortController().signal, workspaceId = "workspace-positive-source";
const at = (index: number) => new Date(Date.UTC(2026, 10, 6, 1, 0, index)).toISOString();

function fixture() {
  const base = testScratchPath("central-provider-positive-source-tests");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, "case-"));
  assert.ok(!path.relative(base, root).startsWith(".."));
  let registryReads = 0;
  const ctx: CliContext = { homeDir: root, cwd: path.join(root, "workspace"), env: { TRYLO_HOME: path.join(root, "home") },
    nodeVersion: "v24.0.0", stdinIsTty: false, now: () => 0, newId: prefix => `${prefix}-fixture`,
    readFile(file) { try { return readFileSync(file, "utf8"); } catch { return undefined; } },
    isDirectory(file) { try { return statSync(file).isDirectory(); } catch { return false; } },

    readDir(directory) { registryReads += 1;
    try { return readdirSync(directory).map(name => {
      const stat = statSync(path.join(directory, name));
      return { name, bytes: stat.size, modifiedAtMs: stat.mtimeMs };
    }); } catch { return []; } },

    writeFile(file, value) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, value);
      return true;
    },

    stdout() {}, stderr() {}, readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined };

  return { ctx, root, registryReads: () => registryReads };
}

const capture = (ctx: CliContext, sessionId: string, turnId: string): ProviderWaitObservation => ({
  schemaVersion: 1, scope: ctx.cwd, budgetId: "budget:original", connectionRef: `central-learning-provider-connection:${"a".repeat(64)}`,
  sessionId, turnId, model: "model:original", wait: { ref: "wait:original", factRef: "fact:original", boardSequence: 10 },
});

async function start(ctx: CliContext, sessionId: string, ownerWorkspace = workspaceId): Promise<SessionPort> {
  const store = createNdjsonSessionStore({ path: sessionPath(ctx.homeDir, ctx.env, sessionId) });
  assert.ok((await store.start({ sessionId, createdAt: at(0), fingerprint: { schemaVersion: "1", workspaceId: ownerWorkspace,
    providerId: "provider:original", model: "model:original", toolCatalogHash: "catalog:original" } })).ok);
  return store;
}

async function turn(store: SessionPort, ctx: CliContext, sessionId: string, index: number,
  kind: "valid" | "denied" | "mismatch" | "claim" | "open_shape" = "valid") {
  const turnId = `turn-${index}`, observed = capture(ctx, sessionId, turnId);
  const captured = kind === "mismatch" ? { ...observed, turnId: "another-turn" } : observed;
  const returned = { schemaVersion: 1, captureHash: providerWaitObservationHash(captured), attemptId: `attempt-${index}`,
    model: observed.model, finishReason: "stop", reportedTotalTokens: 11 };

  assert.ok((await store.append({ type: "turn_start", sessionId, turnId, at: at(index * 3),
    payload: { userSourceAvailable: kind !== "denied", providerWaitObservation: { ...captured, wait: { ...captured.wait } } } })).ok);
  assert.ok((await store.append({ type: "turn_input", sessionId, turnId, at: at(index * 3 + 1),
    payload: { text: "An ordinary user task; successful completion text alone proves no provider recovery." } })).ok);
  assert.ok((await store.append({ type: "terminal", sessionId, turnId, at: at(index * 3 + 2), payload: {
    kind: "task_completed", publicText: "The ordinary task returned", ...(kind === "claim" ? {} : {
      providerReturnObservation: { ...returned, ...(kind === "open_shape" ? { fabricated: true } : {}) },
    }),
  } })).ok);
}

test("verified normal producer records pass bounded snapshot metadata without becoming business text or causing another journal discovery", async t => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const store = await start(f.ctx, "ordinary-positive"), foreign = await start(f.ctx, "foreign-positive", "workspace:foreign");

  t.after(async () => {
    await store.release();
    await foreign.release();
  });

  for (let index = 0; index < 10; index += 1) await turn(store, f.ctx, "ordinary-positive", index);

  for (const [offset, kind] of (["denied", "mismatch", "claim", "open_shape"] as const).entries()) {
    await turn(store, f.ctx, "ordinary-positive", 10 + offset, kind);
  }

  await turn(foreign, f.ctx, "foreign-positive", 20);
  const options = { ctx: f.ctx, workspaceId, enabled: () => true }, sessions = createRuntimeSessionMaterials(options);

  assert.deepEqual(sessions.providerPositiveNotes(), []);
  assert.equal(f.registryReads(), 0);
  await sessions.catalogs(signal);
  const before = f.registryReads(), notes = sessions.providerPositiveNotes();

  assert.equal(f.registryReads(), before, "metadata reads use only the already discovered verified journal views");
  assert.equal(notes.length, 8);
  assert.deepEqual(notes.map(note => note.capture.turnId), [9, 8, 7, 6, 5, 4, 3, 2].map(index => `turn-${index}`));
  const journal = await store.readRecords();
  assert.ok(journal.ok);
  if (!journal.ok) return;

  const latest = notes[0]!;

  assert.equal(latest.request.sequence, journal.view.records.find(row => row.type === "turn_start" && row.turnId === "turn-9")?.sequence);
  assert.equal(latest.finish.sequence, journal.view.records.find(row => row.type === "terminal" && row.turnId === "turn-9")?.sequence);
  assert.equal(latest.request.at, at(27));
  assert.equal(latest.finish.at, at(29));
  const { ref: _ref, ...body } = latest;
  assert.equal(latest.ref, providerPositiveNoteRef(body));
  const terminal = journal.view.records[latest.finish.sequence]!;
  const { providerReturnObservation: _observation, ...publicPayload } = terminal.payload;

  assert.equal(sessionRecordPublicText(terminal), sessionRecordPublicText({ ...terminal, payload: publicPayload } as SessionRecord),
    "reserved metadata does not alter the original terminal's public text or its source hash");
  const source = createCentralRuntimeMaterials(options), snapshot = await source.snapshot(f.ctx.cwd, signal);

  assert.deepEqual(snapshot.providerPositiveNotes, notes);
  assert.deepEqual(snapshot.opportunities, []);
  const business = await source.businessSnapshot(f.ctx.cwd, signal);

  assert.equal(Object.hasOwn(business, "providerPositiveNotes"), false);

  for (const text of [JSON.stringify(snapshot.materials), JSON.stringify(snapshot.sourceRefs), JSON.stringify(business)]) {
    for (const reserved of ["providerReturnObservation", "providerWaitObservation", "captureHash", latest.ref]) assert.equal(text.includes(reserved), false, reserved);
  }

  const combined = createCentralRuntimeSource({ boardRoot: methodBoardRoot(f.ctx.homeDir, f.ctx.env), scope: f.ctx.cwd,
    ports: [], enabled: () => true, peerSources: [{ snapshot: async () => snapshot, read: async () => [] }] });
  const aggregate = await combined.snapshot(f.ctx.cwd, signal);

  assert.deepEqual(aggregate.providerPositiveNotes, notes);
  assert.ok(notes.every(note => !aggregate.sourceRefs.includes(note.ref) && !aggregate.materials.some(row => row.ref === note.ref)));
});
