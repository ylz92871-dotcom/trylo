import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { loadSessionMeta } from "../../adapters/session-store/session-meta.js";
import type { RuntimeFingerprint } from "../../ports/session.js";
import type { CliContext } from "./context.js";
import {
  handleSessionArchive,
  handleSessionExport,
  handleSessionFork,
  handleSessionInfo,
  handleSessionRemove,
  handleSessionRename,
} from "./commands-session.js";
import { handleSessionList, resolveLastSession } from "./session-list.js";
import { openSession } from "./session-open.js";
import { sessionsDir, sessionPath } from "./session-paths.js";

/**
 * WP02 handler contract (red-first, in that order per file).
 *
 * Every test builds a real journal in a temp home through the real store, so
 * what is asserted is the user-visible result of the same bytes the product
 * writes: list rows, fork independence, migration logs, and the failures that
 * must stay visible instead of silent.
 */

const FINGERPRINT: RuntimeFingerprint = {
  schemaVersion: "1",
  providerId: "fixture",
  model: "m",
  toolCatalogHash: "h",
  workspaceId: "w",
};

type Output = { readonly stdout: Array<string>; readonly stderr: Array<string> };

function context(home: string, output: Output, now = 1_000_000): CliContext {
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
    now: () => now,
    newId: (prefix) => `${prefix}-forked`,
  };
}

