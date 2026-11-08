import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMcp } from "./args-mcp.js";

/**
 * `mcp` parsing contract (WP B 波反方 #6/#7；T1 波按 ADR 放开远端路径).
 *
 * The point of these is the refusals. Since the remote-transport ADR there are
 * two registration paths and they are mutually exclusive: a remote-transport
 * flag on the wrong path is not ignored, it is rejected, and an entry that is
 * half of each path describes no server at all. Every test is the attack that
 * must stay red.
 */

function kindOf(argv: ReadonlyArray<string>): string {
  return parseMcp(argv).kind;
}

function errorOf(argv: ReadonlyArray<string>): { message: string; hint: string } {
  const parsed = parseMcp(argv);
  assert.equal(parsed.kind, "error", `expected a usage error, got ${parsed.kind}`);
  if (parsed.kind !== "error") {
    throw new Error("unreachable");
  }
  return { message: parsed.message, hint: parsed.hint };
}

test("add parses the name, the command and its arguments across the `--`", () => {
  const parsed = parseMcp(["add", "demo", "--", "node", "server.js", "--flag", "1"]);

  assert.equal(parsed.kind, "mcp_add");

  if (parsed.kind !== "mcp_add") {
    return;
  }

  assert.equal(parsed.options.name, "demo");
  assert.equal(parsed.options.transport, "stdio");
  assert.equal(parsed.options.command, "node");
  assert.deepEqual(parsed.options.args, ["server.js", "--flag", "1"]);
  assert.equal(parsed.options.scope, "user");
  assert.equal(parsed.options.enabled, true);
  assert.deepEqual(parsed.options.env, {});
  assert.equal(parsed.options.url, undefined);
});

test("attack #6 (rewritten per ADR): --url together with a command is the mutual-exclusion error", () => {
  const error = errorOf(["add", "demo", "--url", "https://example.invalid/mcp", "--", "node", "s.js"]);
  assert.match(error.message, /either --url or a command/);
  assert.equal(kindOf(["remove", "demo", "--url", "https://x"]), "error");
});

test("--url alone registers a remote entry, defaulting to the http transport", () => {
  const parsed = parseMcp(["add", "demo", "--url", "https://example.invalid/mcp"]);

  assert.equal(parsed.kind, "mcp_add");

  if (parsed.kind !== "mcp_add") {
    return;
  }

  assert.equal(parsed.options.transport, "http");
  assert.equal(parsed.options.url, "https://example.invalid/mcp");
  assert.equal(parsed.options.command, "");
  assert.deepEqual(parsed.options.args, []);
  assert.deepEqual(parsed.options.env, {});
});

test("contract #2: --transport must agree with the registration path", () => {
  const withUrl = parseMcp(["add", "demo", "--transport", "sse", "--url", "https://x/sse"]);

  assert.equal(withUrl.kind, "mcp_add");

  if (withUrl.kind === "mcp_add") {
    assert.equal(withUrl.options.transport, "sse");
  }

  assert.match(
    errorOf(["add", "demo", "--transport", "stdio", "--url", "https://x"]).message,
    /conflicts with --url/,
  );
  assert.match(
    errorOf(["add", "demo", "--transport", "http", "--", "node", "s.js"]).message,
    /conflicts with/,
  );
  assert.match(errorOf(["add", "demo", "--transport", "http", "--", "node"]).message, /conflicts with/);
});

test("status parses with and without --json, and refuses anything else", () => {
  assert.equal(kindOf(["status"]), "mcp_status");
  const parsed = parseMcp(["status", "--json"]);

  assert.equal(parsed.kind, "mcp_status");

  if (parsed.kind !== "mcp_status") {
    return;
  }

  assert.equal(parsed.json, true);
  assert.match(errorOf(["status", "--scope", "user"]).message, /does not accept/);
});

test("--transport outside the registry vocabulary is a usage error", () => {
  assert.match(
    errorOf(["add", "demo", "--transport", "websocket", "--url", "https://x"]).message,
    /--transport must be one of/,
  );
});

test("contract #3: --env on a remote entry is refused at parse time", () => {
  const error = errorOf(["add", "demo", "--env", "TOKEN=abc", "--url", "https://x/mcp"]);
  assert.match(error.message, /--env only applies to stdio/);
});

test("contract #4: --header on a stdio entry is refused at parse time", () => {
  const error = errorOf(["add", "demo", "--header", "Authorization: Bearer x", "--", "node", "s.js"]);
  assert.match(error.message, /--header only applies to remote/);
});

test("--header is accepted for remote entries and accumulates", () => {
  const parsed = parseMcp([
    "add",
    "demo",
    "--url",
    "https://x/mcp",
    "--header",
    "Authorization: Bearer abc",
    "--header",
    "X-Api-Key: 123",
  ]);

  assert.equal(parsed.kind, "mcp_add");

  if (parsed.kind !== "mcp_add") {
    return;
  }

  assert.deepEqual(parsed.options.headers, { Authorization: "Bearer abc", "X-Api-Key": "123" });
});

