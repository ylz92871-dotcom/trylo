import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { EXIT_CODES, exitCodeForRunStatus } from "../../protocol/cli-stream.js";
import { buildPermissionAction } from "../../loop/permission-grants.js";
import { isOutputFormat, isProviderId, parseArgs } from "./args.js";
import { createDenyAllPermission, createInteractivePermission } from "./permission.js";
import { isValidSessionId, sessionPath, sessionsDir, tryloHome } from "./session-paths.js";
import {
  NO_LEARNING_PROFILE,
  catalogHash,
  wirePorts,
  workspaceIdentity,
} from "./wiring.js";

/**
 * Composition-root contracts.
 *
 * The CLI is where a wrong default becomes a security or correctness problem,
 * so these tests cover the decisions rather than the wiring mechanics.
 */

function actionForNN(toolCallId: string, name: string) {
  return buildPermissionAction(toolCallId, name, {});
}

function fixtureWiring() {
  return wirePorts({
    providerId: "fixture",
    model: "default",
    endpoint: "",
    apiKey: undefined,
    workspaceRoot: process.cwd(),
    permission: createDenyAllPermission(),
  });
}

test("the real CLI composition root pins the packaged no_learning profile", async () => {
  const wiring = fixtureWiring();

  assert.equal("code" in wiring, false);

  if ("code" in wiring) {
    return;
  }

  assert.equal(wiring.ports.profile, NO_LEARNING_PROFILE);
  const snapshot = await wiring.ports.profile.load("task");

  assert.equal(snapshot.learningMode, "no_learning");
  assert.equal(snapshot.userRules.length, 0);
  assert.equal(snapshot.promptPatches.length, 0);
});

test("the durable permission ledger exists only when the switch asked for it", () => {
  // 「关闭」不是一个值为 undefined 的字段，而是**字段根本不存在**：调用方要判断
  // 有没有账本，只能问对象本身，不能相信某个哨兵值。
  const off = fixtureWiring();

  assert.equal("code" in off, false);

  if ("code" in off) {
    return;
  }

  assert.equal(Object.hasOwn(off, "permissionLedger"), false);

  const on = wirePorts({
    providerId: "fixture",
    model: "default",
    endpoint: "",
    apiKey: undefined,
    workspaceRoot: process.cwd(),
    permission: createDenyAllPermission(),
    permissionLedger: { path: join(process.cwd(), "does-not-exist", "ledger.ndjson") },
  });

  assert.equal("code" in on, false);

  if ("code" in on) {
    return;
  }

  assert.equal(Object.hasOwn(on, "permissionLedger"), true);
});

test("the wiring module never imports a learning package", () => {
  // Read the source, not the build output: the point is to catch an import
  // appearing in the file a reviewer reads.
  const source = readFileSync(
    join(process.cwd(), "src", "internal", "surface", "cli", "wiring.ts"),
    "utf8",
  );
  const specifiers = [...source.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)].map(
    (match) => match[1] ?? "",
  );

  assert.equal(specifiers.length > 0, true);

  for (const specifier of specifiers) {
    for (const forbidden of ["internal/learning", "internal/knowledge", "verification-authority"]) {
      assert.equal(specifier.includes(forbidden), false, specifier);
    }
  }
});

test("openai-compatible requires an endpoint, and the key travels resolved, not sourced here", () => {
  const missing = wirePorts({
    providerId: "openai-compatible",
    model: "gpt-x",
    endpoint: "",
    apiKey: undefined,
    workspaceRoot: process.cwd(),
    permission: createDenyAllPermission(),
  });

  assert.equal("code" in missing, true);

  if ("code" in missing) {
    assert.equal(missing.code, "missing_endpoint");
  }

  const wired = wirePorts({
    providerId: "openai-compatible",
    model: "gpt-x",
    endpoint: "https://example.invalid/v1",
    apiKey: "secret-value",
    workspaceRoot: process.cwd(),
    permission: createDenyAllPermission(),
  });

  assert.equal("code" in wired, false);
  // The wiring names no environment variable at all: the credential was already
  // resolved by `CredentialPort` before it got here.
  const source = readFileSync(
    join(process.cwd(), "src", "internal", "surface", "cli", "wiring.ts"),
    "utf8",
  );

  assert.equal(source.includes("TRYLO_API_KEY"), false);
});

test("a non-interactive run denies approval instead of assuming it", async () => {
  const permission = createDenyAllPermission();
  const ticket = await permission.request(actionForNN("call-1", "echo"));
  assert.equal(ticket.toolCallId, "call-1");
  assert.equal((await permission.awaitDecision(ticket.ticketId)).resolution, "denied");
});

test("interactive decisions distinguish denial, cancellation and blank input followed by EOF", async () => {
  const answers = ["y", "n", "c", ""];
  const permission = createInteractivePermission({
    prompt: () => undefined,
    readLine: async () => answers.shift(),
  });
  const ask = async () => {
    const ticket = await permission.request(actionForNN("call-1", "echo"));
    return permission.awaitDecision(ticket.ticketId);
  };

  assert.equal((await ask()).resolution, "approved");
  assert.equal((await ask()).resolution, "denied");
  assert.equal((await ask()).resolution, "cancelled");
  const ended = await ask();

  assert.equal(ended.resolution, "cancelled");
  assert.equal(ended.reason, "input_closed");
});

test("an ended input stream cancels rather than approving", async () => {
  const permission = createInteractivePermission({
    prompt: () => undefined,
    readLine: async () => undefined,
  });
  const ticket = await permission.request(actionForNN("call-1", "echo"));
  assert.equal((await permission.awaitDecision(ticket.ticketId)).resolution, "cancelled");
});