function home(): { readonly dir: string; readonly cleanup: () => void } {
  const dir = mkdtempSync(join(os.tmpdir(), "trylo-wp02-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function writeSession(homeDir: string, id: string, turns: ReadonlyArray<string>): Promise<void> {
  const store = createNdjsonSessionStore({ path: sessionPath(homeDir, { TRYLO_HOME: homeDir }, id) });

  await store.start({ sessionId: id, createdAt: "2026-10-04T00:00:00.000Z", fingerprint: FINGERPRINT });
  let sequence = 0;

  for (const text of turns) {
    await store.append({ type: "transcript_item", sessionId: id, at: "2026-10-04T00:00:01.000Z", payload: { kind: "user", sequence, text } });
    sequence += 1;
  }

  await store.release();
}

function textOf(output: Output): string {
  return output.stdout.join("");
}

// --- WP02.1 list & select ---

test("an empty home lists no sessions and points at the way out", async () => {
  const fx = home();
  try {
    const output: Output = { stdout: [], stderr: [] };
    const code = await handleSessionList(context(fx.dir, output), { all: false, json: false });
    assert.equal(code, 0);
    assert.match(textOf(output), /no sessions in/);
  } finally {
    fx.cleanup();
  }
});

test("list shows names and first lines once renamed", async () => {
  const fx = home();
  try {
    await writeSession(fx.dir, "demo", ["hello world"]);
    const output: Output = { stdout: [], stderr: [] };
    const ctx = context(fx.dir, output);

    assert.equal(await handleSessionRename(ctx, { session: "demo", name: "My demo" }), 0);
    const listed: Output = { stdout: [], stderr: [] };

    assert.equal(await handleSessionList(context(fx.dir, listed), { all: false, json: false }), 0);
    assert.match(listed.stdout.join(""), /My demo/);
    assert.match(listed.stdout.join(""), /hello world/);
  } finally {
    fx.cleanup();
  }
});

test("a corrupt journal stays listed with a visible marker, not silence", async () => {
  const fx = home();
  try {
    await writeSession(fx.dir, "broken", ["hi"]);
    writeFileSync(sessionPath(fx.dir, { TRYLO_HOME: fx.dir }, "broken"), "not ndjson\n", "utf8");
    const output: Output = { stdout: [], stderr: [] };
    const code = await handleSessionList(context(fx.dir, output), { all: false, json: false });

    assert.equal(code, 0);
    assert.match(textOf(output), /broken/);
    assert.match(textOf(output), /unreadable/);
    const info: Output = { stdout: [], stderr: [] };

    assert.equal(await handleSessionInfo(context(fx.dir, info), { session: "broken", json: false }), 52);
  } finally {
    fx.cleanup();
  }
});

test("archive hides from the default list but not from --all, info, or explicit resume", async () => {
  const fx = home();
  try {
    await writeSession(fx.dir, "parked", ["park me"]);
    const output: Output = { stdout: [], stderr: [] };
    const ctx = context(fx.dir, output);

    assert.equal(await handleSessionArchive(ctx, { session: "parked", archived: true }), 0);
    const listed: Output = { stdout: [], stderr: [] };

    await handleSessionList(context(fx.dir, listed), { all: false, json: false });
    assert.doesNotMatch(listed.stdout.join(""), /parked/);
    const all: Output = { stdout: [], stderr: [] };

    await handleSessionList(context(fx.dir, all), { all: true, json: false });
    assert.match(all.stdout.join(""), /parked/);
    const info: Output = { stdout: [], stderr: [] };

    assert.equal(await handleSessionInfo(context(fx.dir, info), { session: "parked", json: false }), 0);
    const last = await resolveLastSession(context(fx.dir, { stdout: [], stderr: [] }));

    assert.equal(last.ok, false);
    assert.equal(await handleSessionArchive(ctx, { session: "parked", archived: false }), 0);
    const relisted: Output = { stdout: [], stderr: [] };

    await handleSessionList(context(fx.dir, relisted), { all: false, json: false });
    assert.match(relisted.stdout.join(""), /parked/);
  } finally {
    fx.cleanup();
  }
});

test("search narrows by id or name", async () => {
  const fx = home();
  try {
    await writeSession(fx.dir, "alpha", ["first"]);
    await writeSession(fx.dir, "beta", ["second"]);
    const output: Output = { stdout: [], stderr: [] };
    const ctx = context(fx.dir, output);

    assert.equal(await handleSessionRename(ctx, { session: "alpha", name: "Special project" }), 0);
    const found: Output = { stdout: [], stderr: [] };

    await handleSessionList(context(fx.dir, found), { search: "special", all: false, json: false });
    assert.match(found.stdout.join(""), /alpha/);
    assert.doesNotMatch(found.stdout.join(""), /beta/);
  } finally {
    fx.cleanup();
  }
});

// --- remove ---

test("remove deletes journal and sidecar, and names what is gone", async () => {
  const fx = home();
  try {
    await writeSession(fx.dir, "gone", ["bye"]);
    const output: Output = { stdout: [], stderr: [] };
    const ctx = context(fx.dir, output);

    assert.equal(await handleSessionRename(ctx, { session: "gone", name: "temp" }), 0);
    const removed: Output = { stdout: [], stderr: [] };

    assert.equal(handleSessionRemove(context(fx.dir, removed), { session: "gone", json: false }), 0);
    assert.match(removed.stdout.join(""), /and sidecar/);
    const info: Output = { stdout: [], stderr: [] };

    assert.equal(await handleSessionInfo(context(fx.dir, info), { session: "gone", json: false }), 52);
  } finally {
    fx.cleanup();
  }
});

test("remove refuses a missing session and a live lock", async () => {
  const fx = home();
  try {
    const missing: Output = { stdout: [], stderr: [] };

    assert.equal(handleSessionRemove(context(fx.dir, missing), { session: "nope", json: false }), 52);
    await writeSession(fx.dir, "busy", ["work"]);
    const store = createNdjsonSessionStore({ path: sessionPath(fx.dir, { TRYLO_HOME: fx.dir }, "busy") });

    await store.attach();

    try {
      const locked: Output = { stdout: [], stderr: [] };
      assert.equal(handleSessionRemove(context(fx.dir, locked), { session: "busy", json: false }), 52);
      assert.match(locked.stderr.join(""), /live writer/);
    } finally {
      await store.release();
    }
  } finally {
    fx.cleanup();
  }
});

// --- export ---

test("export prints the transcript as json and as markdown", async () => {
  const fx = home();
  try {
    await writeSession(fx.dir, "story", ["once upon a time"]);
    const json: Output = { stdout: [], stderr: [] };

    assert.equal(await handleSessionExport(context(fx.dir, json), { session: "story", format: "json" }), 0);
    const parsed = JSON.parse(json.stdout.join("")) as { transcript: Array<{ text: string }> };

    assert.equal(parsed.transcript[0]?.text, "once upon a time");
    const markdown: Output = { stdout: [], stderr: [] };

    assert.equal(await handleSessionExport(context(fx.dir, markdown), { session: "story", format: "markdown" }), 0);
    assert.match(markdown.stdout.join(""), /### user/);
    assert.match(markdown.stdout.join(""), /once upon a time/);
  } finally {
    fx.cleanup();
  }
});

// --- WP02.2 fork ---

test("a fork resumes independently and leaves the parent untouched", async () => {
  const fx = home();
  try {
    await writeSession(fx.dir, "parent", ["parent words"]);
    const output: Output = { stdout: [], stderr: [] };
    const ctx = context(fx.dir, output);

    assert.equal(await handleSessionFork(ctx, { session: "parent", interrupted: false, json: false }), 0);
    assert.match(output.stdout.join(""), /parent -> session-forked/);
    const dir = sessionsDir(fx.dir, { TRYLO_HOME: fx.dir });
    const meta = loadSessionMeta(dir, "session-forked");

    assert.equal(meta.ok, true);

    if (!meta.ok) return;

    assert.equal(meta.meta.forkedFrom?.parentSessionId, "parent");
    const child = await openSession(ctx, { resume: "session-forked", message: [], readStdin: false }, FINGERPRINT);
    if (child.kind === "resume") {
      await child.session.release();
    }

    assert.equal(child.kind, "resume");

    if (child.kind !== "resume") return;

    assert.equal(child.transcript.length, 1);
    const parent = await openSession(ctx, { resume: "parent", message: [], readStdin: false }, FINGERPRINT);
    if (parent.kind === "resume") {
      await parent.session.release();
    }

    assert.equal(parent.kind, "resume");
  } finally {
    fx.cleanup();
  }
});

test("forking onto a taken id refuses without touching it", async () => {
  const fx = home();
  try {
    await writeSession(fx.dir, "parent", ["words"]);
    await writeSession(fx.dir, "taken", ["other"]);
    const output: Output = { stdout: [], stderr: [] };

    assert.equal(
      await handleSessionFork(context(fx.dir, output), { session: "parent", newId: "taken", interrupted: false, json: false }),
      52,
    );
    const info: Output = { stdout: [], stderr: [] };

    assert.equal(await handleSessionInfo(context(fx.dir, info), { session: "taken", json: true }), 0);
    const taken = JSON.parse(info.stdout.join("")) as { records: number; forkedFrom: null };

    assert.equal(taken.records, 2);
    assert.equal(taken.forkedFrom, null);
  } finally {
    fx.cleanup();
  }
});

// --- WP02.3 migration ---

test("a model change refuses resume until --migrate names it, then logs the fact", async () => {
  const fx = home();
  try {
    await writeSession(fx.dir, "traveller", ["carry me"]);
    const output: Output = { stdout: [], stderr: [] };
    const ctx = context(fx.dir, output);
    const moved: RuntimeFingerprint = { ...FINGERPRINT, model: "next" };
    const refused = await openSession(ctx, { resume: "traveller", message: [], readStdin: false }, moved);

    assert.equal(refused.kind, "failed");
    const migrated = await openSession(
      ctx,
      { resume: "traveller", message: [], readStdin: false, migrateModel: true },
      moved,
    );
    if (migrated.kind === "resume") {
      await migrated.session.release();
    }

    assert.equal(migrated.kind, "resume");
    const dir = sessionsDir(fx.dir, { TRYLO_HOME: fx.dir });
    const meta = loadSessionMeta(dir, "traveller");

    assert.equal(meta.ok, true);

    if (!meta.ok) return;

    assert.equal(meta.meta.migrations?.length, 1);
    assert.deepEqual(meta.meta.migrations?.[0]?.scope, ["model"]);
  } finally {
    fx.cleanup();
  }
});

test("workspace and provider drift never migrate, even when asked", async () => {
  const fx = home();
  try {
    await writeSession(fx.dir, "rooted", ["home"]);
    const output: Output = { stdout: [], stderr: [] };
    const ctx = context(fx.dir, output);
    const elsewhere = await openSession(
      ctx,
      { resume: "rooted", message: [], readStdin: false, migrateModel: true, migrateCatalog: true },
      { ...FINGERPRINT, workspaceId: "elsewhere" },
    );

    assert.equal(elsewhere.kind, "failed");
    const rehomed = await openSession(
      ctx,
      { resume: "rooted", message: [], readStdin: false, migrateModel: true, migrateCatalog: true },
      { ...FINGERPRINT, providerId: "other" },
    );

    assert.equal(rehomed.kind, "failed");
    const intact = await openSession(ctx, { resume: "rooted", message: [], readStdin: false }, FINGERPRINT);
    if (intact.kind === "resume") {
      await intact.session.release();
    }

    assert.equal(intact.kind, "resume");
  } finally {
    fx.cleanup();
  }
});
