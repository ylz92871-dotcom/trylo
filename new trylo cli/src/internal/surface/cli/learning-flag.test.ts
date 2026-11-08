import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CliContext } from "./context.js";
import { parseArgs } from "./args.js";
import { collectDoctor, renderDoctorText } from "./doctor.js";
import { handleRun } from "./run-command.js";
import { wirePorts } from "./wiring.js";
import { createDenyAllPermission } from "./permission.js";
import { methodBoardRoot, methodLearningRoot, METHOD_EVENTS_FILE } from "./learning-sink.js";
import { flagLayer } from "./run-settings.js";
import type { RunCommandOptions } from "./args.js";
import { reportBeat } from "../../loop/method-signal.js";
import { createTurnRenderer } from "./render.js";

/**
 * 入口通电的合同（LA-1 旗面 / LA-3 组装与 doctor）。
 *
 * 三条最要紧的都在这：① 只有 `method` 一个值，别的全是用法错；② 不传 ⇒ 组合根
 * 拿不到 `learning`，`LoopPorts.method` 是 `undefined`，学习目录不出现（I1）；
 * ③ doctor 的默认输出**一个字都不变**——零差异门把诊断输出也算在内。
 */

const DEFAULT_LEARNING_DETAIL = "packaged no_learning profile; P01 activation is not consumed";

