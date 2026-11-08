import assert from "node:assert/strict";
import { test } from "node:test";
import { errorResponse, notificationMessage } from "../../mcp/jsonrpc.js";
import { childEnvironment } from "./transport-env.js";
import { createStdioTransport, type StdioTransportFailure } from "./transport.js";

/**
 * The child gets a minimal base environment plus what the registry entry named
 * explicitly. Nothing here lets a server read the parent's full environment, so
 * a credential in Trylo's process cannot leak into a server merely because the
 * server happened to be started.
 */

const ORIGINAL = process.env.TRYLO_MCP_NOT_WHITELISTED;

test("an explicit env value is passed through", () => {
  const env = childEnvironment({ TRYLO_MCP_EXPLICIT: "yes" });
  assert.equal(env.TRYLO_MCP_EXPLICIT, "yes");
});

test("a non-whitelisted key in the parent environment is never inherited", () => {
  process.env.TRYLO_MCP_NOT_WHITELISTED = "should-not-leak";
  try {
    const env = childEnvironment({});
    assert.equal(env.TRYLO_MCP_NOT_WHITELISTED, undefined);
  } finally {
    if (ORIGINAL === undefined) {
      delete process.env.TRYLO_MCP_NOT_WHITELISTED;
    } else {
      process.env.TRYLO_MCP_NOT_WHITELISTED = ORIGINAL;
    }
  }
});

test("whitelisted platform keys survive, but only when set", () => {
  const env = childEnvironment({});
  if (process.env.PATH !== undefined) {
    assert.equal(env.PATH, process.env.PATH);
  }

  // No key the child did not ask for and that is not on the platform whitelist
  // can appear: the extra map above is empty, so the result is a subset of the
  // fixed whitelist.
  for (const key of Object.keys(env)) {
    assert.match(key, /^(PATH|PATHEXT|SystemRoot|windir|TEMP|TMP|TMPDIR|HOME|USERPROFILE|LANG|LC_ALL)$/);
  }
});

test("an explicit env key cannot be shadowed by the base", () => {
  const env = childEnvironment({ TEMP: "/chosen/by/entry" });
  assert.equal(env.TEMP, "/chosen/by/entry");
});

/**
 * `notify` and `respond` are fire-and-forget on the interface (`(): void`),
 * so an undeliverable message must surface through `onFailure`, never through
 * a lost write. The window under test: `terminate()`'s synchronous prologue
 * marks the transport gone before the child's exit event can report it, so
 * these two writes are the first thing that can notice.
 */
test("notify and respond report an undeliverable message instead of dropping it", async () => {
  const transport = createStdioTransport({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 60_000)"],
    env: {},
    cwd: process.cwd(),
    maxStderrBytes: 1024,
  });
  try {
    const failures: StdioTransportFailure[] = [];

    transport.onFailure((failure) => failures.push(failure));
    const terminating = transport.terminate();

    transport.notify(notificationMessage("initialized"));
    transport.respond(errorResponse(1, -32601, "method not found"));
    await terminating;
    assert.ok(
      failures.some((failure) => failure.code === "write_failed"),
      `expected a write_failed among ${JSON.stringify(failures)}`,
    );
  } finally {
    await transport.terminate();
  }
});
