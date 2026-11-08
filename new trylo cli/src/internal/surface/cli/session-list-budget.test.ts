import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import type { CliContext } from "./context.js";
import { handleSessionList, resolveLastSession, SESSION_PREVIEW_BUDGET } from "./session-list.js";
import { sessionPath } from "./session-paths.js";

/**
 * The preview budget (WP02): listing must not read every journal.
 *
 * `enrichSessions` used to read all journals fully, so a big sessions
 * directory paid a full parse per session for a list that shows twenty rows.
 * Rows beyond the budget keep their cheap sidecar facts and say the preview
 * was omitted instead of claiming a health they never measured.
 */

const FINGERPRINT = {
  schemaVersion: "1",
  workspaceId: "w",
  providerId: "fixture",
  model: "m",
  toolCatalogHash: "h",
} as const;

type Output = { readonly stdout: Array<string>; readonly stderr: Array<string> };

function context(home: string, output: Output): CliContext {
  return {
    homeDir: home,
    env: { TRYLO_HOME: home },
    cwd: home,
    nodeVersion: "v24",
    stdinIsTty: false,

    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },

    isDirectory: () => true,

    readDir: (path) => {
      try {
        return readdirSync(path, { withFileTypes: true }).map((entry) => {
          let bytes = 0;
          let modifiedAtMs = 0;

          try {
            const info = statSync(join(path, entry.name));
            bytes = info.size;
            modifiedAtMs = info.mtimeMs;
          } catch {
            // Vanished mid-list: unsized, still listed.
          }

          return { name: entry.name, bytes, modifiedAtMs };
        });
      } catch {
        return [];
      }
    },

    writeFile: () => false,
    readStdin: async () => "",
    readLine: async () => undefined,
    readSecret: async () => undefined,
    stdout: (text) => output.stdout.push(text),
    stderr: (text) => output.stderr.push(text),
    now: () => 1_000_000,
    newId: (prefix) => `${prefix}-forked`,
  };
}

async function writeSession(homeDir: string, id: string, text: string, mtimeMs: number): Promise<void> {
  const file = sessionPath(homeDir, { TRYLO_HOME: homeDir }, id);
  const store = createNdjsonSessionStore({ path: file });

  await store.start({ sessionId: id, createdAt: "2026-10-04T00:00:00.000Z", fingerprint: FINGERPRINT });
  await store.append({ type: "transcript_item", sessionId: id, at: "2026-10-04T00:00:01.000Z", payload: { kind: "user", sequence: 0, text } });
  await store.release();
  const atime = new Date(mtimeMs);

  utimesSync(file, atime, atime);
}

async function bigHome(count: number): Promise<{ readonly dir: string; readonly cleanup: () => void }> {
  const dir = mkdtempSync(join(os.tmpdir(), "trylo-wp02-budget-"));
  const base = 1_700_000_000_000;

  for (let index = 0; index < count; index += 1) {
    const id = `s${String(index).padStart(3, "0")}`;
    await writeSession(dir, id, `hello from ${id}`, base + index * 1000);
  }

  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("rows beyond the budget keep sidecar facts and say the preview was omitted", async () => {
  const fx = await bigHome(SESSION_PREVIEW_BUDGET + 5);
  try {
    const output: Output = { stdout: [], stderr: [] };
    const code = await handleSessionList(context(fx.dir, output), { all: true, json: true });

    assert.equal(code, 0);
    const parsed = JSON.parse(output.stdout.join("")) as {
      sessions: ReadonlyArray<{ id: string; preview: string | null; previewOmitted: boolean; health: string }>;
    };

    assert.equal(parsed.sessions.length, SESSION_PREVIEW_BUDGET + 5);
    // Newest-first: the budget covers the newest rows.
    const newest = parsed.sessions.slice(0, SESSION_PREVIEW_BUDGET);

    assert.ok(newest.every((row) => row.preview !== null && row.previewOmitted === false));
    const oldest = parsed.sessions.slice(SESSION_PREVIEW_BUDGET);

    assert.equal(oldest.length, 5);

    for (const row of oldest) {
      assert.equal(row.preview, null);
      assert.equal(row.previewOmitted, true);
      assert.equal(row.health, "preview-omitted");
    }

    // The oldest row is still found by id: search never needed a journal.
    const search: Output = { stdout: [], stderr: [] };

    await handleSessionList(context(fx.dir, search), { search: "s000", all: true, json: true });
    const found = JSON.parse(search.stdout.join("")) as { sessions: ReadonlyArray<{ id: string; previewOmitted: boolean }> };

    assert.equal(found.sessions.length, 1);
    assert.equal(found.sessions[0]?.id, "s000");
    assert.equal(found.sessions[0]?.previewOmitted, true);
  } finally {
    fx.cleanup();
  }
});

test("a small directory reads everything and omits nothing", async () => {
  const fx = await bigHome(3);
  try {
    const output: Output = { stdout: [], stderr: [] };
    const code = await handleSessionList(context(fx.dir, output), { all: true, json: true });

    assert.equal(code, 0);
    const parsed = JSON.parse(output.stdout.join("")) as {
      sessions: ReadonlyArray<{ preview: string | null; previewOmitted: boolean; health: string }>;
    };

    assert.equal(parsed.sessions.length, 3);
    assert.ok(parsed.sessions.every((row) => row.preview !== null && row.previewOmitted === false && row.health === "ok"));
  } finally {
    fx.cleanup();
  }
});

test("--last still names the newest session", async () => {
  const fx = await bigHome(SESSION_PREVIEW_BUDGET + 5);
  try {
    const output: Output = { stdout: [], stderr: [] };
    const outcome = await resolveLastSession(context(fx.dir, output));
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.sessionId, `s${String(SESSION_PREVIEW_BUDGET + 4).padStart(3, "0")}`);
  } finally {
    fx.cleanup();
  }
});
