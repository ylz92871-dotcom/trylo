import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * Child-process CLI contract.
 *
 * These run the real binary so the exit codes, the stdout discipline and the
 * stdio wiring are covered where they actually live. Anything asserted here
 * would be invisible to an in-process test.
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
  const root = mkdtempSync(join(os.tmpdir(), "trylo-cli-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");

  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify({ name: "@trylo/fixture-workspace" }, null, 2),
  );

  return {
    workspace,
    home,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function run(fx: Fixture, args: readonly string[], input?: string): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env, TRYLO_HOME: fx.home };

  // Ambient credentials must never change a test outcome: the gate has to use
  // local fixtures only, with no network and no real account in play.
  delete env.TRYLO_API_KEY;
  // `TRYLO_HOME` moves the *profile*, but the user layer of the config stack
  // still resolves from the OS home (`<os home>/.trylo/config.json`), so a
  // developer machine with a real profile would inject its provider into every
  // assertion below. Redirecting the OS home is what makes this suite
  // hermetic; `TRYLO_HOME` alone does not (see `OPEN-ME0-1` in ME0-STATE.md).
  // Both spellings are set because `os.homedir()` reads `USERPROFILE` on
  // Windows and `HOME` elsewhere.
  env.USERPROFILE = fx.home;
  env.HOME = fx.home;
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: fx.workspace,
    env,
    encoding: "utf8",
    ...(input === undefined ? { stdio: ["ignore", "pipe", "pipe"] } : { input }),
  });

  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function jsonLines(stdout: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];

  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }
    rows.push(JSON.parse(line) as Record<string, unknown>);
  }

  return rows;
}

test("help exits 0 and lists the command surface", () => {
  const fx = fixture();
  try {
    const result = run(fx, ["--help"]);
    assert.equal(result.status, 0, result.stderr);
    for (const command of ["run", "version", "doctor", "config show", "session list"]) {
      assert.equal(result.stdout.includes(command), true, command);
    }
    assert.equal(result.stderr, "");
  } finally {
    fx.cleanup();
  }
});

test("version prints the package version on stdout only", () => {
  const fx = fixture();
  try {
    const result = run(fx, ["version"]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "0.1.0");
    assert.equal(result.stderr, "");
  } finally {
    fx.cleanup();
  }
});