test("--header without a Name: Value shape is a usage error", () => {
  assert.match(errorOf(["add", "demo", "--url", "https://x", "--header", "novalue"]).message, /Name: Value/);
  assert.match(errorOf(["add", "demo", "--url", "https://x", "--header", ": quiet"]).message, /Name: Value/);
});

test("--url that is not a legal http(s) URL is a usage error", () => {
  assert.match(errorOf(["add", "demo", "--url", "not-a-url"]).message, /not a valid URL/);
  assert.match(errorOf(["add", "demo", "--url", "ftp://x"]).message, /must be http or https/);
});

test("--env is accepted for stdio and accumulates", () => {
  const parsed = parseMcp(["add", "demo", "--env", "A=1", "--env", "B=2", "--", "node", "s.js"]);
  assert.equal(parsed.kind, "mcp_add");
  if (parsed.kind !== "mcp_add") {
    return;
  }
  assert.deepEqual(parsed.options.env, { A: "1", B: "2" });
});

test("--env without KEY=VALUE is a usage error", () => {
  assert.match(errorOf(["add", "demo", "--env", "TOKEN", "--", "node", "s.js"]).message, /KEY=VALUE/);
  assert.match(errorOf(["add", "demo", "--env", "=1", "--", "node", "s.js"]).message, /KEY=VALUE/);
});

test("add requires a path: either the separator or --url", () => {
  assert.match(errorOf(["add", "demo", "node", "s.js"]).message, /requires `--`|or --url/);
  assert.match(errorOf(["add", "demo", "--"]).message, /requires a command/);
  assert.match(errorOf(["add", "--", "node"]).message, /requires a server name/);
});

test("--scope is validated, and --disable flips the entry off", () => {
  const scoped = parseMcp(["add", "demo", "--scope", "project", "--disable", "--", "node", "s.js"]);

  assert.equal(scoped.kind, "mcp_add");

  if (scoped.kind === "mcp_add") {
    assert.equal(scoped.options.scope, "project");
    assert.equal(scoped.options.enabled, false);
  }

  const remoteDisabled = parseMcp(["add", "demo", "--url", "https://x", "--disable"]);

  assert.equal(remoteDisabled.kind, "mcp_add");

  if (remoteDisabled.kind === "mcp_add") {
    assert.equal(remoteDisabled.options.enabled, false);
  }

  assert.match(errorOf(["add", "demo", "--scope", "org", "--", "node"]).message, /--scope must be/);
  assert.match(errorOf(["add", "demo", "--disable=true", "--", "node"]).message, /takes no value/);
});

test("remove, enable and disable parse a name plus an optional scope", () => {
  const removed = parseMcp(["remove", "demo", "--scope", "project"]);

  assert.equal(removed.kind, "mcp_remove");

  if (removed.kind === "mcp_remove") {
    assert.deepEqual(removed.options, { name: "demo", scope: "project" });
  }

  const enabled = parseMcp(["enable", "demo"]);

  assert.equal(enabled.kind, "mcp_set_enabled");

  if (enabled.kind === "mcp_set_enabled") {
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.options.scope, "user");
  }

  const disabled = parseMcp(["disable", "demo", "--scope", "user"]);

  assert.equal(disabled.kind, "mcp_set_enabled");

  if (disabled.kind === "mcp_set_enabled") {
    assert.equal(disabled.enabled, false);
  }

  assert.match(errorOf(["remove"]).message, /requires a server name/);
  assert.match(errorOf(["remove", "demo", "--json"]).message, /does not accept/);
});

test("the non-add verbs still refuse the transport flags, with the new wording", () => {
  assert.match(errorOf(["remove", "demo", "--transport", "http"]).message, /only `mcp add` registers a server/);
  assert.match(errorOf(["enable", "demo", "--header", "A: b"]).message, /only `mcp add` registers a server/);
  assert.match(
    errorOf(["disable", "demo", "--inherit-env"]).message,
    /never inherited wholesale/,
  );
});

test("list takes --json and nothing else; an unknown subcommand is a usage error", () => {
  const listed = parseMcp(["list", "--json"]);

  assert.equal(listed.kind, "mcp_list");

  if (listed.kind === "mcp_list") {
    assert.equal(listed.json, true);
  }

  assert.equal(kindOf(["list"]), "mcp_list");
  assert.match(errorOf(["list", "--verbose"]).message, /does not accept/);
  assert.match(errorOf(["sync"]).message, /unknown mcp subcommand/);
  assert.match(errorOf([]).message, /requires a subcommand/);
  // D6 #19: family --help is scoped help now, not the global page.
  assert.equal(kindOf(["--help"]), "family_help");
});
