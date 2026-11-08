import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * `trylo mcp` child-process contract (WP B 波, 反方 #6–#12).
 *
 * These run the real binary because the registry writes real files: the lock,
 * the rename and the exit code are the things under test, and an in-process
 * harness would have to re-implement all three to see them. Every scope is
 * pointed at the fixture root through `TRYLO_HOME`, so nothing here touches the
 * machine's real profile.
 */

const cli = fileURLToPath(new URL("./main.js", import.meta.url));

type RunResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

type Fixture = {
  readonly workspace: string;
  readonly home: string;
  readonly cleanup: () => void;
};

function fixture(): Fixture {
  const root = mkdtempSync(join(os.tmpdir(), "trylo-mcp-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { workspace, home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function run(fx: Fixture, args: readonly string[]): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env, TRYLO_HOME: fx.home };

  // No ambient credential may change an outcome here; the registry is local.
  delete env.TRYLO_API_KEY;
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: fx.workspace,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

type ListedServer = {
  readonly name: string;
  readonly transport: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly envKeys: ReadonlyArray<string>;
  readonly enabled: boolean;
  readonly scopes: ReadonlyArray<string>;
  readonly effectiveScope: string;
  readonly shadowedScopes: ReadonlyArray<string>;
};

function listed(fx: Fixture): ReadonlyArray<ListedServer> {
  const result = run(fx, ["mcp", "list", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as { servers: ReadonlyArray<ListedServer> };
  return parsed.servers;
}

test("add then list round-trips through the real registry files", () => {
  const fx = fixture();
  try {
    const added = run(fx, ["mcp", "add", "demo", "--", "node", "server.js", "--port", "1"]);

    assert.equal(added.status, 0, added.stderr);
    assert.match(added.stdout, /added demo to the user registry/);
    const servers = listed(fx);

    assert.equal(servers.length, 1);
    assert.equal(servers[0]?.name, "demo");
    assert.equal(servers[0]?.transport, "stdio");
    assert.equal(servers[0]?.command, "node");
    assert.deepEqual(servers[0]?.args, ["server.js", "--port", "1"]);
    assert.deepEqual(servers[0]?.scopes, ["user"]);
  } finally {
    fx.cleanup();
  }
});

test("attack #10: an illegal name never reaches the registry", () => {
  const fx = fixture();
  try {
    for (const name of ["Bad_Name", "-lead", "", "with space"]) {
      const result = run(fx, ["mcp", "add", name, "--", "node", "s.js"]);
      assert.equal(result.status, 2, `${name} must be a usage error`);
      assert.match(result.stderr, /invalid_name|server name/);
    }
    assert.equal(listed(fx).length, 0);
  } finally {
    fx.cleanup();
  }
});

test("attack #6: --url is refused by the binary, not just by the parser", () => {
  const fx = fixture();
  try {
    const result = run(fx, ["mcp", "add", "demo", "--url", "https://example.invalid/mcp", "--", "node", "s.js"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--url/);
    assert.equal(listed(fx).length, 0);
  } finally {
    fx.cleanup();
  }
});

test("a duplicate add is refused rather than silently repointing the server", () => {
  const fx = fixture();
  try {
    assert.equal(run(fx, ["mcp", "add", "demo", "--", "node", "a.js"]).status, 0);
    const again = run(fx, ["mcp", "add", "demo", "--", "node", "b.js"]);
    assert.equal(again.status, 2);
    assert.match(again.stderr, /duplicate_entry|already exists/);
    assert.equal(listed(fx)[0]?.command, "node");
    assert.deepEqual(listed(fx)[0]?.args, ["a.js"]);
  } finally {
    fx.cleanup();
  }
});

test("attack #8: a project-scoped remove never deletes the user entry", () => {
  const fx = fixture();
  try {
    assert.equal(run(fx, ["mcp", "add", "demo", "--", "node", "user.js"]).status, 0);
    assert.equal(run(fx, ["mcp", "add", "demo", "--scope", "project", "--", "node", "project.js"]).status, 0);
    // Both scopes hold the name; project wins the merged view.
    assert.deepEqual(listed(fx)[0]?.scopes, ["user", "project"]);
    assert.equal(listed(fx)[0]?.effectiveScope, "project");
    assert.deepEqual(listed(fx)[0]?.shadowedScopes, ["user"]);

    assert.equal(run(fx, ["mcp", "remove", "demo", "--scope", "project"]).status, 0);
    const after = listed(fx);

    assert.equal(after.length, 1, "the user entry must survive");
    assert.deepEqual(after[0]?.scopes, ["user"]);
    assert.deepEqual(after[0]?.args, ["user.js"]);
  } finally {
    fx.cleanup();
  }
});

test("attack #9: a corrupted registry fails closed instead of reading as 'no servers'", () => {
  const fx = fixture();
  try {
    assert.equal(run(fx, ["mcp", "add", "demo", "--", "node", "a.js"]).status, 0);
    writeFileSync(join(fx.home, "mcp-servers.json"), "{ not json");
    const result = run(fx, ["mcp", "list"]);

    assert.equal(result.status, 52, "an undecodable registry is a configuration failure");
    assert.equal(result.stdout.includes("no MCP servers"), false);
    assert.match(result.stderr, /invalid_document|not be read/);

    // The same file must also stop a write: adding through a broken registry
    // would destroy whatever the file really contained.
    const added = run(fx, ["mcp", "add", "other", "--", "node", "b.js"]);

    assert.equal(added.status, 52);
  } finally {
    fx.cleanup();
  }
});

test("attack #11: list --json prints env key names and never their values", () => {
  const fx = fixture();
  try {
    const added = run(fx, ["mcp", "add", "demo", "--env", "TOKEN=super-secret-value", "--", "node", "s.js"]);
    assert.equal(added.status, 0, added.stderr);
    const result = run(fx, ["mcp", "list", "--json"]);
    assert.equal(result.stdout.includes("super-secret-value"), false);
    assert.equal(result.stderr.includes("super-secret-value"), false);
    assert.deepEqual(listed(fx)[0]?.envKeys, ["TOKEN"]);
  } finally {
    fx.cleanup();
  }
});

test("enable and disable only flip the flag, in the scope they name", () => {
  const fx = fixture();
  try {
    assert.equal(run(fx, ["mcp", "add", "demo", "--", "node", "a.js"]).status, 0);
    assert.equal(run(fx, ["mcp", "disable", "demo"]).status, 0);
    assert.equal(listed(fx)[0]?.enabled, false);
    assert.equal(run(fx, ["mcp", "enable", "demo"]).status, 0);
    assert.equal(listed(fx)[0]?.enabled, true);
    // A scope that does not hold the name is a usage error, not a silent no-op.
    assert.equal(run(fx, ["mcp", "disable", "demo", "--scope", "project"]).status, 2);
  } finally {
    fx.cleanup();
  }
});
