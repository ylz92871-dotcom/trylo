import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { summarizeTranscript, validateSummary } from "../../compaction/summary.js";
import {
  COMPACTION_FORMAT_VERSION,
  SUMMARY_MAX_CHARS,
} from "../../ports/compaction.js";
import { createFakeProvider, echoBinding, toolResult } from "../../loop/fakes.js";
import { runTurn, type LoopPorts, type RunTurnResult } from "../../loop/runner.js";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import type { ProviderEvent, ProviderMessage } from "../../ports/provider.js";
import type { SessionPort, SessionRecord } from "../../ports/session.js";
import type { CompactWindow } from "../../ports/compaction.js";
import { createCompactionService } from "../../compaction/service.js";
import type { ToolOutcome, ToolPort } from "../../ports/tools.js";
import type { Transcript } from "../../protocol/transcript.js";
import { createDenyAllPermission } from "./permission.js";
import {
  CHARS_PER_TOKEN,
  compactionWiring,
  compactRecordsOf,
  estimatePromptTokens,
  type CompactionWiringInput,
} from "./compaction-wiring.js";

/**
 * Compaction 落盘 contract (WP-HY4-V §3.1).
 *
 * The loop handed back windows; the composition root is the missing half. These
 * cases pin it end to end: the CLI's assembly carries the shipped summarizer,
 * the loop's drafts are appended through the same `SessionPort.append` every
 * other record uses, and a resume reads the stored window back from real bytes
 * on disk rather than replaying the text the window replaced.
 *
 * The journal cases go through a real NDJSON file. "Restart-safe" is a fact
 * about a file, and an in-memory double cannot demonstrate it.
 */

const ORIGINAL = "ORIGINAL-SEGMENT-MARKER";
const TOOL_OUTPUT = "TOOL-OUTPUT-MARKER";
const REQUEST = { sessionId: "s", turnId: "t", correlationId: "c", text: "use the tool" };

function scriptedProvider(calls: number): ReturnType<typeof createFakeProvider> {
  const script: Array<ReadonlyArray<ProviderEvent>> = [];

  for (let index = 0; index < calls; index += 1) {
    const text: ReadonlyArray<ProviderEvent> =
      index === 0
        ? [
            { type: "text_start", blockId: "b1" },
            { type: "text_delta", blockId: "b1", text: ORIGINAL },
            { type: "text_end", blockId: "b1" },
          ]
        : [];
    script.push([
      ...text,
      { type: "tool_call", toolCallId: `call-${index}`, name: "echo", arguments: { text: "hi" } },
      { type: "finish", reason: "tool_calls", rawReason: "tool_calls", requiresFollowUp: true },
    ]);
  }

  script.push([{ type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }]);

  return createFakeProvider(script);
}

function echoTools(): ToolPort {
  return {
    snapshot: () => [echoBinding({ needsApproval: false })],
    async execute(): Promise<ToolOutcome> {
      return toolResult({ echo: "hi" }, TOOL_OUTPUT);
    },
    async cancel(): Promise<void> {
      return;
    },
  };
}

/** A provider that records each request, so a prompt can be scanned. */
function recordingProvider(
  script: ReadonlyArray<ReadonlyArray<ProviderEvent>>,
  requests: Array<{ readonly messages: ReadonlyArray<ProviderMessage> }>,
): { readonly port: { stream: (r: never, s: AbortSignal) => AsyncIterable<ProviderEvent> } } {
  let index = 0;
  return {
    port: {
      async *stream(request: never): AsyncIterable<ProviderEvent> {
        requests.push(request as { readonly messages: ReadonlyArray<ProviderMessage> });
        const events = script[index] ?? [];
        index += 1;
        for (const event of events) {
          yield event;
        }
      },
    },
  };
}

/** The newest window the stored journal projects under, if any. */
function windowOfService(records: ReadonlyArray<SessionRecord>): CompactWindow | undefined {
  const projected = createCompactionService().projectForPrompt({ records });
  return projected.ok ? projected.view.window : undefined;
}

function portsOf(
  provider: ReturnType<typeof createFakeProvider>,
  wiring?: CompactionWiringInput,
): LoopPorts {
  return {
    provider,
    tools: echoTools(),
    permission: createDenyAllPermission(),
    profile: {
      async load() {
        return {
          learningMode: "no_learning" as const,
          userRules: [],
          promptPatches: [],
        } as never;
      },
    },
    ...(wiring === undefined ? {} : { compaction: compactionWiring(wiring) }),
  };
}

