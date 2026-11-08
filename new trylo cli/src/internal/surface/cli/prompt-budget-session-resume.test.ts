import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { createOpenAiCompatibleProvider } from "../../adapters/provider/openai-compatible.js";
import { createCompactionService } from "../../compaction/service.js";
import { createFakePermission } from "../../loop/fakes.js";
import type { SessionRecord } from "../../ports/session.js";
import { testScratchPath } from "../../testing/scratch.js";
import type { CliContext } from "./context.js";
import { executeTurn, isTurnFailure, type TurnHostInput } from "./host.js";
import { openSession } from "./session-open.js";
import { sessionPath } from "./session-paths.js";
import { compactSession } from "./compact-session.js";

const OBSERVED_INPUT = 100_000, MODEL = "local-metering-fixture";
const ENDPOINT = "https://metering-fixture.invalid/v1/chat/completions";
const FIRST = "Read this synthetic exchange and finish: " + String.fromCodePoint(0x20000).repeat(30);
const SECOND = "Continue the same task using the completed earlier exchange.";
const packet = (input = OBSERVED_INPUT, text = "The synthetic exchange is complete.") => [
  { id: "local", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
  { id: "local", choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: input, completion_tokens: 2, total_tokens: input + 2 } },
].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n";

function fixture(context: { after(callback: () => void | Promise<void>): void }) {
  const root = mkdtempSync(path.join(testScratchPath(), "prompt-budget-session-"));
  const cleanup: (() => void | Promise<void>)[] = [];
  context.after(async () => {
    for (const close of cleanup) await close();
    rmSync(root, { recursive: true, force: true });
  });
  const home = path.join(root, "home");
  mkdirSync(home);
  return { root, home, beforeCleanup: (close: () => void | Promise<void>) => cleanup.push(close) };
}

function contextFor(root: string, home: string): CliContext {
  return { env: {}, homeDir: home, cwd: root, nodeVersion: process.version, stdinIsTty: false,
    readFile: () => undefined, isDirectory: () => true, readDir: () => [], writeFile: () => true,
    readStdin: async () => "", readLine: async () => undefined, readSecret: async () => undefined,
    stdout: () => {}, stderr: () => {}, now: () => 0, newId: prefix => `${prefix}-fixture` };
}

