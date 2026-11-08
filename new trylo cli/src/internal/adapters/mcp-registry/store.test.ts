import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createMcpRegistry } from "./store.js";
import type { McpAddInput } from "../../ports/mcp-registry.js";

/**
 * M1 + M2: the registry port and its two-file store.
 *
 * Contract facts being tested:
 *   - `add` validates shape and refuses a same-name same-scope duplicate;
 *   - `remove` of an absent entry is an explicit code, not a silent no-op;
 *   - `enable`/`disable` touch only `enabled`;
 *   - `list` merges user + project with project winning the overridable fields,
 *     and never exposes env *values*;
 *   - `resolve` reports which scope won and which were shadowed;
 *   - a corrupt / empty / unknown-version file fails the whole view, never
 *     degrades to "no servers";
 *   - a second writer on the same file is refused by the lock.
 */

function tempPaths() {
  const dir = mkdtempSync(join(os.tmpdir(), "trylo-mcp-registry-"));
  mkdirSync(join(dir, "user"), { recursive: true });
  mkdirSync(join(dir, "project"), { recursive: true });
  return { dir, userFile: join(dir, "user", "mcp-servers.json"), projectFile: join(dir, "project", "mcp-servers.json") };
}

function entry(overrides: Partial<McpAddInput> = {}): McpAddInput {
  return {
    name: "fs",
    transport: "stdio",
    command: "node",
    args: ["server.mjs"],
    env: {},
    enabled: true,
    scope: "user",
    ...overrides,
  };
}

