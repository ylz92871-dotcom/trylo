import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DocumentSynchroniser } from "./lsp-documents.js";

/**
 * A connection that records notifications instead of speaking the protocol.
 * The synchroniser's whole job is *which* verb it sends and in what order, so
 * the double records the decision rather than emulating a server.
 */
function recorder(): { sent: Array<{ method: string; params: unknown }>; connection: unknown } {
  const sent: Array<{ method: string; params: unknown }> = [];
  return {
    sent,
    connection: {
      sendNotification: async (method: string, params: unknown) => {
        sent.push({ method, params });
      },
    },
  };
}

const DOC = { path: "src/a.ts", languageId: "typescript", text: "export const x = 1;" };

describe("DocumentSynchroniser", () => {
  it("opens a document the server has not seen", async () => {
    const { sent, connection } = recorder();
    const sync = new DocumentSynchroniser("D:/w");
    const result = await sync.push(connection as never, DOC);

    assert.equal(result.ok, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.method, "textDocument/didOpen");
    assert.equal(sync.heldCount, 1);
  });

  it("changes rather than re-opens a document the server already holds", async () => {
    // The protocol treats a second didOpen for a held URI as an error, and a
    // picker queries the same file repeatedly — so this is the common path.
    const { sent, connection } = recorder();
    const sync = new DocumentSynchroniser("D:/w");

    await sync.push(connection as never, DOC);
    await sync.push(connection as never, { ...DOC, text: "export const x = 2;" });
    assert.deepEqual(sent.map((entry) => entry.method), ["textDocument/didOpen", "textDocument/didChange"]);
    const change = sent[1]?.params as { contentChanges: Array<{ text: string }> };

    assert.equal(change.contentChanges[0]?.text, "export const x = 2;");
  });

  it("advances the version so a server can order the changes", async () => {
    const { sent, connection } = recorder();
    const sync = new DocumentSynchroniser("D:/w");

    await sync.push(connection as never, { ...DOC, version: 4 });
    await sync.push(connection as never, { ...DOC, version: 99 });
    // A didChange the server cannot order is a didChange it may drop, so the
    // synchroniser's own counter wins over whatever the caller passed.
    const change = sent[1]?.params as { textDocument: { version: number } };

    assert.equal(change.textDocument.version, 5);
  });

  it("keeps two files independent", async () => {
    const { sent, connection } = recorder();
    const sync = new DocumentSynchroniser("D:/w");
    await sync.push(connection as never, DOC);
    await sync.push(connection as never, { ...DOC, path: "src/b.ts" });
    assert.deepEqual(sent.map((entry) => entry.method), ["textDocument/didOpen", "textDocument/didOpen"]);
  });

  it("forgets everything when the connection is gone", async () => {
    // A new server has never seen these files, so a replayed didChange would ask
    // it to update a document it never opened.
    const { sent, connection } = recorder();
    const sync = new DocumentSynchroniser("D:/w");

    await sync.push(connection as never, DOC);
    sync.reset();
    assert.equal(sync.heldCount, 0);
    await sync.push(connection as never, { ...DOC, text: "changed" });
    assert.equal(sent[1]?.method, "textDocument/didOpen");
  });

  it("reports a refusal instead of claiming the file was opened", async () => {
    const sync = new DocumentSynchroniser("D:/w");
    const failing = {
      sendNotification: async () => {
        throw new Error("unsupported language");
      },
    };
    const result = await sync.push(failing as never, DOC);

    assert.equal(result.ok, false);

    if (result.ok) return;

    assert.match(result.message, /didOpen failed for src\/a\.ts/);
    // A refused document is not remembered as held, so a retry starts clean.
    assert.equal(sync.heldCount, 0);
  });

  it("does not remember a document whose first change failed", async () => {
    let calls = 0;
    const flaky = {
      sendNotification: async () => {
        calls += 1;
        if (calls === 1) throw new Error("transient");
      },
    };
    const sync = new DocumentSynchroniser("D:/w");

    assert.equal((await sync.push(flaky as never, DOC)).ok, false);
    // Second attempt must be a fresh open, not a change to a file never opened.
    assert.equal((await sync.push(flaky as never, DOC)).ok, true);
    assert.equal(calls, 2);
    assert.equal(sync.heldCount, 1);
  });
});