function object(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function selectedFor(records: readonly SessionRecord[], turnId: string) {
  return records.flatMap(record => {
    if (record.turnId !== turnId || record.type !== "envelope") return [];
    const envelope = record.payload.envelope;
    if (!object(envelope) || envelope.kind !== "observation") return [];
    const payload = envelope.payload;
    return object(payload)
      && payload.component === "prompt_budget" && payload.status === "selected" ? [payload] : [];
  });
}

function calibrated(selected: ReturnType<typeof selectedFor>[number] | undefined, expected = OBSERVED_INPUT) {
  assert.ok(selected, "second actual request must have a canonical budget selection");
  assert.equal(selected.basis, "server_plus_added", JSON.stringify(selected));
  assert.equal(selected.observedInputTokens, expected);
  assert.ok(typeof selected.tokens === "number" && selected.tokens >= expected);
}

function publicResult(value: unknown) {
  assert.ok(object(value));
  assert.equal(Object.hasOwn(value, "promptInputCheckpoint"), false);
  assert.equal(Object.hasOwn(value, "promptInputRecovery"), false);
  assert.ok(object(value.usage));
  assert.deepEqual(Object.keys(value.usage).sort(), ["inputTokens", "outputTokens", "totalTokens"]);
}

test("adjacent host turns reuse the complete input of the settled first turn through official records", async t => {
  const f = fixture(t), ctx = contextFor(f.root, f.home), requests: unknown[] = [];

  t.mock.method(globalThis, "fetch", async () => { throw new Error("network forbidden in session-budget fixture"); });
  const provider = createOpenAiCompatibleProvider({ endpoint: ENDPOINT, model: MODEL, apiKey: "synthetic-not-a-user-key",

    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(packet(), { headers: { "content-type": "text/event-stream" } });
    } });
  const opened = await openSession(ctx, { session: "host-basis", message: [], readStdin: false },
    { schemaVersion: "1", providerId: "openai-compatible", model: MODEL, workspaceId: "fixture", toolCatalogHash: "fixture-tools" });

  assert.equal(opened.kind, "new");
  if (opened.kind !== "new") throw new Error("fixture session not opened");

  f.beforeCleanup(() => opened.session.release());
  const common: TurnHostInput = { text: FIRST, sessionId: "host-basis", turnId: "first", correlationId: "fixture",
    workspaceRoot: f.root, workspaceId: "fixture", checkpointRoot: path.join(f.root, "checkpoints"),
    providerId: "openai-compatible", model: MODEL, endpoint: ENDPOINT, apiKey: undefined,
    providerGuard: () => provider, permission: createFakePermission("approved"), toolSelection: [],
    contextTokenLimit: 1_000_000, format: "stream-json", sink: { stdout() {}, stderr() {} }, now: () => 0,
    session: opened.session };
  const first = await executeTurn(common);
  assert.equal(isTurnFailure(first), false);

  if (isTurnFailure(first)) throw new Error(first.message);

  assert.equal(first.exitCode, 0);
  assert.equal(first.result.usage.inputTokens, OBSERVED_INPUT);
  publicResult(first.result);
  const recovered = await opened.session.readRecords();
  assert.ok(recovered.ok);

  if (!recovered.ok) throw new Error("fixture records unavailable");

  const second = await executeTurn({ ...common, text: SECOND, turnId: "second", resumeTranscript: first.transcript,
    resumeRecords: recovered.view.records, ...(first.view === undefined ? {} : { resumeView: first.view }) });

  assert.equal(isTurnFailure(second), false);
  if (isTurnFailure(second)) throw new Error(second.message);

  assert.equal(second.exitCode, 0);
  assert.equal(requests.length, 2);
  publicResult(second.result);
  assert.equal(second.result.usage.inputTokens, OBSERVED_INPUT, "prior billing must not be added to the second turn");
  const final = await opened.session.readRecords();
  assert.ok(final.ok);

  if (!final.ok) throw new Error("fixture final records unavailable");

  calibrated(selectedFor(final.view.records, "second")[0]);
});

const preloadFor = (input: number) => `import fs from 'node:fs';import {createHash} from 'node:crypto';
let calls=0;globalThis.fetch=async(resource,init)=>{calls++;if(String(resource)!==process.env.TRYLO_TEST_ENDPOINT)throw new Error('network forbidden');
const body=JSON.parse(init.body),summary=process.env.TRYLO_TEST_SUMMARY;
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
fs.writeFileSync(process.env.TRYLO_TEST_REQUEST_CAPTURE,JSON.stringify({calls,model:body.model,messages:body.messages.length,
messageDigests:body.messages.map(message=>({role:message.role,digest:digest(message)})),
summaryBodyPresent:summary?body.messages.some(message=>message.role==='system'&&typeof message.content==='string'&&(message.content.includes(summary)||message.content.includes(JSON.stringify(summary).slice(1,-1)))):null}),{flag:'wx'});
const auxiliary=body.messages.some(message=>typeof message.content==='string'&&message.content.startsWith('You are the trylo compaction summarizer.'));
return new Response(auxiliary?${JSON.stringify(packet(input, "COMPACTION-FIXTURE: the old source is handled; continue the current task."))}:${JSON.stringify(packet(input))},{headers:{'content-type':'text/event-stream'}});};`;

function cliEnvironment(root: string, home: string, capture: string, key: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "SYSTEMROOT", "windir", "WINDIR", "ComSpec", "COMSPEC", "PATH", "PATHEXT"])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  for (const name of ["APPDATA", "LOCALAPPDATA", "USERPROFILE", "TEMP", "TMP"])
    {
      env[name] = path.join(root, name.toLowerCase());
      mkdirSync(env[name]!, { recursive: true });
    }
  return { ...env, TRYLO_HOME: home, TRYLO_OPENAI_API_KEY: key, TRYLO_TEST_REQUEST_CAPTURE: capture };
}