test("add, list (redacted), resolve, remove round-trip on one scope", async () => {
  const paths = tempPaths();
  try {
    const registry = createMcpRegistry(paths);
    const added = await registry.add(entry({ env: { TOKEN: "do-not-show" } }));

    assert.equal(added.ok, true);

    const listed = await registry.list();

    assert.equal(listed.ok, true);

    if (listed.ok) {
      const server = listed.value.servers[0];
      assert.equal(server?.name, "fs");
      assert.deepEqual(server?.envKeys, ["TOKEN"]);
      // Adversarial #11: the value never reaches the public view.
      assert.equal(JSON.stringify(listed.value).includes("do-not-show"), false);
    }

    const removed = await registry.remove({ name: "fs", scope: "user" });

    assert.equal(removed.ok, true);
    const names = await registry.names();

    assert.deepEqual(names.ok ? names.value : [], []);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("add validates shape and names the failure precisely", async () => {
  const paths = tempPaths();
  try {
    const registry = createMcpRegistry(paths);
    const badName = await registry.add(entry({ name: "NOT_LEGAL" }));

    assert.equal(badName.ok, false);

    if (!badName.ok) {
      assert.equal(badName.code, "invalid_name");
    }

    const websocket = await registry.add(entry({ transport: "websocket" as never }));

    assert.equal(websocket.ok, false);

    if (!websocket.ok) {
      assert.equal(websocket.code, "unsupported_transport");
    }

    const remoteMissingUrl = await registry.add(entry({ transport: "http" }));

    assert.equal(remoteMissingUrl.ok, false);

    if (!remoteMissingUrl.ok) {
      // T1: http is now a *legal* transport, but a remote entry without a url
      // is a shape failure, not an unsupported transport.
      assert.equal(remoteMissingUrl.code, "invalid_command");
    }

    const badArgs = await registry.add(entry({ args: ["a", 3] as never }));

    assert.equal(badArgs.ok, false);

    if (!badArgs.ok) {
      assert.equal(badArgs.code, "invalid_args");
    }
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("adversarial #4: a same-name same-scope add is refused and the old entry survives", async () => {
  const paths = tempPaths();
  try {
    const registry = createMcpRegistry(paths);

    assert.equal((await registry.add(entry())).ok, true);
    const second = await registry.add(entry({ command: "evil", args: [] }));

    assert.equal(second.ok, false);

    if (!second.ok) {
      assert.equal(second.code, "duplicate_entry");
    }

    const resolved = await registry.resolve("fs");

    assert.equal(resolved.ok, true);

    if (resolved.ok) {
      assert.equal(resolved.value.entry.command, "node");
    }
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("remove of an absent entry is an explicit missing_entry code", async () => {
  const paths = tempPaths();
  try {
    const registry = createMcpRegistry(paths);
    const removed = await registry.remove({ name: "ghost", scope: "user" });
    assert.equal(removed.ok, false);
    if (!removed.ok) {
      assert.equal(removed.code, "missing_entry");
    }
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("enable/disable changes only enabled and nothing else", async () => {
  const paths = tempPaths();
  try {
    const registry = createMcpRegistry(paths);

    await registry.add(entry({ command: "node", args: ["x"] }));
    const disabled = await registry.setEnabled({ name: "fs", scope: "user" }, false);

    assert.equal(disabled.ok, true);

    if (disabled.ok) {
      assert.equal(disabled.value.enabled, false);
      assert.equal(disabled.value.command, "node");
      assert.deepEqual(disabled.value.args, ["x"]);
    }
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("project scope overrides user scope's enabled and command on merge", async () => {
  const paths = tempPaths();
  try {
    const registry = createMcpRegistry(paths);

    await registry.add(entry({ scope: "user", command: "user-cmd", enabled: true }));
    await registry.add(entry({ scope: "project", command: "project-cmd", enabled: false }));

    const listed = await registry.list();

    assert.equal(listed.ok, true);

    if (listed.ok) {
      assert.equal(listed.value.servers.length, 1);
      const server = listed.value.servers[0];
      assert.equal(server?.command, "project-cmd");
      assert.equal(server?.enabled, false);
      assert.deepEqual([...(server?.scopes ?? [])].sort(), ["project", "user"]);
    }

    const resolved = await registry.resolve("fs");

    assert.equal(resolved.ok, true);

    if (resolved.ok) {
      assert.equal(resolved.value.scope, "project");
      assert.deepEqual(resolved.value.shadowedScopes, ["user"]);
      assert.equal(resolved.value.entry.command, "project-cmd");
    }
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("the same name may live in both scopes as separate documents", async () => {
  const paths = tempPaths();
  try {
    const registry = createMcpRegistry(paths);
    assert.equal((await registry.add(entry({ scope: "user" }))).ok, true);
    assert.equal((await registry.add(entry({ scope: "project" }))).ok, true);
    const names = await registry.names();
    assert.deepEqual(names.ok ? names.value : [], ["fs"]);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("a corrupt document fails the view instead of reading as empty", async () => {
  const paths = tempPaths();
  try {
    writeFileSync(paths.userFile, "{ not json", "utf8");
    const registry = createMcpRegistry(paths);
    const listed = await registry.list();
    assert.equal(listed.ok, false);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("an empty file is a failed write, not an empty registry", async () => {
  const paths = tempPaths();
  try {
    writeFileSync(paths.userFile, "", "utf8");
    const registry = createMcpRegistry(paths);
    const listed = await registry.list();

    assert.equal(listed.ok, false);

    if (!listed.ok) {
      assert.equal(listed.code, "invalid_document");
    }
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("a second writer on the same scope is refused by the lock file", async () => {
  const paths = tempPaths();
  try {
    const registry = createMcpRegistry(paths);

    // Simulate another live writer holding the lock.
    writeFileSync(`${paths.userFile}.lock`, "999\n", "utf8");
    const added = await registry.add(entry());

    assert.equal(added.ok, false);

    if (!added.ok) {
      assert.equal(added.code, "lock_conflict");
    }
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("a write replaces the whole document, never appending a second formatVersion", async () => {
  const paths = tempPaths();
  try {
    const registry = createMcpRegistry(paths);

    for (let i = 0; i < 5; i += 1) {
      await registry.add(entry({ name: `s${i}` }));
    }

    const raw = readFileSync(paths.userFile, "utf8");
    // Whole-file replace: the document must parse as one object with one
    // formatVersion, not accumulate a second one from repeated appends.
    const doc = JSON.parse(raw) as { formatVersion: number; servers: unknown[] };

    assert.equal(doc.formatVersion, 1);
    assert.equal(doc.servers.length, 5);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T1: remote entries through the port. Header *values* are secret-bearing and
// must never reach the public view, exactly like env values.
// ---------------------------------------------------------------------------

function remoteEntry(overrides: Partial<McpAddInput> = {}): McpAddInput {
  return {
    name: "remote",
    transport: "http",
    command: "",
    args: [],
    env: {},
    enabled: true,
    scope: "user",
    url: "https://example.com/mcp",
    headers: { Authorization: "do-not-show" },
    ...overrides,
  };
}

test("T1: add, list (header keys only), resolve, remove round-trip a remote entry", async () => {
  const paths = tempPaths();
  try {
    const registry = createMcpRegistry(paths);
    const added = await registry.add(remoteEntry());

    assert.equal(added.ok, true);

    if (added.ok) {
      assert.equal(added.value.url, "https://example.com/mcp");
      assert.deepEqual(added.value.headers, { Authorization: "do-not-show" });
    }

    const listed = await registry.list();

    assert.equal(listed.ok, true);

    if (listed.ok) {
      const server = listed.value.servers[0];

      assert.equal(server?.transport, "http");
      assert.equal(server?.url, "https://example.com/mcp");
      assert.deepEqual(server?.headerKeys, ["Authorization"]);
      assert.deepEqual(server?.envKeys, []);
      // The header value never reaches the public view.
      assert.equal(JSON.stringify(listed.value).includes("do-not-show"), false);
    }

    const resolved = await registry.resolve("remote");

    assert.equal(resolved.ok, true);

    if (resolved.ok) {
      assert.equal(resolved.value.entry.command, "");
      assert.equal(resolved.value.entry.url, "https://example.com/mcp");
    }

    const removed = await registry.remove({ name: "remote", scope: "user" });

    assert.equal(removed.ok, true);
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("T1: remote entries refuse the stdio-only fields through the port", async () => {
  const paths = tempPaths();
  try {
    const registry = createMcpRegistry(paths);
    const withEnv = await registry.add(remoteEntry({ env: { TOKEN: "x" } }));

    assert.equal(withEnv.ok, false);

    if (!withEnv.ok) {
      assert.equal(withEnv.code, "invalid_env");
    }

    const withCommand = await registry.add(remoteEntry({ command: "node" }));

    assert.equal(withCommand.ok, false);

    if (!withCommand.ok) {
      assert.equal(withCommand.code, "invalid_command");
    }

    const badUrl = await registry.add(remoteEntry({ url: "gopher://x" }));

    assert.equal(badUrl.ok, false);

    if (!badUrl.ok) {
      assert.equal(badUrl.code, "invalid_url");
    }

    const badHeaders = await registry.add(remoteEntry({ headers: { A: 3 as unknown as string } }));

    assert.equal(badHeaders.ok, false);

    if (!badHeaders.ok) {
      assert.equal(badHeaders.code, "invalid_headers");
    }
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});

test("T1: a remote entry survives a full document rewrite (setEnabled path)", async () => {
  const paths = tempPaths();
  try {
    const registry = createMcpRegistry(paths);

    await registry.add(remoteEntry());
    const disabled = await registry.setEnabled({ name: "remote", scope: "user" }, false);

    assert.equal(disabled.ok, true);

    if (disabled.ok) {
      assert.equal(disabled.value.enabled, false);
      assert.equal(disabled.value.url, "https://example.com/mcp");
    }

    // The rewritten document still decodes.
    const listed = await registry.list();

    assert.equal(listed.ok, true);

    if (listed.ok) {
      assert.equal(listed.value.servers.length, 1);
    }
  } finally {
    rmSync(paths.dir, { recursive: true, force: true });
  }
});