function temp(): { readonly home: string; readonly cwd: string; readonly cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "trylo-learning-flag-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  mkdirSync(cwd, { recursive: true });
  return { home, cwd, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function ctxOf(home: string, cwd: string): { readonly ctx: CliContext; readonly out: string[]; readonly err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CliContext = {
    env: { TRYLO_HOME: home },
    homeDir: home,
    cwd,
    nodeVersion: "v22.0.0",
    stdinIsTty: false,
    readFile: () => undefined,
    isDirectory: () => true,
    readDir: () => [],
    writeFile: () => true,
    readStdin: async () => "",
    readLine: async () => undefined,
    readSecret: async () => undefined,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    now: () => 0,
    newId: (prefix) => `${prefix}-1`,
  };

  return { ctx, out, err };
}

function runOptions(learning?: string): RunCommandOptions {
  return { message: ["hello"], readStdin: false, ...(learning === undefined ? {} : { learning: learning as "method" }) };
}

test("only `method` is accepted, and a misspelling is a usage error rather than a mode", () => {
  for (const bad of ["off", "true", "METHOD", "Method", "methods", "", "on"]) {
    const inRun = parseArgs(["run", `--learning=${bad}`, "hi"]);
    assert.equal(inRun.kind, "error", `--learning=${bad} inside run must be refused`);
    const bare = parseArgs([`--learning=${bad}`]);
    assert.equal(bare.kind, "error", `--learning=${bad} before the command must be refused`);
  }

  const good = parseArgs(["run", "--learning=method", "hi"]);

  assert.equal(good.kind, "run");

  if (good.kind === "run") {
    assert.equal(good.options.learning, "method");
  }
});

test("the switch is accepted in both placements and reaches the REPL", () => {
  const insideRun = parseArgs(["run", "--learning=method", "hi"]);

  assert.equal(insideRun.kind, "run");

  if (insideRun.kind === "run") {
    assert.equal(insideRun.options.learning, "method");
  }

  const beforeRun = parseArgs(["--learning", "method", "run", "hi"]);

  assert.equal(beforeRun.kind, "run");

  if (beforeRun.kind === "run") {
    assert.equal(beforeRun.options.learning, "method");
  }

  // The bare command is the REPL, and D1 says it takes the switch too.
  const repl = parseArgs(["--learning=method"]);

  assert.equal(repl.kind, "repl");

  if (repl.kind === "repl") {
    assert.equal(repl.learning, "method");
  }

  const bare = parseArgs([]);

  assert.equal(bare.kind, "repl");

  if (bare.kind === "repl") {
    assert.equal(bare.learning, undefined);
  }
});

test("a command that does not consume the switch refuses it instead of ignoring it", () => {
  assert.equal(parseArgs(["--learning=method", "config", "show"]).kind, "error");
  assert.equal(parseArgs(["--learning=method", "session", "list"]).kind, "error");
  assert.equal(parseArgs(["run", "--learning"]).kind, "error");
  assert.equal(parseArgs(["doctor", "--learning"]).kind, "error");
  // `--help` / `--version` are meta-commands rather than runs, so they stay
  // answerable even with a switch in front: refusing to print help because a
  // flag was typed would be pedantry, not fail-closed behaviour.
  assert.equal(parseArgs(["--learning=method", "--help"]).kind, "help");
  assert.equal(parseArgs(["--learning=method", "version"]).kind, "version");
  // Unaffected neighbours keep working exactly as before.
  assert.equal(parseArgs(["config", "show", "--json"]).kind, "config_show");
  assert.equal(parseArgs(["doctor", "--json"]).kind, "doctor");
});

test("the switch has exactly one entry point: no config layer carries it", () => {
  const layer = flagLayer({ message: [], readStdin: false, learning: "method" });
  assert.equal("learning" in layer, false, "learning must not become a config key");
});

test("doctor says the same thing by default and more only when asked", () => {
  const { home, cwd, cleanup } = temp();
  try {
    const { ctx } = ctxOf(home, cwd);
    const io = {
      readFile: ctx.readFile,
      isDirectory: ctx.isDirectory,
      readDir: ctx.readDir,
      env: ctx.env,
      homeDir: ctx.homeDir,
      cwd: ctx.cwd,
      workspaceRoot: ctx.cwd,
      nodeVersion: ctx.nodeVersion,
      now: ctx.now,
    };
    const base = { toolCatalogHash: "hash", sessionsDir: join(home, "sessions") };

    const off = collectDoctor(io, base);
    const offCheck = off.checks.find((check) => check.id === "learning.isolation");

    assert.equal(offCheck?.detail, DEFAULT_LEARNING_DETAIL);
    assert.equal(offCheck?.status, "ok");

    const on = collectDoctor(io, { ...base, learning: "method" });
    const onCheck = on.checks.find((check) => check.id === "learning.isolation");

    assert.equal(onCheck?.status, "ok");
    assert.equal(onCheck?.detail, `method learning wired (board root: ${methodBoardRoot(home, ctx.env)})`);

    // The rendered default line is the gate, not the object: a byte-level
    // regression here would be invisible in a field-by-field comparison.
    assert.equal(
      renderDoctorText(off).includes(`OK   learning.isolation  ${DEFAULT_LEARNING_DETAIL}`),
      true,
    );
    // Item count and exit semantics are untouched by the switch.
    assert.equal(on.checks.length, off.checks.length);
  } finally {
    cleanup();
  }
});

test("the composition root builds the board only when the switch asked for it", () => {
  const { home, cwd, cleanup } = temp();
  try {
    const base = {
      providerId: "fixture" as const,
      model: "default",
      endpoint: "",
      apiKey: undefined,
      workspaceRoot: cwd,
      permission: createDenyAllPermission(),
    };
    const off = wirePorts(base);
    if ("code" in off) {
      assert.fail("expected a wiring");
    }

    assert.equal(off.ports.method, undefined);

    const on = wirePorts({
      ...base,
      learning: {
        switch: "method",
        homeDir: home,
        env: { TRYLO_HOME: home },
        emit: () => undefined,
      },
    });
    if ("code" in on) {
      assert.fail("expected a wiring");
    }

    assert.notEqual(on.ports.method, undefined);

    // Nothing else about the port table moves: the switch adds `method` and
    // nothing else. (`LoopPorts` has no `intra` any more — this is the same
    // claim the work package made as contract #7.)
    const offKeys = Object.keys(off.ports).sort();
    const onKeys = Object.keys(on.ports).sort();

    assert.deepEqual(onKeys, [...offKeys, "method"].sort());
  } finally {
    cleanup();
  }
});

test("a real run with the switch on reaches the board, and one without it touches nothing", async () => {
  const { home, cwd, cleanup } = temp();
  try {
    const { ctx } = ctxOf(home, cwd);

    // A corrupt board log makes the archive unreadable, which is the one thing
    // the board always reports: it turns "the board was constructed" into a
    // line on disk instead of a private fact inside the process.
    mkdirSync(methodBoardRoot(home, ctx.env), { recursive: true });
    writeFileSync(join(methodBoardRoot(home, ctx.env), "board-events.ndjson"), "not json at all\n", "utf8");

    // A damaged archive must not fail the user's turn: learning reports
    // `degraded` and the run finishes. This is contract #5 as much as #1.
    const exit = await handleRun(ctx, runOptions("method"), {
      stdout: ctx.stdout,
      stderr: ctx.stderr,
    });

    assert.equal(exit, 0, "a learning-side failure must not change the run's exit code");
    const logPath = join(methodLearningRoot(home, ctx.env), METHOD_EVENTS_FILE);

    assert.equal(existsSync(logPath), true, "the board's observation must reach the sink");
    const lines = readFileSync(logPath, "utf8").split("\n").filter((line) => line.length > 0);
    const degraded = lines
      .map((line) => JSON.parse(line) as { readonly payload?: { readonly component?: string } })
      .filter((record) => record.payload?.component === "method_archive");

    // One board, one load, one report.
    assert.equal(degraded.length, 1, `expected one archive observation, got ${degraded.length}`);
  } finally {
    cleanup();
  }
});

test("a genuine learning-side degradation names its component, not just `observation`", async () => {
  const { home, cwd, cleanup } = temp();
  try {
    const { ctx, err } = ctxOf(home, cwd);

    // A normal failed read retains its call metadata and does not degrade the
    // sensor. Then exercise a genuinely damaged legacy transcript separately.
    await handleRun(ctx, runOptions("method"), { stdout: ctx.stdout, stderr: ctx.stderr });
    assert.equal(err.join("").includes("method_sensor"), false);
    const wired = wirePorts({providerId:"fixture",model:"default",endpoint:"",apiKey:undefined,workspaceRoot:cwd,permission:createDenyAllPermission(),
      learning:{switch:"method",homeDir:home,env:ctx.env,emit:()=>undefined}});
    if ("code" in wired) assert.fail("expected a wiring");

    assert.ok(wired.ports.method);
    const renderer = createTurnRenderer("text",{stdout:ctx.stdout,stderr:ctx.stderr},{sessionId:"sensor-test",turnId:"sensor-turn",providerId:"fixture",model:"default"});

    await reportBeat({port:wired.ports.method,turnId:"sensor-turn",beat:1,tools:wired.ports.tools,take:undefined,
      transcript:[{kind:"tool_result",sequence:0,toolCallId:"missing-call",name:"read_file",output:"read_failed:missing",truncated:false,outcome:"failed"}],
      emit:(kind,payload)=>renderer.onEnvelope({protocolVersion:"0.0",eventId:"sensor-1",sequence:1,timestamp:"2026-10-13T00:00:00.000Z",kind,payload,producerId:"loop",producerSequence:1})});
    const printed = err.join("");

    assert.equal(
      printed.includes("warning observation"),
      false,
      `a component-less warning is unreadable: ${printed}`,
    );
    assert.equal(
      printed.includes("method_sensor"),
      true,
      `the sensor's own name must reach the user: ${printed}`,
    );
  } finally {
    cleanup();
  }
});

test("a run without the switch creates no learning directory at all", async () => {
  const { home, cwd, cleanup } = temp();
  try {
    const { ctx } = ctxOf(home, cwd);

    await handleRun(ctx, runOptions(), { stdout: ctx.stdout, stderr: ctx.stderr });
    assert.equal(
      existsSync(methodLearningRoot(home, ctx.env)),
      false,
      "the default path must not create a learning directory",
    );
  } finally {
    cleanup();
  }
});