type RequestCapture = { readonly calls: number; readonly model: string; readonly summaryBodyPresent: boolean | null;
  readonly messageDigests: readonly { readonly role: string; readonly digest: string }[] };

async function reopenedCli(t: { after(callback: () => void | Promise<void>): void }, change: "none" | "window" | "endpoint" | "credential",
  options: { readonly observedInput?: number; readonly firstText?: string; readonly secondContextLimit?: number;
    readonly compactCycle?: boolean } = {}) {
  const f = fixture(t), preload = path.join(f.root, "memory-response.mjs"), id = "cli-basis";

  writeFileSync(preload, preloadFor(options.observedInput ?? OBSERVED_INPUT), { flag: "wx" });
  const main = process.env.TRYLO_TEST_CLI_MAIN ?? fileURLToPath(new URL("../../../cmd/trylo/main.js", import.meta.url));
  const prompts = options.compactCycle ? ["Synthetic old source. ".repeat(1500), SECOND, "/compact",
    "Continue under the persisted compact projection.", "Continue after a normal process reopen."] : [options.firstText ?? FIRST, SECOND];
  let expectedSummary: string | undefined;
  let postCompact: RequestCapture | undefined;

  for (const [offset, prompt] of prompts.entries()) {
    const index = offset + 1;

    if (prompt === "/compact") {
      const official = createNdjsonSessionStore({ path: sessionPath(f.home, { TRYLO_HOME: f.home }, id) });

      assert.ok((await official.attach()).ok);

      try {
        const records = await official.readRecords();
        assert.ok(records.ok);
        if (!records.ok) throw new Error("fixture compact records unavailable");

        const compacted = await compactSession({ now: () => 0 }, id, records.view.records, official);

        assert.ok(compacted.ok, JSON.stringify(compacted));
        if (!compacted.ok) throw new Error("official writer did not compact");

        assert.equal(compacted.wrote, true);
        const saved = await official.readRecords();
        assert.ok(saved.ok);
        if (!saved.ok) throw new Error("fixture compact persistence unavailable");

        const projected = createCompactionService().projectForPrompt({ records: saved.view.records });
        assert.ok(projected.ok);

        if (!projected.ok) throw new Error("fixture compact projection unavailable");

        assert.ok(projected.view.window, "official writer must persist a real validated window");
        assert.equal(projected.view.window.windowId, compacted.window.windowId);
        expectedSummary = projected.view.window.summary;
      } finally { await official.release(); }

      continue;
    }

    if (index === 2 && change === "window") {
      const store = createNdjsonSessionStore({ path: sessionPath(f.home, { TRYLO_HOME: f.home }, id) });

      assert.ok((await store.attach()).ok);

      try {
        const view = await store.readRecords();
        assert.ok(view.ok);
        if (!view.ok) throw new Error("fixture window records unavailable");
        const items = view.view.records.filter(record => record.type === "transcript_item");
        assert.ok(items.length > 1);
        assert.ok((await store.append({ type: "compact", sessionId: id, at: "1970-01-01T00:00:00.000Z",
          payload: { formatVersion: "1", windowId: "w-control", replacedFromSequence: items[0]!.sequence,
            replacedToSequence: items.at(-1)!.sequence, summary: "The first synthetic exchange is complete." } })).ok);
      } finally { await store.release(); }
    }

    const capture = path.join(f.root, `request-${index}.json`);
    const endpoint = change === "endpoint" && index === 2 ? "https://other-metering-fixture.invalid/v1/chat/completions" : ENDPOINT;
    const env = cliEnvironment(f.root, f.home, capture, change === "credential" && index === 2 ? "synthetic-key-two" : "synthetic-key-one");

    env.TRYLO_TEST_ENDPOINT = endpoint;

    if (expectedSummary !== undefined) env.TRYLO_TEST_SUMMARY = expectedSummary;

    const child = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, main, "run",
      "--provider", "openai-compatible", "--endpoint", endpoint, "--model", MODEL,
      "--context-window", String(index === 2 ? options.secondContextLimit ?? 1_000_000 : 1_000_000),
      "--model-context-window", "1000000", "--format", "stream-json", "--tools", "read_file",
      index === 1 ? "--session" : "--resume", id, "-"],
    { cwd: f.root, env, input: prompt, encoding: "utf8", maxBuffer: 2_000_000, windowsHide: true });

    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr + child.stdout);
    const output: unknown[] = child.stdout.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
    const terminal = output.find(value => object(value) && value.type === "run_result");
    assert.ok(terminal);
    publicResult(terminal);
    const captured = JSON.parse(readFileSync(capture, "utf8")) as RequestCapture;

    assert.equal(captured.calls, 1);
    assert.equal(captured.model, MODEL);

    if (expectedSummary !== undefined && index >= 4) {
      assert.equal(captured.summaryBodyPresent, true, "the actual post-compact request must contain the official whole summary");

      if (postCompact !== undefined) {
        const before = postCompact.messageDigests.filter(row => row.role !== "system");
        const after = captured.messageDigests.filter(row => row.role !== "system");
        assert.ok(before.every((row, position) => row.digest === after[position]?.digest), "resumed projected non-system history must preserve its actual predecessor");
      }

      postCompact = captured;
    }
  }

  const store = createNdjsonSessionStore({ path: sessionPath(f.home, { TRYLO_HOME: f.home }, id) });
  const recovered = await store.read();
  assert.ok(recovered.ok);

  if (!recovered.ok) throw new Error("fixture recovery unavailable");

  assert.equal(recovered.session.partials.length, 0);
  assert.equal(recovered.session.reconcileRequired.length, 0);
  const view = await store.readRecords();
  assert.ok(view.ok);
  if (!view.ok) throw new Error("fixture reopened records unavailable");

  const turns = view.view.records.filter(record => record.type === "turn_start");

  assert.ok(options.compactCycle ? turns.length >= 4 : turns.length === 2);
  const selected = selectedFor(view.view.records, turns.at(-1)!.turnId!);
  assert.equal(selected.length, 1);

  return selected[0]!;
}