test("the tool catalog hash is stable and workspace identity is path-derived", () => {
  const first = catalogHash(process.cwd());
  const second = catalogHash(process.cwd());
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{32}$/);
  assert.notEqual(workspaceIdentity(process.cwd()), workspaceIdentity(`${process.cwd()}/other`));
});

test("language servers reach the catalog only through validated configuration", () => {
  const servers = [{ serverName: "ts", command: "does-not-exist-binary", args: [], extensions: ["ts"] }];
  const without = fixtureWiring();

  assert.equal("code" in without, false);

  if ("code" in without) {
    return;
  }

  const names = without.ports.tools.snapshot().map((binding) => binding.name);

  assert.equal(names.includes("lsp_navigate"), false);

  const configured = wirePorts({
    providerId: "fixture",
    model: "default",
    endpoint: "",
    apiKey: undefined,
    workspaceRoot: process.cwd(),
    permission: createDenyAllPermission(),
    languageServers: servers,
  });

  assert.equal("code" in configured, false);

  if ("code" in configured) {
    return;
  }

  const withNames = configured.ports.tools.snapshot().map((binding) => binding.name);

  assert.equal(withNames.includes("lsp_navigate"), true);
  // Mounting changes the catalog honestly: the hash moves, so an old session
  // cannot mistake today's table for yesterday's.
  assert.notEqual(configured.toolCatalogHash, without.toolCatalogHash);
});

test("session ids that could escape the sessions directory are refused", () => {
  for (const bad of ["../evil", "a/../b", "a/b", "", ".hidden", "x".repeat(129), "a b"]) {
    assert.equal(isValidSessionId(bad), false, bad);
  }
  for (const good of ["demo", "run-1", "a.b_c", "A1"]) {
    assert.equal(isValidSessionId(good), true, good);
  }
});

test("session paths stay under the trylo home", () => {
  const env = { TRYLO_HOME: "C:/trylo-home" };

  assert.equal(tryloHome("C:/users/x", env), "C:/trylo-home");
  assert.equal(tryloHome("C:/users/x", {}), "C:/users/x/.trylo");
  assert.equal(sessionsDir("C:/users/x", env), "C:/trylo-home/sessions");
  assert.equal(
    sessionPath("C:/users/x", env, "demo"),
    "C:/trylo-home/sessions/demo.ndjson",
  );
});

test("argument parsing resolves commands and rejects malformed invocations", () => {
  assert.equal(parseArgs([]).kind, "repl");
  assert.equal(parseArgs(["--help"]).kind, "help");
  assert.equal(parseArgs(["version"]).kind, "version");
  assert.equal(parseArgs(["doctor", "--json"]).kind, "doctor");

  const run = parseArgs(["run", "--provider", "fixture", "--format", "stream-json", "hi", "there"]);

  assert.equal(run.kind, "run");

  if (run.kind === "run") {
    assert.equal(run.options.provider, "fixture");
    assert.equal(run.options.format, "stream-json");
    assert.deepEqual([...run.options.message], ["hi", "there"]);
    assert.equal(run.options.readStdin, false);
  }

  const flagFormat = parseArgs(["run", "--max-iterations=4", "-"]);
  if (flagFormat.kind === "run") {
    assert.equal(flagFormat.options.maxIterations, 4);
    assert.equal(flagFormat.options.readStdin, true);
  } else {
    assert.fail("expected a run command");
  }

  // The provider error tells the user to set an endpoint "in config or
  // --endpoint", so the flag has to exist for that hint to be actionable.
  const withEndpoint = parseArgs([
    "run",
    "--provider",
    "openai-compatible",
    "--endpoint",
    "https://example.invalid/v1/chat/completions",
    "go",
  ]);
  if (withEndpoint.kind === "run") {
    assert.equal(withEndpoint.options.endpoint, "https://example.invalid/v1/chat/completions");
  } else {
    assert.fail("expected a run command");
  }

  assert.equal(parseArgs(["run", "--provider"]).kind, "error");
  assert.equal(parseArgs(["run", "--provider="]).kind, "error");
  assert.equal(parseArgs(["run", "--max-iterations", "0"]).kind, "error");
  assert.equal(parseArgs(["run", "--max-iterations", "x"]).kind, "error");
  assert.equal(parseArgs(["run", "--session", "a", "--resume", "b"]).kind, "error");
  assert.equal(parseArgs(["nope"]).kind, "error");
  assert.equal(parseArgs(["config"]).kind, "error");
  assert.equal(parseArgs(["config", "show", "--json"]).kind, "config_show");
});

test("provider ids and formats are closed sets", () => {
  assert.equal(isProviderId("fixture"), true);
  assert.equal(isProviderId("openai-compatible"), true);
  assert.equal(isProviderId("openai"), false);
  assert.equal(isOutputFormat("text"), true);
  assert.equal(isOutputFormat("stream-json"), true);
  assert.equal(isOutputFormat("json"), false);
});

test("run status maps to the documented exit codes", () => {
  assert.equal(exitCodeForRunStatus("completed"), EXIT_CODES.OK);
  assert.equal(exitCodeForRunStatus("cancelled"), EXIT_CODES.CANCELLED);
  assert.equal(exitCodeForRunStatus("failed"), EXIT_CODES.EXECUTION_FAILURE);
  assert.equal(exitCodeForRunStatus("unknown"), EXIT_CODES.EXECUTION_FAILURE);
});
