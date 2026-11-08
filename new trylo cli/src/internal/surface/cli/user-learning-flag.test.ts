import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseArgs } from "./args.js";
import type { CliContext } from "./context.js";
import { collectDoctor, renderDoctorText } from "./doctor.js";
import { handleRun } from "./run-command.js";
import { USER_POLICY_CEILING_CHARS, userLearningRoot } from "./user-learning-config.js";
import { USER_LEDGER_FILE } from "../../integration/user-learning/ledger-file.js";
import { methodLearningRoot } from "./learning-sink.js";
import { wirePorts } from "./wiring.js";
import { createDenyAllPermission } from "./permission.js";

/**
 * 总开关闭集里 `user` / `all` 两半的合同（UE-4 / §7-#2 #9）。
 *
 * `method` 那一半的旗面、零差异与 doctor 默认行是 LA 包立的合同，仍在
 * `learning-flag.test.ts` 里跑，这里不重复。这一份只管新增的两半：
 *
 *  - **旗面**：`user` / `all` 收下，`method` 照旧收下，其余照旧是用法错；
 *  - **组装**：`--learning=user` 不建板目录（方法那一半根本没被问），只建账；
 *  - **doctor**：`learning.user_policy` 只在开关点了用户学习时出现，且只报
 *    开关 / 总顶 / 计数——政策正文一个字都不进诊断。
 */

const DEFAULT_LEARNING_DETAIL = "packaged no_learning profile; P01 activation is not consumed";

function temp(): { readonly home: string; readonly cwd: string; readonly cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "trylo-user-learning-"));
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

function runOptions(learning?: "user" | "all" | "method") {
  return { message: ["帮我写这周的周报，先说结论"], readStdin: false, ...(learning === undefined ? {} : { learning }) };
}

function doctorIo(ctx: CliContext) {
  return {
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
}

test("the total switch takes `user` and `all` in every placement that takes `method`", () => {
  for (const value of ["user", "all", "method"]) {
    const insideRun = parseArgs(["run", `--learning=${value}`, "hi"]);
    assert.equal(insideRun.kind, "run", `--learning=${value} inside run must be accepted`);
    const bare = parseArgs([`--learning=${value}`]);
    assert.equal(bare.kind, "repl", `a bare --learning=${value} is the REPL, and it takes the switch`);
    const doctor = parseArgs(["doctor", `--learning=${value}`]);
    assert.equal(doctor.kind, "doctor");
  }
  // The closed set itself did not grow: everything outside it is still refused,
  // and `user` becoming legal is not licence for near-misses to become legal too.
  for (const bad of ["users", "User", "USER", "both", "off", ""]) {
    assert.equal(parseArgs([`--learning=${bad}`]).kind, "error", `--learning=${bad} must be refused`);
  }
});

test("the composition root builds the user half only when the switch named it", () => {
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
    // No switch at all: nothing is constructed, `method` stays off the port table.
    const off = wirePorts(base);
    if ("code" in off) {
      assert.fail("expected a wiring");
    }

    assert.equal(off.ports.method, undefined);

    // `--learning=user` without a user runtime handed over: still nothing. The
    // switch alone does not build anything — the host does, and only for user/all.
    const userWithoutHost = wirePorts({
      ...base,
      learning: { switch: "user", homeDir: home, env: { TRYLO_HOME: home }, emit: () => undefined },
    });
    if ("code" in userWithoutHost) {
      assert.fail("expected a wiring");
    }

    assert.equal(userWithoutHost.ports.method, undefined);

    // `--learning=method` builds the board half and nothing else.
    const methodOnly = wirePorts({
      ...base,
      learning: { switch: "method", homeDir: home, env: { TRYLO_HOME: home }, emit: () => undefined },
    });
    if ("code" in methodOnly) {
      assert.fail("expected a wiring");
    }

    assert.notEqual(methodOnly.ports.method, undefined);
  } finally {
    cleanup();
  }
});

test("a run with the switch on lands evidence in the ledger; method-only lands none", async () => {
  const { home, cwd, cleanup } = temp();
  try {
    const { ctx } = ctxOf(home, cwd);
    const exit = await handleRun(ctx, runOptions("user"), { stdout: ctx.stdout, stderr: ctx.stderr });

    assert.equal(exit, 0);
    const ledgerPath = join(userLearningRoot(home, ctx.env), USER_LEDGER_FILE);

    assert.equal(existsSync(ledgerPath), true, "the user half must have written its ledger");
    const lines = readFileSync(ledgerPath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { readonly record?: string });

    assert.equal(lines.some((line) => line.record === "evidence"), true);
    assert.equal(lines.some((line) => line.record === "signal"), true);
    // The board's own directory is the method half's: `user` must not create it.
    assert.equal(existsSync(join(methodLearningRoot(home, ctx.env), "board")), false);
  } finally {
    cleanup();
  }
});