test("an unknown command is a usage error with a next action", () => {
  const fx = fixture();
  try {
    const result = run(fx, ["frobnicate"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown command: frobnicate/);
    assert.match(result.stderr, /trylo --help/);
    assert.equal(result.stdout, "");
  } finally {
    fx.cleanup();
  }
});

test("unknown options, unknown providers and conflicting session flags are usage errors", () => {
  const fx = fixture();
  try {
    assert.equal(run(fx, ["run", "--nope", "hi"]).status, 2);
    assert.equal(run(fx, ["run", "--provider", "anthropic", "hi"]).status, 2);
    assert.equal(run(fx, ["run", "--format", "yaml", "hi"]).status, 2);
    assert.equal(run(fx, ["run", "--session", "a", "--resume", "b", "hi"]).status, 2);
    assert.equal(run(fx, ["run", "--session", "../escape", "hi"]).status, 2);
    assert.equal(run(fx, ["doctor", "--fix"]).status, 2);
  } finally {
    fx.cleanup();
  }
});

test("run --provider accepts an id the person declared, not only a shipped one", () => {
  const fx = fixture();
  try {
    const add = run(fx, [
      "providers", "add", "myhost",
      "--kind", "openai-compatible",
      "--endpoint", "https://x.invalid/v1",
      "--model", "m1",
    ]);

    assert.equal(add.status, 0, add.stderr);
    const result = run(fx, ["run", "--provider", "myhost", "hi"]);

    assert.notEqual(result.status, 2, `a declared provider is not a usage error: ${result.stderr}`);
    assert.equal(result.status, 41, "nothing is logged in yet, so the honest failure is auth");
    assert.match(result.stderr, /myhost|credential|auth/i);
  } finally {
    fx.cleanup();
  }
});

test("a piped (non-TTY) session ends at EOF without a readline crash", () => {
  const fx = fixture();
  try {
    // stdin is a pipe (not a TTY): one line then EOF. The line REPL must stop
    // at EOF rather than call `question` on an already-closed interface.
    const result = run(fx, [], "just close\n");
    assert.doesNotMatch(result.stderr, /ERR_USE_AFTER_CLOSE|readline was closed/);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fx.cleanup();
  }
});

test("run without a prompt and without stdin is a usage error", () => {
  const fx = fixture();
  try {
    const result = run(fx, ["run"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /prompt/);
    assert.equal(result.stdout, "");
  } finally {
    fx.cleanup();
  }
});

test("fixture run proves the tool loop end to end in text mode", () => {
  const fx = fixture();
  try {
    const result = run(fx, ["run", "--provider", "fixture", "answer in one line"]);
    assert.equal(result.status, 0, result.stderr);
    // The fixture only produces this answer when the tool result came back.
    assert.match(result.stdout, /@trylo\/fixture-workspace/);
    assert.match(result.stderr, /-> read_file /);
    assert.match(result.stderr, /result status=completed/);
  } finally {
    fx.cleanup();
  }
});

test("stream-json stdout is a pure JSON event stream ending in one run_result", () => {
  const fx = fixture();
  try {
    const result = run(fx, ["run", "--provider", "fixture", "--format", "stream-json", "answer"]);

    assert.equal(result.status, 0, result.stderr);
    const events = jsonLines(result.stdout);

    assert.equal(events.length > 0, true);
    const results = events.filter((event) => event.type === "run_result");

    assert.equal(results.length, 1);
    const final = results[0];

    assert.equal(final?.status, "completed");
    assert.equal(typeof final?.finishReason, "string");
    assert.equal(typeof final?.lastMessage, "string");
    assert.equal(final?.lastMessage !== "", true);
    const types = events.map((event) => event.type);

    assert.equal(types[0], "run_start");
    assert.equal(types.at(-1), "run_result");
    // No human text may leak into the protocol stream.
    assert.equal(result.stdout.includes("usage in="), false);
    assert.equal(result.stdout.includes("session eph"), false);
  } finally {
    fx.cleanup();
  }
});

test("a prompt piped on stdin is read with `-`", () => {
  const fx = fixture();
  try {
    const result = run(fx, ["run", "--provider", "fixture", "-"], "read the package please");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /@trylo\/fixture-workspace/);
  } finally {
    fx.cleanup();
  }
});

test("--output-last-message writes the final assistant text", () => {
  const fx = fixture();
  try {
    const target = join(fx.workspace, "out", "last.txt");
    const result = run(fx, [
      "run",
      "--provider",
      "fixture",
      "--output-last-message",
      target,
      "answer",
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(target, "utf8"), /@trylo\/fixture-workspace/);
  } finally {
    fx.cleanup();
  }
});

test("a durable session survives and resume rebuilds provider messages from the transcript", () => {
  const fx = fixture();
  try {
    const first = run(fx, ["run", "--provider", "fixture", "--session", "demo", "first turn"]);

    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stderr, /-> read_file /);

    const listed = run(fx, ["session", "list"]);

    assert.equal(listed.status, 0);
    assert.match(listed.stdout, /demo/);

    const second = run(fx, ["run", "--provider", "fixture", "--resume", "demo", "second turn"]);

    assert.equal(second.status, 0, second.stderr);
    // The persisted transcript already carries the tool result, so the fixture
    // answers without asking for the tool again. A resume that only replayed UI
    // text could not satisfy this.
    assert.equal(second.stderr.includes("-> read_file "), false, second.stderr);
    assert.match(second.stdout, /@trylo\/fixture-workspace/);
  } finally {
    fx.cleanup();
  }
});

test("starting a session id that already exists points at --resume", () => {
  const fx = fixture();
  try {
    assert.equal(run(fx, ["run", "--provider", "fixture", "--session", "dupe", "one"]).status, 0);
    const again = run(fx, ["run", "--provider", "fixture", "--session", "dupe", "two"]);
    assert.equal(again.status, 52);
    assert.match(again.stderr, /--resume dupe/);
  } finally {
    fx.cleanup();
  }
});

test("WP02: session rename, fork, info, export, archive and remove form a closed loop", () => {
  const fx = fixture();
  try {
    assert.equal(run(fx, ["run", "--provider", "fixture", "--session", "origin", "first turn"]).status, 0);
    assert.equal(run(fx, ["session", "rename", "origin", "Origin story"]).status, 0);
    const listed = run(fx, ["session", "list"]);

    assert.equal(listed.status, 0);
    assert.match(listed.stdout, /Origin story/);
    assert.match(listed.stdout, /first turn/);

    const forked = run(fx, ["session", "fork", "origin", "--new-id", "branch"]);

    assert.equal(forked.status, 0, forked.stderr);
    assert.match(forked.stdout, /origin -> branch/);
    const info = run(fx, ["session", "info", "branch", "--json"]);

    assert.equal(info.status, 0, info.stderr);
    const view = JSON.parse(info.stdout) as { forkedFrom: { parentSessionId: string } | null };

    assert.equal(view.forkedFrom?.parentSessionId, "origin");

    const exported = run(fx, ["session", "export", "branch"]);

    assert.equal(exported.status, 0, exported.stderr);
    const dump = JSON.parse(exported.stdout) as { transcript: Array<{ text: string }> };

    assert.equal(dump.transcript[0]?.text, "first turn");

    assert.equal(run(fx, ["session", "archive", "origin"]).status, 0);
    const parked = run(fx, ["session", "list"]);

    assert.equal(parked.status, 0);
    assert.doesNotMatch(parked.stdout, /origin/);
    const all = run(fx, ["session", "list", "--all"]);

    assert.match(all.stdout, /origin/);

    const removed = run(fx, ["session", "remove", "branch"]);

    assert.equal(removed.status, 0, removed.stderr);
    assert.match(removed.stdout, /removed branch/);
    assert.equal(run(fx, ["session", "info", "branch"]).status, 52);
  } finally {
    fx.cleanup();
  }
});

test("WP02: run --last continues the newest session and refuses an empty home", () => {
  const fx = fixture();
  try {
    const empty = run(fx, ["run", "--provider", "fixture", "--last", "hello"]);
    assert.equal(empty.status, 52);
    assert.match(empty.stderr, /no sessions/);
    assert.equal(run(fx, ["run", "--provider", "fixture", "--session", "latest", "first turn"]).status, 0);
    const continued = run(fx, ["run", "--provider", "fixture", "--last", "second turn"]);
    assert.equal(continued.status, 0, continued.stderr);
  } finally {
    fx.cleanup();
  }
});

test("doctor reports the same structured data in text and JSON", () => {
  const fx = fixture();
  try {
    const text = run(fx, ["doctor"]);

    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /runtime\.node/);
    assert.match(text.stdout, /workspace\.root/);

    const json = run(fx, ["doctor", "--json"]);

    assert.equal(json.status, 0, json.stderr);
    const report = JSON.parse(json.stdout) as {
      checks: Array<{ id: string; status: string; detail: string }>;
    };

    assert.equal(report.checks.some((check) => check.id === "runtime.node"), true);
    assert.equal(report.checks.some((check) => check.id === "learning.isolation"), true);
    assert.equal(report.checks.every((check) => check.status !== "fail"), true);
  } finally {
    fx.cleanup();
  }
});

