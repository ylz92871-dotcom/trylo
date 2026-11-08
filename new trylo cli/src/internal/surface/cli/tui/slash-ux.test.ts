import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CliStreamEvent } from "../../../protocol/cli-stream.js";
import type { CliContext } from "../context.js";
import type { TurnOutcome } from "../host.js";
import type { RunScaffold } from "../run-command.js";
import { APPROVABLE_TOOL_NAMES } from "../permission-plan.js";
import { handleTui, type TuiTurnRunner } from "./entry.js";
import type { TuiIo } from "./io.js";
import { runConnectForm } from "./connection-ui.js";

/**
 * The WP-CLI-UX slash surface, driven through the real TUI loop.
 *
 * The handover document puts these behaviours on the UI side: `/details`
 * printing a stored tool result in full, the permission commands rendering the
 * session controller's snapshot, and the connection startup page / `/connect`
 * form reaching the same draft/probe/save pipeline the commands use. Each case
 * scripts a session and reads what the shell actually wrote — the loop, the
 * slash table and the services underneath are the real ones.
 */

type Scripted = {
  readonly ctx: CliContext;
  readonly out: string[];
  readonly err: string[];
  readonly root: string;
  readonly io: TuiIo & { readonly written: string[] };
};

function scripted(
  lines: ReadonlyArray<string>,
  options?: { readonly secret?: string; readonly configured?: boolean },
): Scripted {
  const out: string[] = [];
  const err: string[] = [];
  const written: string[] = [];
  const root = mkdtempSync(join(tmpdir(), "trylo-tui-ux-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");

  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(home, ".trylo", "sessions"), { recursive: true });

  // `configured: false` models a first run: nothing selected, so the startup
  // page has to appear. Otherwise the fixture provider is picked explicitly so
  // the shell opens straight into the session.
  if (options?.configured !== false) {
    writeFileSync(join(home, ".trylo", "config.json"), JSON.stringify({ provider: "fixture" }));
  }

  let at = 0;
  let ids = 0;
  const ctx: CliContext = {
    env: {},
    homeDir: home,
    cwd,
    nodeVersion: "v22.0.0",
    stdinIsTty: true,

    readFile: (absolutePath) => {
      try {
        return readFileSync(absolutePath, "utf8");
      } catch {
        return undefined;
      }
    },

    isDirectory: () => true,
    readDir: () => [],

    writeFile: (absolutePath, text) => {
      mkdirSync(join(absolutePath, ".."), { recursive: true });
      writeFileSync(absolutePath, text);
      return true;
    },

    readStdin: async () => "",

    readLine: async () => {
      if (at >= lines.length) {
        return undefined;
      }
      const line = lines[at];
      at += 1;
      return line;
    },

    readSecret: async () => options?.secret,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    now: () => 0,
    newId: (prefix) => `${prefix}-${(ids += 1)}`,
  };
  // One scripted source: the context's `readLine` and the io's `readLine` read
  // the same lines, so a startup-page answer and a slash command cannot drift.
  const io: TuiIo & { readonly written: string[] } = {
    written,
    readLine: () => ctx.readLine(),
    write: (text) => written.push(text),
    size: () => ({ columns: 80, rows: 24 }),
  };

  return { ctx, out, err, root, io };
}

function outcomeOf(scaffold: RunScaffold): TurnOutcome {
  return {
    exitCode: 0,
    result: {
      type: "run_result",
      status: "completed",
      finishReason: "stop",
      sessionId: scaffold.sessionId,
      turnId: "turn-1",
      iterations: 1,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      durationMs: 1,
      lastMessage: "done",
    },
    transcript: [],
    view: undefined,
    warnings: [],
  };
}

function unusedRunner(): TuiTurnRunner {
  return async () => {
    throw new Error("this script runs no turns");
  };
}

function toolEvents(
  calls: ReadonlyArray<{ readonly id: string; readonly name: string; readonly output: string }>,
  scaffold: RunScaffold,
): ReadonlyArray<CliStreamEvent> {
  const events: CliStreamEvent[] = [
    { type: "run_start", sessionId: scaffold.sessionId, turnId: "turn-1", providerId: "fixture", model: "default" },
  ];

  for (const call of calls) {
    events.push({ type: "tool_use", toolCallId: call.id, name: call.name });
    events.push({
      type: "tool_result",
      toolCallId: call.id,
      status: "ok",
      output: call.output,
      truncated: false,
    });
  }

  events.push({
    type: "run_result",
    status: "completed",
    finishReason: "stop",
    sessionId: scaffold.sessionId,
    turnId: "turn-1",
    iterations: 1,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    durationMs: 1,
    lastMessage: "done",
  });

  return events;
}

