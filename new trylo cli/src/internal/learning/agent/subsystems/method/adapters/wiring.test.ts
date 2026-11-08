import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFakePermission } from "../../../../../loop/fakes.js";
import type { MethodEventPayload } from "../port.js";
import { wirePorts, type WiringInput } from "../../../../../surface/cli/wiring.js";
import { LEARNING_SWITCH_METHOD, isMethodLearning, wireMethodLearning } from "./wiring.js";

/**
 * 开关与组合根（规格 §9；合同 T11、T12）。
 *
 * 三件事在这里被钉住：
 *
 *  - **关着 = 什么都没发生。** 不是「空板在跑」，而是连对象都没造——没有目录、
 *    没有 `load()`、没有锁。它由「家目录那棵树逐字节没变」证明，而不是由「我没
 *    看到写入」证明。
 *  - **开着但空档 = 一次读、零写入、零降级。** 文件不存在是正确答案（`§7.3`），
 *    不是一条 degraded。
 *  - **组合根只借公式，不复制公式。** 板的家必须跟着 `tryloHome` 走，包括
 *    `TRYLO_HOME` 生效时一起搬——所以这里把坏档分别放在「搬过去的家」与「原来的
 *    家」两处，看板读的是哪一个。
 */

const NOW_MS = 1_760_000_000_000;
const ISO = new Date(NOW_MS).toISOString();
const CORRUPT = "{ this is not a record\n";

type Emitted = { readonly kind: string; readonly payload: MethodEventPayload };

function recorder(): {
  readonly emit: (kind: string, payload: MethodEventPayload) => void;
  readonly events: Emitted[];
} {
  const events: Emitted[] = [];
  return {
    events,
    emit: (kind, payload) => {
      events.push({ kind, payload });
    },
  };
}

function degradedIn(events: ReadonlyArray<Emitted>, component: string): ReadonlyArray<Emitted> {
  return events.filter(
    (event) => event.payload.degraded === true && event.payload.component === component,
  );
}

/**
 * 一棵树的证据：每个文件的内容哈希 + 每个节点的时间戳。
 *
 * 「零写入」如果只断言「没有 `board-events.ndjson`」，就漏掉了 `mkdirSync` 与
 * `tryAcquireLock`——两者都是可观察的副作用，而 `createFileBoardStore` 两样都做。
 * 所以这里连**目录的 mtime** 一起量：建一个子目录会改父目录的时间戳，于是「只
 * 建了目录」这件事同样是一条红。
 */
function treeDigest(root: string): Readonly<Record<string, string>> {
  const digest: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : 1,
    );
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;

      if (entry.isDirectory()) {
        digest[rel] = `dir:${String(statSync(full).mtimeMs)}`;
        walk(full, rel);
        continue;
      }

      const hash = createHash("sha256").update(readFileSync(full)).digest("hex");

      digest[rel] = `file:${hash}:${String(statSync(full).mtimeMs)}`;
    }
  };

  if (existsSync(root)) {
    walk(root, "");
  }

  return digest;
}

function baseInput(root: string): Omit<WiringInput, "learning"> {
  return {
    providerId: "fixture",
    model: "test-model",
    endpoint: "",
    apiKey: undefined,
    workspaceRoot: path.join(root, "ws"),
    permission: createFakePermission("approved"),
    nowMs: NOW_MS,
  };
}

async function tempRoot(label: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `trylo-m2-wire-${label}-`));
}