test("config show reports each value's source layer", () => {
  const fx = fixture();
  try {
    mkdirSync(join(fx.workspace, ".trylo"), { recursive: true });
    writeFileSync(
      join(fx.workspace, ".trylo", "config.json"),
      JSON.stringify({ endpoint: "https://example.invalid/v1" }),
    );
    const json = run(fx, ["config", "show", "--json"]);

    assert.equal(json.status, 0, json.stderr);
    const view = JSON.parse(json.stdout) as {
      values: Record<string, { value: unknown; sourceLayer: string }>;
      layers: Array<{ layer: string; status: string }>;
    };

    assert.equal(view.values["endpoint"]?.value, "https://example.invalid/v1");
    assert.equal(view.values["endpoint"]?.sourceLayer, "project");
    assert.equal(view.values["provider"]?.sourceLayer, "packaged_default");
    // All five layers are accounted for, including the one this machine has no
    // directory for — "not evaluated" is the honest answer for `system`.
    assert.deepEqual(
      view.layers.map((layer) => layer.layer),
      ["packaged_default", "user", "project", "cli_flag"],
    );

    const text = run(fx, ["config", "show"]);

    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /endpoint = "https:\/\/example.invalid\/v1" {2}\(from project\)/);
  } finally {
    fx.cleanup();
  }
});

test("a config carrying a credential fails closed and never renders it", () => {
  const fx = fixture();
  try {
    mkdirSync(join(fx.workspace, ".trylo"), { recursive: true });
    writeFileSync(
      join(fx.workspace, ".trylo", "config.json"),
      JSON.stringify({ endpoint: "https://example.invalid/v1", apiKey: "super-secret-value" }),
    );
    // Tightened by the five-layer switch: the old four-layer loader redacted a
    // secret on the way out (`<redacted>`); the closed schema refuses it on the
    // way in. Both keep the value off the wire; only the second proves it.
    const json = run(fx, ["config", "show", "--json"]);

    assert.equal(json.status, 52);
    assert.equal(json.stdout.includes("super-secret-value"), false);
    assert.equal(json.stderr.includes("super-secret-value"), false);

    const text = run(fx, ["config", "show"]);

    assert.equal(text.stdout.includes("super-secret-value"), false);

    const doctor = run(fx, ["doctor"]);

    assert.equal(doctor.stdout.includes("super-secret-value"), false);
    assert.equal(doctor.stderr.includes("super-secret-value"), false);
  } finally {
    fx.cleanup();
  }
});