/** Appends a run's transcript items and then its compact drafts, in order. */
async function persistRun(
  session: SessionPort,
  result: RunTurnResult,
  resumed: Transcript,
  at: string,
): Promise<ReadonlyArray<string>> {
  const warnings: string[] = [];
  const lastResumed = resumed.length === 0 ? -1 : (resumed[resumed.length - 1]?.sequence ?? -1);

  for (const item of result.transcript.filter((entry) => entry.sequence > lastResumed)) {
    const appended = await session.append({
      type: "transcript_item",
      sessionId: "s",
      at,
      payload: JSON.parse(JSON.stringify(item)) as never,
    });
    if (!appended.ok) {
      warnings.push(`item:${appended.code}`);
    }
  }

  for (const draft of compactRecordsOf(result)) {
    const appended = await session.append({
      type: draft.type,
      sessionId: draft.sessionId,
      at: draft.at,
      payload: draft.payload,
    });
    if (!appended.ok) {
      warnings.push(`compact:${appended.code}`);
    }
  }

  return warnings;
}

function tempSession(): { readonly dir: string; readonly path: string } {
  const dir = mkdtempSync(join(tmpdir(), "v-compact-"));
  return { dir, path: join(dir, "session.ndjson") };
}

async function startedStore(path: string): Promise<SessionPort> {
  const store = createNdjsonSessionStore({ path });
  const started = await store.start({
    sessionId: "s",
    createdAt: "1970-01-01T00:00:00.000Z",
    fingerprint: {
      schemaVersion: "1",
      providerId: "fixture",
      model: "default",
      toolCatalogHash: "hash",
      workspaceId: "ws",
    },
  });

  assert.equal(started.ok, true);

  return store;
}

// ---------------------------------------------------------------------------
// V2 falling cases. Before the CLI assembly existed, `compactionWiring` did not
// bind the shipped summarizer and the host dropped every draft.
// ---------------------------------------------------------------------------

test("the shipped summarizer is what the CLI assembly carries", async () => {
  const items = [
    { kind: "user", sequence: 0, text: `read C:\\Users\\me\\secret.txt ${ORIGINAL}` } as const,
  ];
  const wiring = compactionWiring({ estimatePromptTokens: () => 0, nowMs: 0 });
  const summary = await wiring.summarize(items);

  assert.equal(summary, summarizeTranscript(items));
  assert.equal(summary.includes("Users"), false);
  assert.equal(summary.includes("[path]"), true);
});

test("the wiring the host builds is left to default to the shipped summarizer", async () => {
  // H5: the injection channel is the `summarize` field. The host's assembly is
  // the production caller, and it must not fill that field — the shipped
  // summarizer is the only author whose output `validateSummary` has already
  // been written against.
  const wiring = compactionWiring({ estimatePromptTokens, nowMs: 0 });

  assert.equal(await wiring.summarize([]), summarizeTranscript([]));
  // A caller-authored summary is *refused*, not rewritten: whatever a hostile
  // author hands in, no window is stored. This is the same refusal the loop
  // reports as a degradation rather than a stored record.
  assert.equal(validateSummary("wrote C:\\Users\\me\\notes.txt").ok, false);
  assert.equal(validateSummary(summarizeTranscript([
    { kind: "user", sequence: 0, text: "read C:\\Users\\me\\notes.txt" },
  ])).ok, true);
});

test("the estimator is pure and counts the messages it is given", () => {
  const messages: ProviderMessage[] = [{ role: "user", content: "a".repeat(40) }];
  assert.equal(estimatePromptTokens(messages), Math.ceil(40 / CHARS_PER_TOKEN));
  assert.equal(estimatePromptTokens([]), 0);
});

test("an over-limit turn hands back one window stamped with the budget's format", async () => {
  const provider = scriptedProvider(1);
  const result = await runTurn(portsOf(provider, { estimatePromptTokens: messages =>
    messages.some(message => message.content.startsWith("[compacted history")) ? 500 : 9_000, nowMs: 0 }), {
    ...REQUEST,
    budget: { maxIterations: 4, contextTokenLimit: 8_000 },
  });

  assert.equal(result.state.terminalReason, "completed");
  const records = compactRecordsOf(result);

  assert.equal(records.length, 1);
  assert.equal(records[0]?.payload.windowId, "w1");
  assert.equal(records[0]?.payload.formatVersion, COMPACTION_FORMAT_VERSION);
  assert.equal(records[0]?.payload.replacedFromSequence, 0);
  // The window is the shipped summarizer's digest, so it is non-empty and
  // bounded — the red line is the *shape*, not the absence of every word.
  assert.equal(records[0]?.payload.summary.length > 0, true);
  assert.equal(records[0]?.payload.summary.length <= SUMMARY_MAX_CHARS, true);
});