test("/details prints the stored tool result in full, unfolded", async () => {
  // Nine rows: the frame folds at five, so the tail is proof the panel read the
  // stored result rather than the screen.
  const rows = Array.from({ length: 9 }, (_, index) => `row-${index + 1}`);
  const session = scripted(["run a tool", "/details last", "/details nope", "/exit"]);
  const runner: TuiTurnRunner = async (scaffold, _text, sink) => {
    for (const event of toolEvents([{ id: "call-1", name: "run_shell", output: rows.join("\n") }], scaffold)) {
      sink.stdout(`${JSON.stringify(event)}\n`);
    }
    return outcomeOf(scaffold);
  };

  try {
    const code = await handleTui(session.ctx, session.io, runner);

    assert.equal(code, 0);
    const flat = session.io.written.join("");

    // The screen folded the tail away…
    assert.match(flat, /\.\.\. 4 more lines/);
    // …and the panel brought all nine rows back, with the count on the header.
    assert.match(flat, /output \(9 lines\):/);
    assert.match(flat, /row-9/);
    assert.match(flat, /tool: run_shell/);
    assert.match(flat, /call id: call-1/);
    // A selector that matches nothing says so instead of printing nothing.
    assert.match(flat, /no matching tool result/);
  } finally {
    rmSync(session.root, { recursive: true, force: true });
  }
});

test("/details selects by recency and by call id", async () => {
  const session = scripted(["run tools", "/details 1", "/details call-1", "/exit"]);
  const runner: TuiTurnRunner = async (scaffold, _text, sink) => {
    const events = toolEvents(
      [
        { id: "call-1", name: "read_file", output: "oldest payload" },
        { id: "call-2", name: "run_shell", output: "newest payload" },
      ],
      scaffold,
    );

    for (const event of events) {
      sink.stdout(`${JSON.stringify(event)}\n`);
    }

    return outcomeOf(scaffold);
  };

  try {
    const code = await handleTui(session.ctx, session.io, runner);

    assert.equal(code, 0);
    const flat = session.io.written.join("");
    // `/details 1` is the newest result; the call id reaches the older one.
    const newest = flat.indexOf("output (1 lines):");

    assert.ok(newest >= 0);
    assert.match(flat.slice(newest), /newest payload/);
    const byId = flat.indexOf("call id: call-1");

    assert.ok(byId >= 0);
    assert.match(flat.slice(byId), /oldest payload/);
  } finally {
    rmSync(session.root, { recursive: true, force: true });
  }
});

test("permission commands render the session controller and survive a refusal", async () => {
  const script = [
    "/mode confirm",
    "/allow run_shell",
    "/deny write_file",
    "/grants",
    "/revoke run_shell",
    "/mode read-only",
    // Refused by the controller in read-only mode: rendered, never thrown.
    "/allow run_shell",
    "/grants",
    "/exit",
  ];
  const session = scripted(script);

  try {
    const code = await handleTui(session.ctx, session.io, unusedRunner());

    assert.equal(code, 0);
    const flat = session.io.written.join("");

    assert.match(flat, /mode set to confirm/);
    assert.match(flat, /allowed run_shell for this session/);
    assert.match(flat, /denied write_file for this session/);
    assert.match(flat, /allowed tools: run_shell/);
    assert.match(flat, /denied tools: write_file/);
    assert.match(flat, /revoked run_shell; it now follows the current mode/);
    assert.match(flat, /cannot allow run_shell: switch out of read-only mode before enabling a tool/);
    assert.match(flat, /mode: read-only/);
  } finally {
    rmSync(session.root, { recursive: true, force: true });
  }
});

test("an unknown permission tool is reported, not applied", async () => {
  // `/grants` after the refusal is the assertion that matters: the command must
  // be *reported* and must leave no grant behind. Checking only the error text
  // would pass even if the name had been granted on the way out.
  const session = scripted(["/allow not_a_tool", "/grants", "/exit"]);
  try {
    const code = await handleTui(session.ctx, session.io, unusedRunner());

    assert.equal(code, 0);
    const written = session.io.written.join("");

    assert.match(written, /unknown tool not_a_tool/);

    // The list is derived from the vocabulary rather than spelled out here. The
    // behaviour under test is "an unknown name is refused and the real ones are
    // offered"; hard-coding the roster made that assertion break every time a
    // tool was legitimately added, which trains the next person to update a
    // string instead of reading the failure.
    for (const name of APPROVABLE_TOOL_NAMES) {
      assert.ok(written.includes(name), `expected the offered tools to include ${name}`);
    }

    // "not applied" is the half that was untested. The grant ledger is the
    // product's own record, so a name appearing on the `allowed tools:` line
    // would mean the refusal is cosmetic. Slicing from the ledger line (not from
    // the word "grants", which never appears in the output) is what makes this
    // an assertion about state rather than about the echo above.
    const ledger = written.slice(written.indexOf("allowed tools:"));

    assert.notEqual(ledger, "", "expected the grant ledger to be rendered");
    assert.equal(ledger.includes("not_a_tool"), false, "a refused tool must leave no grant behind");
  } finally {
    rmSync(session.root, { recursive: true, force: true });
  }
});