test("T11: with the switch off nothing is constructed, read, or written", async () => {
  const root = await tempRoot("off");
  try {
    const homeDir = path.join(root, "home");

    mkdirSync(homeDir, { recursive: true });
    const before = treeDigest(homeDir);
    const emit = recorder();

    // 两种「关」：压根没给，以及给了但开关是空的。
    const wiring = wirePorts({ ...baseInput(root), });

    assert.equal("ports" in wiring, true);

    if (!("ports" in wiring)) {
      return;
    }

    assert.equal(wiring.ports.method, undefined);

    const withInput = wirePorts({
      ...baseInput(root),
      learning: { homeDir, env: {}, emit: emit.emit },
    });

    assert.equal("ports" in withInput, true);

    if (!("ports" in withInput)) {
      return;
    }

    assert.equal(withInput.ports.method, undefined);

    // 家目录那棵树逐字节没变：连一个目录都没有被建出来。
    assert.deepEqual(treeDigest(homeDir), before);
    assert.equal(existsSync(path.join(homeDir, ".trylo")), false);
    assert.deepEqual(emit.events, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the switch is one word, and every other value is off", async () => {
  assert.equal(LEARNING_SWITCH_METHOD, "method");
  assert.equal(isMethodLearning("method"), true);

  for (const value of ["off", "on", "true", "1", "Method", " method", "method ", "", "learning"]) {
    assert.equal(isMethodLearning(value), false, value);
  }

  assert.equal(isMethodLearning(undefined), false);

  const root = await tempRoot("set");

  try {
    const boardRoot = path.join(root, "learning", "board");
    const emit = recorder();

    for (const value of ["off", "true", "Method", ""]) {
      assert.equal(
        wireMethodLearning({ switch: value, boardRoot, now: () => ISO, emit: emit.emit }),
        undefined,
        value,
      );
    }

    // 一个都不该碰磁盘。
    assert.equal(existsSync(boardRoot), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("switched on with an empty archive: no slot, no write, no degradation", async () => {
  const root = await tempRoot("empty");
  try {
    const homeDir = path.join(root, "home");

    mkdirSync(homeDir, { recursive: true });
    const before = treeDigest(homeDir);
    const emit = recorder();

    const wiring = wirePorts({
      ...baseInput(root),
      learning: { switch: "method", homeDir, env: {}, emit: emit.emit },
    });

    assert.equal("ports" in wiring, true);

    if (!("ports" in wiring)) {
      return;
    }

    const method = wiring.ports.method;

    assert.notEqual(method, undefined, "the switch is on, so there must be a port");

    if (method === undefined) {
      return;
    }

    // 0 张候选 = 空槽 = 不注入。空档不是「编不出东西」，是「本来就没有东西」。
    assert.equal(await method.requestSlot({ turnId: "trn-a", beat: 1, toolNames: ["echo"] }), undefined);
    assert.equal(method.intentOn("trn-a", 1), false);
    await method.observe({
      turnId: "trn-a",
      beat: 1,
      failures: [],
      succeededTools: ["echo"],
      toolNames: ["echo"],
    });
    await method.endTurn("trn-a");

    // 文件不存在是正确答案，不是降级。
    assert.deepEqual(emit.events, []);
    // 读路径不 mkdir、不试锁，所以连 `.trylo` 都不该出现。
    assert.equal(existsSync(path.join(homeDir, ".trylo")), false);
    assert.deepEqual(treeDigest(homeDir), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a corrupt archive is read once, degrades once, and fails closed", async () => {
  const root = await tempRoot("corrupt");
  try {
    const boardRoot = path.join(root, "home", ".trylo", "learning", "board");

    mkdirSync(boardRoot, { recursive: true });
    writeFileSync(path.join(boardRoot, "board-events.ndjson"), CORRUPT, "utf8");
    const emit = recorder();

    const wiring = wirePorts({
      ...baseInput(root),
      learning: { switch: "method", homeDir: path.join(root, "home"), env: {}, emit: emit.emit },
    });

    assert.equal("ports" in wiring, true);

    if (!("ports" in wiring)) {
      return;
    }

    const method = wiring.ports.method;

    assert.notEqual(method, undefined);

    if (method === undefined) {
      return;
    }

    // 三拍请求加两拍事实：读档只发生一次，所以降级只说一遍。
    for (let beat = 1; beat <= 3; beat += 1) {
      assert.equal(await method.requestSlot({ turnId: "trn-a", beat, toolNames: ["echo"] }), undefined);
    }

    for (let beat = 1; beat <= 2; beat += 1) {
      await method.observe({
        turnId: "trn-a",
        beat,
        failures: [],
        succeededTools: ["echo"],
        toolNames: ["echo"],
      });
    }

    const degraded = degradedIn(emit.events, "method_archive");

    assert.equal(degraded.length, 1);
    assert.equal(typeof degraded[0]?.payload.reason, "string");
    // fail closed：读不出来的档不放权（因而不请求产出、不装剥离器）。
    assert.equal(method.intentOn("trn-a", 3), false);
    // 而且一个字节都没有被写回去。
    assert.equal(readFileSync(path.join(boardRoot, "board-events.ndjson"), "utf8"), CORRUPT);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the board follows tryloHome: TRYLO_HOME moves it, and nothing else does", async () => {
  const root = await tempRoot("home");
  try {
    const homeDir = path.join(root, "home");
    const moved = path.join(root, "other");
    const misplaced = path.join(moved, "learning", "board");

    mkdirSync(misplaced, { recursive: true });
    writeFileSync(path.join(misplaced, "board-events.ndjson"), CORRUPT, "utf8");

    // `TRYLO_HOME` 生效：家搬到 moved，于是板也搬过去，坏档被看见。
    const withOverride = recorder();
    const first = wirePorts({
      ...baseInput(root),
      learning: {
        switch: "method",
        homeDir,
        env: { TRYLO_HOME: moved },
        emit: withOverride.emit,
      },
    });

    assert.equal("ports" in first, true);

    if (!("ports" in first)) {
      return;
    }

    await first.ports.method?.requestSlot({ turnId: "trn-a", beat: 1, toolNames: ["echo"] });
    assert.equal(degradedIn(withOverride.events, "method_archive").length, 1);

    // 同一个 homeDir，但没有 `TRYLO_HOME`：家回到 `{home}/.trylo`，那里是空档。
    const withoutOverride = recorder();
    const second = wirePorts({
      ...baseInput(root),
      learning: { switch: "method", homeDir, env: {}, emit: withoutOverride.emit },
    });

    assert.equal("ports" in second, true);

    if (!("ports" in second)) {
      return;
    }

    await second.ports.method?.requestSlot({ turnId: "trn-a", beat: 1, toolNames: ["echo"] });
    assert.deepEqual(degradedIn(withoutOverride.events, "method_archive"), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