test("an appended window survives a fresh read of the same session file", async () => {
  const { dir, path } = tempSession();
  try {
    const session = await startedStore(path);
    const provider = scriptedProvider(1);
    const result = await runTurn(portsOf(provider, { estimatePromptTokens: () => 9_000, nowMs: 0 }), {
      ...REQUEST,
      budget: { maxIterations: 4, contextTokenLimit: 8_000 },
    });

    assert.deepEqual(await persistRun(session, result, [], "1970-01-01T00:00:00.000Z"), []);
    await session.release();

    // A second store over the same bytes: the window is on the record, not in
    // the first store's memory.
    const reopened = createNdjsonSessionStore({ path });
    const records = await reopened.readRecords();

    assert.equal(records.ok, true);

    if (!records.ok) {
      return;
    }

    const compactRows = records.view.records.filter((record) => record.type === "compact");

    assert.equal(compactRows.length, 1);
    assert.equal(compactRows[0]?.payload["windowId"], "w1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hostile summary stores no window and leaves the original text on the record", async () => {
  const { dir, path } = tempSession();
  try {
    const session = await startedStore(path);
    const provider = scriptedProvider(2);
    const result = await runTurn(
      portsOf(provider, {
        estimatePromptTokens: messages => messages.some(message => message.role === "assistant") ? 9_000 : 100,
        nowMs: 0,
        summarize: () => "wrote C:\\Users\\me\\notes.txt",
      }),
      { ...REQUEST, budget: { maxIterations: 5, contextTokenLimit: 8_000 } },
    );

    assert.equal(compactRecordsOf(result).length, 0);
    await persistRun(session, result, [], "1970-01-01T00:00:00.000Z");
    const records = await session.readRecords();

    assert.equal(records.ok, true);

    if (!records.ok) {
      return;
    }

    assert.equal(records.view.records.filter((record) => record.type === "compact").length, 0);
    assert.equal(JSON.stringify(records.view.records).includes(ORIGINAL), true);
    await session.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with no configured ceiling nothing is stored however large the estimate", async () => {
  const provider = scriptedProvider(1);
  const result = await runTurn(
    portsOf(provider, { estimatePromptTokens: () => 9_000_000, nowMs: 0 }),
    { ...REQUEST, budget: { maxIterations: 4 } },
  );
  assert.equal(compactRecordsOf(result).length, 0);
});

test("a resume over the stored window sends the summary and not the replaced text", async () => {
  const { dir, path } = tempSession();
  try {
    const session = await startedStore(path);
    const provider = scriptedProvider(1);
    const first = await runTurn(portsOf(provider, { estimatePromptTokens: () => 9_000, nowMs: 0 }), {
      ...REQUEST,
      budget: { maxIterations: 4, contextTokenLimit: 8_000 },
    });

    assert.equal(compactRecordsOf(first).length, 1);
    await persistRun(session, first, [], "1970-01-01T00:00:00.000Z");
    const loaded = await session.readRecords();

    assert.equal(loaded.ok, true);

    if (!loaded.ok) {
      return;
    }

    const stored = loaded.view.records;
    const window = windowOfService(stored);

    assert.notEqual(window, undefined);

    if (window === undefined) {
      return;
    }

    // A fresh turn over the same journal: what the model is shown is the
    // projection, not the whole transcript that still lives on disk.
    const requests: Array<{ readonly messages: ReadonlyArray<ProviderMessage> }> = [];
    const probe = recordingProvider(
      [[{ type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false }]],
      requests,
    );
    const second = await runTurn(
      portsOf(probe.port, { estimatePromptTokens: () => 10, nowMs: 0 }),
      {
        ...REQUEST,
        turnId: "t2",
        text: "continue",
        resumedTranscript: first.transcript,
        resumedWindow: window,
        resumedRecords: stored,
        budget: { maxIterations: 4, contextTokenLimit: 8_000 },
      },
    );

    assert.equal(second.state.terminalReason, "completed");
    const messages = requests[0]?.messages ?? [];
    // The replaced history is gone as *transcript items*: the model sees one
    // bounded system digest standing in for the whole replaced prefix, not the
    // original turns replayed. The shipped summarizer is extractive, so the
    // digest legitimately carries some of the original words — what must not
    // survive is the items themselves.
    const digests = messages.filter((m) => m.content.includes("[compacted history "));

    assert.equal(digests.length, 1);
    assert.equal(digests[0]?.role, "system");
    // Original user instructions stay outside the digest. Historical assistant
    // and tool items remain covered rather than being replayed wholesale.
    assert.deepEqual(
      messages.map((m) => m.role),
      ["system", "system", "user", "user"],
    );
    assert.equal(messages[0]?.content.includes("Available tools this run"), true);
    assert.equal(messages[2]?.content, REQUEST.text);
    assert.equal(messages[3]?.content, "continue");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