test("a fresh CLI process normally reopens the settled session and preserves its complete input basis", async t => {
  calibrated(await reopenedCli(t, "none"));
});

test("ordinary non-native OpenAI resumes below its explicit caller budget despite a larger local estimate", async t => {
  const limit = 10_000, observed = 128;
  const selected = await reopenedCli(t, "none", { observedInput: observed,
    firstText: "Synthetic public repeated material. ".repeat(6000), secondContextLimit: limit });
  calibrated(selected, observed);
  assert.ok(typeof selected.localEstimate === "number" && selected.localEstimate > limit);
  assert.ok(typeof selected.tokens === "number" && selected.tokens < limit);
});

test("a different persisted compaction window keeps the normal local fallback", async t => {
  const selected = await reopenedCli(t, "window");
  assert.equal(selected.basis, "local", JSON.stringify(selected));
  assert.equal(selected.tokens, selected.localEstimate);
});

test("another input endpoint cannot reuse the preceding connection's basis", async t => {
  const selected = await reopenedCli(t, "endpoint");
  assert.equal(selected.basis, "local", JSON.stringify(selected));
  assert.equal(selected.tokens, selected.localEstimate);
});

test("rotating only the synthetic credential does not change the measured request input identity", async t => {
  calibrated(await reopenedCli(t, "credential"));
});

test("official compaction writer and journal rebinding preserve calibration across normal process reopen", async t => {
  calibrated(await reopenedCli(t, "none", { compactCycle: true }));
});