test("a first run with nothing configured opens the connection page, and the demo runs", async () => {
  const session = scripted(["o", "/exit"], { configured: false });
  try {
    const code = await handleTui(session.ctx, session.io, unusedRunner());
    assert.equal(code, 0);
    const flat = session.io.written.join("");
    assert.match(flat, /No provider is configured yet\./);
    assert.match(flat, /\[a\]dd connection  \[o\]ffline demo \(fixture, not a model\)  \[q\]uit/);
    assert.match(flat, /starting offline demo \(fixture provider\)/);
  } finally {
    rmSync(session.root, { recursive: true, force: true });
  }
});

test("a first run can leave from the connection page without a session", async () => {
  const session = scripted(["q"], { configured: false });
  try {
    const code = await handleTui(session.ctx, session.io, unusedRunner());
    assert.equal(code, 0);
    // The demo is offered but not started: the page is left, not entered.
    assert.doesNotMatch(session.io.written.join(""), /starting offline demo/);
  } finally {
    rmSync(session.root, { recursive: true, force: true });
  }
});

test("/connect saves a declared connection through the form", async () => {
  const script = [
    "/connect",
    "Lab", // display name
    "", // id: keep the suggestion
    "https://example.invalid/v1", // address
    "b", // kind: base-url
    "manual-model", // model
    "", // context window: skip
    "s", // credential: secret
    "", // label: none
    "n", // verify: no
    "/exit",
  ];
  const session = scripted(script, { secret: "sk-test" });

  try {
    const code = await handleTui(session.ctx, session.io, unusedRunner());

    assert.equal(code, 0);
    assert.match(session.io.written.join(""), /saved connection lab/);
    const providers = session.ctx.readFile(join(session.root, "home", ".trylo", "providers.json"));

    assert.ok(providers !== undefined);
    const parsed = JSON.parse(providers) as {
      selected: string;
      providers: ReadonlyArray<{ id: string; endpoint: string; model: string }>;
    };

    assert.equal(parsed.selected, "lab");
    assert.deepEqual(
      parsed.providers.map((entry) => entry.id),
      ["lab"],
    );
    // A base-url is normalised to the chat endpoint it serves, exactly as the
    // command path normalises it.
    assert.equal(parsed.providers[0]?.endpoint, "https://example.invalid/v1/chat/completions");
    assert.equal(parsed.providers[0]?.model, "manual-model");
  } finally {
    rmSync(session.root, { recursive: true, force: true });
  }
});

test("the connection draft survives an invalid address and cancellation writes nothing", async () => {
  const session = scripted(["Lab", "", "not-a-url", "b", "https://example.invalid/v1", "manual-model", "", "s", ""], { secret: "private-test-value" });
  try {
    const io: TuiIo = { ...session.io, choose: async () => undefined };

    assert.equal(await runConnectForm(session.ctx, io, "add"), undefined);
    const output = session.io.written.join("");

    assert.match(output, /invalid_endpoint/);
    assert.match(output, /manual-model/);
    assert.doesNotMatch(output, /private-test-value/);
    assert.equal(session.ctx.readFile(join(session.root, "home", ".trylo", "providers.json")), undefined);
  } finally { rmSync(session.root, { recursive: true, force: true }); }
});

test("saving a connection without using it leaves the default selection alone", async () => {
  const session = scripted(["Lab", "", "https://example.invalid/v1", "b", "manual-model", "", "s", ""], { secret: "private-test-value" });
  try {
    const io: TuiIo = { ...session.io, choose: async () => "save" };
    const result = await runConnectForm(session.ctx, io, "add");

    assert.equal(result?.ok, true);

    if (result?.ok) assert.equal(result.selected, false);

    const text = session.ctx.readFile(join(session.root, "home", ".trylo", "providers.json"));

    assert.ok(text);
    const parsed = JSON.parse(text) as { selected?: string; providers: Array<{ id: string }> };

    assert.equal(parsed.selected, undefined);
    assert.equal(parsed.providers[0]?.id, "lab");
  } finally { rmSync(session.root, { recursive: true, force: true }); }
});