test("a malformed project config fails closed with the config exit code", () => {
  const fx = fixture();
  try {
    mkdirSync(join(fx.workspace, ".trylo"), { recursive: true });
    writeFileSync(join(fx.workspace, ".trylo", "config.json"), "{ not json");
    const result = run(fx, ["run", "--provider", "fixture", "hi"]);
    assert.equal(result.status, 52);
    assert.match(result.stderr, /config\.json is not usable/);
    assert.equal(result.stdout, "");
  } finally {
    fx.cleanup();
  }
});

test("openai-compatible without an endpoint fails closed on configuration", () => {
  const fx = fixture();
  try {
    const result = run(fx, ["run", "--provider", "openai-compatible", "hello"]);
    assert.equal(result.status, 52);
    assert.match(result.stderr, /endpoint/);
    assert.equal(result.stdout, "");
  } finally {
    fx.cleanup();
  }
});

test("openai-compatible with an endpoint but no credential fails closed without calling out", () => {
  const fx = fixture();
  try {
    // The endpoint resolves (so the config error is gone) but the key is
    // absent. This must be an auth failure before any request is sent — a real
    // provider smoke with no credentials is skipped, never faked as a pass.
    const args = [
      "run",
      "--provider",
      "openai-compatible",
      "--endpoint",
      "https://example.invalid/v1/chat/completions",
    ];
    const result = run(fx, [...args, "hello"]);

    assert.equal(result.status, 41);
    assert.equal(result.stdout, "");
    // A failed run must say why, in text mode as well as in the JSON stream.
    assert.match(result.stderr, /auth/i);
    assert.match(result.stderr, /credential/i);

    const json = run(fx, [...args, "--format", "stream-json", "hello"]);

    assert.equal(json.status, 41);
    const rows = jsonLines(json.stdout);
    const diagnostic = rows.find((row) => row["type"] === "warning");

    assert.equal(diagnostic?.["code"], "auth");
    assert.match(String(diagnostic?.["message"]), /credential/i);
    // One run_result, and nothing resembling a credential is echoed back.
    assert.equal(rows.filter((row) => row["type"] === "run_result").length, 1);
    assert.equal(/sk-|Bearer /.test(json.stdout), false);
  } finally {
    fx.cleanup();
  }
});

/**
 * A piped REPL runs every line it is given, not just the first.
 *
 * This is the regression that was quiet for a long while: `readline.question`
 * on a pipe answers once, so a scripted `printf '/a\n/b\n' | trylo` ran `/a`
 * and then met what looked like end-of-input. Nothing failed loudly — the
 * second command simply never happened, which is the worst shape a bug can
 * take. It is pinned here with a real child process because the failure lives
 * in how stdin is read, not in anything a unit test can reach.
 */
test("a piped REPL runs every command it is fed, not only the first", () => {
  const fx = fixture();
  try {
    const result = run(fx, [], "/status\n/model\n/exit\n");
    const said = `${result.stdout}${result.stderr}`;
    assert.match(said, /provider\s+/, "the first command did not run");
    // The second is the one that used to vanish.
    assert.match(said, /usage: \/model <model-id>/, "the second command never ran");
  } finally {
    fx.cleanup();
  }
});

/**
 * A piped REPL runs every line it is given, not just the first.
 *
 * This is the regression that was quiet for a long while: `readline.question`
 * on a pipe answers once, so a scripted `printf '/a\n/b\n' | trylo` ran `/a`
 * and then met what looked like end-of-input. Nothing failed loudly — the
 * second command simply never happened, which is the worst shape a bug can
 * take. It is pinned here with a real child process because the failure lives
 * in how stdin is read, not in anything a unit test can reach.
 */
test("a piped REPL runs every command it is fed, not only the first", () => {
  const fx = fixture();
  try {
    const result = run(fx, [], "/status\n/model\n/exit\n");
    const said = `${result.stdout}${result.stderr}`;
    assert.match(said, /provider\s+/, "the first command did not run");
    // The second is the one that used to vanish.
    assert.match(said, /usage: \/model <model-id>/, "the second command never ran");
  } finally {
    fx.cleanup();
  }
});
