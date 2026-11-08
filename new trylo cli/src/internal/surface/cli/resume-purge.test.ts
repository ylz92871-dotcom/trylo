import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createNdjsonSessionStore, encodeLine } from "../../adapters/session-store/ndjson.js";
import { emptyUsage, type ProviderPort, type ProviderRequest } from "../../ports/provider.js";
import { SESSION_FORMAT_VERSION, type SessionRecord } from "../../ports/session.js";
import type { JsonObject } from "../../protocol/envelope.js";
import type { Transcript, TranscriptItem } from "../../protocol/transcript.js";
import { createFakePermission, createFakeTools, emptyProfileLoader } from "../../loop/fakes.js";
import { runTurn, type LoopPorts } from "../../loop/runner.js";

/**
 * The resume contract the purge exists for (WP §3): after a crash between a
 * tool call and its result, the *next provider request* carries neither the
 * unfinished call nor an invented answer.
 *
 * The in-store tests pin the projection; this one pins what actually leaves the
 * loop, because that is the observable the contract is written against. The
 * fixture provider cannot discriminate here (it reacts to any tool message), so
 * the provider is a recorder and the assertion is on the request it was handed.
 */

const SESSION_ID = "torn-session";

function recordingProvider(): { readonly requests: ProviderRequest[]; readonly port: ProviderPort } {
  const requests: ProviderRequest[] = [];
  return {
    requests,
    port: {
      async *stream(request) {
        requests.push(request);
        yield { type: "text_start", blockId: "b1" };
        yield { type: "text_delta", blockId: "b1", text: "continuing." };
        yield { type: "text_end", blockId: "b1" };
        yield { type: "usage", usage: emptyUsage("snapshot") };
        yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
      },
    },
  };
}

/** `Omit` does not distribute over a union, so the item bodies get their own helper. */
type ItemBody = TranscriptItem extends infer T ? (T extends { sequence: number } ? Omit<T, "sequence"> : never) : never;

function item(sequence: number, body: ItemBody): TranscriptItem {
  return { sequence, ...body } as TranscriptItem;
}

function journalLine(sequence: number, record: Omit<SessionRecord, "formatVersion" | "sequence">): string {
  return encodeLine(sequence, { ...record, formatVersion: SESSION_FORMAT_VERSION, sequence });
}

function transcriptLine(sequence: number, value: TranscriptItem): string {
  return journalLine(sequence, {
    type: "transcript_item",
    sessionId: SESSION_ID,
    at: "1970-01-01T00:00:00.000Z",
    payload: value as unknown as JsonObject,
  });
}

function tornJournal(): string {
  const lines = [
    journalLine(0, {
      type: "session_start",
      sessionId: SESSION_ID,
      at: "1970-01-01T00:00:00.000Z",
      payload: {
        fingerprint: {
          schemaVersion: SESSION_FORMAT_VERSION,
          providerId: "fixture",
          model: "m",
          toolCatalogHash: "h",
          workspaceId: "w",
        },
      },
    }),
    transcriptLine(1, item(0, { kind: "user", text: "write the file" })),
    transcriptLine(2, item(1, { kind: "assistant_text", blockId: "b1", text: "writing now" })),
    transcriptLine(
      3,
      item(2, {
        kind: "tool_call",
        toolCallId: "call-torn-write",
        name: "write_file",
        arguments: { path: "out.txt", content: "x" },
      }),
    ),
  ];
  return `${lines.join("\n")}\n`;
}

test("the next request after a torn resume carries no unfinished tool call and no invented result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "trylo-resume-purge-"));
  try {
    const path = join(dir, "sessions", `${SESSION_ID}.ndjson`);

    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, tornJournal());

    const store = createNdjsonSessionStore({ path });
    const attached = await store.attach();

    assert.equal(attached.ok, true);
    const recovered = await store.read();

    await store.release();
    assert.equal(recovered.ok, true);

    if (!recovered.ok) {
      return;
    }

    const { requests, port } = recordingProvider();
    const ports: LoopPorts = {
      provider: port,
      tools: createFakeTools([]),
      permission: createFakePermission("denied"),
      profile: emptyProfileLoader(),
    };
    const result = await runTurn(ports, {
      sessionId: SESSION_ID,
      turnId: "t2",
      correlationId: "c2",
      text: "go on",
      model: "m",
      resumedTranscript: recovered.session.transcript as Transcript,
    });

    assert.equal(result.state.phase, "terminal");
    assert.equal(requests.length, 1);
    const messages = requests[0]?.messages ?? [];
    const withToolCalls = messages.filter((message) => message.toolCalls !== undefined);

    assert.deepEqual(
      withToolCalls.map((message) => message.toolCalls?.map((call) => call.toolCallId)),
      [],
      "no unfinished tool call may reach the provider",
    );
    assert.equal(
      messages.some((message) => message.role === "tool"),
      false,
      "a dropped request must not be answered with a synthesised result",
    );
    // The settled part of the conversation is still there, in order — behind
    // the tool list, which rides with the seed ahead of all history.
    assert.equal(messages[0]?.role, "system");
    assert.equal(messages[1]?.role, "user");
    assert.equal(messages[2]?.role, "assistant");
    assert.equal(messages.at(-1)?.role, "user");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
