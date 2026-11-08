import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  METHOD_EVENTS_FILE,
  createMethodEventSink,
  createMethodLearningWiring,
  methodBoardRoot,
  methodLearningRoot,
} from "./learning-sink.js";

/**
 * 生产 sink 的合同。
 *
 * 用真的文件系统（临时目录）而不是假 IO：这些断言里有两条——「目录是惰性建的」
 * 和「写失败不上抛」——只有在真的 `mkdirSync` / `appendFileSync` 会失败的时候才
 * 有意义，用一个替身去模拟就等于把要测的东西换成了对替身的假设。
 */

function temp(): { readonly root: string; readonly cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "trylo-method-sink-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function linesOf(path: string): ReadonlyArray<string> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

/** 板唯一会 emit 的三种载荷，形状抄 `learning/method/board.ts` 的三处调用。 */
const ARCHIVE_DEGRADED = { degraded: true, component: "method_archive", reason: "corrupt" };
const SCHEDULER_RELEASE = {
  component: "method_scheduler",
  decision: "release",
  releaseId: "rel-1",
  tool: "write_file",
  code: "path_outside_workspace",
  repeats: 2,
  reason: "path_outside_workspace",
};
const GATE_REFUSED = {
  degraded: true,
  component: "method_gate",
  reason: "unknown_label",
  releaseId: "rel-1",
};

test("each board observation lands as one valid ndjson line", () => {
  const { root, cleanup } = temp();
  try {
    const sink = createMethodEventSink(join(root, "learning"), {
      now: () => "2026-09-16T00:00:00.000Z",
      warn: () => undefined,
    });

    sink("observation", ARCHIVE_DEGRADED);
    sink("observation", SCHEDULER_RELEASE);
    sink("observation", GATE_REFUSED);

    const lines = linesOf(join(root, "learning", METHOD_EVENTS_FILE));

    assert.equal(lines.length, 3);
    const components: string[] = [];

    for (const line of lines) {
      const parsed: unknown = JSON.parse(line);

      assert.equal(typeof parsed === "object" && parsed !== null, true);
      const record = parsed as {
        readonly occurredAt?: unknown;
        readonly kind?: unknown;
        readonly payload?: { readonly component?: unknown };
      };

      assert.equal(record.occurredAt, "2026-09-16T00:00:00.000Z");
      assert.equal(record.kind, "observation");
      assert.equal(typeof record.payload?.component, "string", line);
      components.push(String(record.payload?.component));
    }

    assert.deepEqual(components, ["method_archive", "method_scheduler", "method_gate"]);
  } finally {
    cleanup();
  }
});

test("the log appends rather than rewrites", () => {
  const { root, cleanup } = temp();
  try {
    const dir = join(root, "learning");

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, METHOD_EVENTS_FILE), '{"earlier":true}\n', "utf8");
    const sink = createMethodEventSink(dir, {
      now: () => "2026-09-16T00:00:00.000Z",
      warn: () => undefined,
    });

    sink("observation", ARCHIVE_DEGRADED);
    const lines = linesOf(join(dir, METHOD_EVENTS_FILE));

    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0] ?? ""), { earlier: true });
  } finally {
    cleanup();
  }
});

test("the directory is created lazily, so a silent board leaves nothing", () => {
  const { root, cleanup } = temp();
  try {
    const dir = join(root, "learning");
    createMethodEventSink(dir, { now: () => "t", warn: () => undefined });
    assert.equal(existsSync(dir), false, "a sink that never emitted must not create its directory");
  } finally {
    cleanup();
  }
});

test("a write failure is reported once and never thrown", () => {
  const { root, cleanup } = temp();
  try {
    // A file where a directory is expected: `mkdirSync` fails, and no amount of
    // catching turns that into a writable path.
    const blocked = join(root, "a-file");

    writeFileSync(blocked, "not a directory", "utf8");
    const warnings: string[] = [];
    const sink = createMethodEventSink(join(blocked, "learning"), {
      now: () => "t",
      warn: (message) => warnings.push(message),
    });

    // Learning must not be able to break a user's turn, so neither of these may
    // throw — and the second one must not produce a second warning either.
    sink("observation", ARCHIVE_DEGRADED);
    sink("observation", GATE_REFUSED);
    assert.deepEqual(warnings, ["method_event_sink_failed:ENOTDIR"]);
  } finally {
    cleanup();
  }
});

test("the learning roots follow TRYLO_HOME rather than a second formula", () => {
  const env = { TRYLO_HOME: join("C:", "trylo-home") };
  assert.equal(methodLearningRoot("C:/users/x", env), join("C:", "trylo-home", "learning"));
  assert.equal(methodLearningRoot("C:/users/x", {}), join("C:", "users", "x", ".trylo", "learning"));
  assert.equal(methodBoardRoot("C:/users/x", env), join("C:", "trylo-home", "learning", "board"));
});

test("the wiring carries the switch and borrows a sink bound to the learning root", () => {
  const { root, cleanup } = temp();
  try {
    const wiring = createMethodLearningWiring(
      { switch: "method", homeDir: root, env: { TRYLO_HOME: join(root, "home") } },
      { now: () => "2026-09-16T00:00:00.000Z", warn: () => undefined },
    );

    assert.equal(wiring.switch, "method");
    assert.equal(wiring.homeDir, root);
    wiring.emit("observation", ARCHIVE_DEGRADED);
    assert.equal(linesOf(join(root, "home", "learning", METHOD_EVENTS_FILE)).length, 1);
  } finally {
    cleanup();
  }
});