test("a method-only run never creates the user ledger", async () => {
  const { home, cwd, cleanup } = temp();
  try {
    const { ctx } = ctxOf(home, cwd);
    const exit = await handleRun(ctx, runOptions("method"), { stdout: ctx.stdout, stderr: ctx.stderr });

    assert.equal(exit, 0);
    assert.equal(
      existsSync(userLearningRoot(home, ctx.env)),
      false,
      "--learning=method must not read or write the user ledger",
    );
  } finally {
    cleanup();
  }
});

test("doctor adds the user line only when the switch names the user half", () => {
  const { home, cwd, cleanup } = temp();
  try {
    const { ctx } = ctxOf(home, cwd);
    const io = doctorIo(ctx);
    const base = { toolCatalogHash: "hash", sessionsDir: join(home, "sessions") };

    const off = collectDoctor(io, base);

    assert.equal(off.checks.some((check) => check.id === "learning.user_policy"), false);
    assert.equal(
      renderDoctorText(off).includes(`OK   learning.isolation  ${DEFAULT_LEARNING_DETAIL}`),
      true,
    );

    const method = collectDoctor(io, { ...base, learning: "method" });

    assert.equal(method.checks.some((check) => check.id === "learning.user_policy"), false);
    // And the method line is exactly the sentence it has always been.
    assert.equal(
      method.checks.find((check) => check.id === "learning.isolation")?.detail.startsWith(
        "method learning wired (board root:",
      ),
      true,
    );

    for (const [value, expected] of [
      ["user", "user learning wired (user)"],
      ["all", "user learning wired (all)"],
    ] as const) {
      const on = collectDoctor(io, { ...base, learning: value });
      const line = on.checks.find((check) => check.id === "learning.user_policy");
      assert.notEqual(line, undefined, `--learning=${value} must report the user half`);
      assert.equal(line?.status, "skip", "no ledger yet, and that is a fact worth stating");
      assert.equal(line?.detail.startsWith(expected), true, line?.detail);
    }

    // `all` also keeps the method line, because it really did turn the board on.
    const all = collectDoctor(io, { ...base, learning: "all" });

    assert.equal(all.checks.find((check) => check.id === "learning.isolation")?.detail.startsWith("method learning wired"), true);
    assert.equal(all.checks.some((check) => check.id === "learning.user_policy"), true);
  } finally {
    cleanup();
  }
});

test("doctor counts the ledger and never prints a single character of policy text", () => {
  const { home, cwd, cleanup } = temp();
  try {
    const { ctx } = ctxOf(home, cwd);
    const ledgerDir = userLearningRoot(home, ctx.env);

    mkdirSync(ledgerDir, { recursive: true });
    const secret = "先给结论，再按需展开背景与依据";
    const lines = [
      JSON.stringify({ record: "evidence", evidence: { rawText: "以后都先说结论" } }),
      JSON.stringify({ record: "signal", signal: "steer", eventId: "e1", at: 0 }),
      JSON.stringify({ record: "signal", signal: "reject", eventId: "e2", at: 0 }),
      JSON.stringify({ record: "receipt", receipt: { id: "r1" } }),
      JSON.stringify({ record: "policy", adopted: true, ruleIds: ["pol_x"], chars: 65 }),
      "not json at all",
      "",
    ];

    writeFileSync(join(ledgerDir, USER_LEDGER_FILE), `${lines.join("\n")}\n`, "utf8");

    // Doctor reads through the injected `io`, so the io has to be one that can
    // really see the file this test just wrote — that is the whole contract: the
    // *injection* decides what doctor sees, not a path the file pulled itself.
    const io = { ...doctorIo(ctx), readFile: (path: string): string | undefined => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    } };
    const report = collectDoctor(io, {
      toolCatalogHash: "hash",
      sessionsDir: join(home, "sessions"),
      learning: "user",
    });
    const line = report.checks.find((check) => check.id === "learning.user_policy");

    assert.notEqual(line, undefined);
    assert.equal(line?.status, "warn", "one unreadable line is a warning, not a silent zero");
    assert.equal(line?.detail.includes("ceiling " + USER_POLICY_CEILING_CHARS), true, line?.detail);
    assert.equal(line?.detail.includes("evidence 1"), true, line?.detail);
    assert.equal(line?.detail.includes("signals 2"), true, line?.detail);
    assert.equal(line?.detail.includes("receipts 1"), true, line?.detail);
    assert.equal(line?.detail.includes("unreadable 1"), true, line?.detail);
    assert.equal(line?.detail.includes("policy text is never printed"), true);

    const rendered = renderDoctorText(report);

    assert.equal(rendered.includes(secret), false, "the instruction text must not leave the ledger file");
    assert.equal(rendered.includes("以后都先说结论"), false, "raw user text must not leave the ledger file");
    assert.equal(rendered.includes("pol_x"), false, "not even a rule id needs to be printed");
  } finally {
    cleanup();
  }
});
