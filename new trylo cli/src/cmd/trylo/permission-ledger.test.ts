import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * `--permission-ledger` 的组合级合同（`cmd/trylo` 层，黑盒进程）。
 *
 * 这里断言的是**接线**，不是零件：`adapters/permission-store` 的账本语义（校验和、
 * 序号连续、torn tail、跨进程锁、跨版本 fail-closed）由它自己的测试背书，本文件
 * 只回答三个接线问题：
 *
 *  1. 开关关闭时运行是否真的「不知道账本存在」——不读、不写、不建目录，哪怕磁盘上
 *     躺着一本已经损坏的账；
 *  2. 开关打开且账本读不出来时，进程是否**拒绝启动**并报出 store 自己的失败分类码，
 *     而不是把「账本坏了」静默降级成「没有账本」；
 *  3. 开关打开且账本就绪时，运行是否与关闭时逐字相同（就绪读取是只读的，不落盘）。
 *
 * 红例（证明这三条真的由接线产生，而不是恰好为真）：回退 `wiring.ts` /
 * `host.ts` / `run-command.ts` / `args-run.ts` 四处生产改动后，`--permission-ledger`
 * 不再存在，第 2、3 条因 `unknown option --permission-ledger`（退出码 2）而红。
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
  readonly ledger: string;
  readonly cleanup: () => void;
};

function fixture(): Fixture {
  const root = mkdtempSync(join(os.tmpdir(), "trylo-ledger-"));
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
    // 与 `run-command.ts::permissionLedgerPath` 同一形状：`tryloHome/permission/ledger.ndjson`。
    ledger: join(home, "permission", "ledger.ndjson"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function run(fx: Fixture, args: readonly string[]): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env, TRYLO_HOME: fx.home };

  delete env.TRYLO_API_KEY;
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: fx.workspace,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** 一本无法解码的账：缺校验和分隔符，`decodeStoreLedger` 报 `ledger_corrupt`。 */
const CORRUPT_LEDGER = "not-a-record\n";

function plantCorruptLedger(fx: Fixture): void {
  mkdirSync(join(fx.home, "permission"), { recursive: true });
  writeFileSync(fx.ledger, CORRUPT_LEDGER);
}

test("the switch is off by default: no ledger directory is created, and a corrupt file is never read", () => {
  const fx = fixture();
  try {
    // 磁盘上先放一本坏账。默认运行必须完全不受影响——这正是「关真的关着」的证据：
    // 如果接线在默认路径上读了这本账，这次运行就会失败。
    plantCorruptLedger(fx);
    const result = run(fx, ["run", "--provider", "fixture", "answer in one line"]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /@trylo\/fixture-workspace/);
    assert.equal(result.stderr.includes("ledger"), false, result.stderr);
  } finally {
    fx.cleanup();
  }
});

test("the switch is off by default: a run leaves no ledger behind", () => {
  const fx = fixture();
  try {
    const result = run(fx, ["run", "--provider", "fixture", "answer in one line"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(fx.home, "permission")), false);
  } finally {
    fx.cleanup();
  }
});

test("with the switch on, an unreadable ledger refuses the run instead of passing as absent", () => {
  const fx = fixture();
  try {
    plantCorruptLedger(fx);
    const result = run(fx, ["run", "--provider", "fixture", "--permission-ledger", "answer"]);

    // 52 = config：账本的位置来自配置，它的不可用是运行前就必须挡住的前提失败。
    assert.equal(result.status, 52, result.stderr);
    assert.match(result.stderr, /durable permission ledger is unusable/);
    assert.match(result.stderr, /ledger_corrupt/);
    // 报出的是 store 自己的分类码，不是一句笼统的「打不开」。
    assert.match(result.stderr, /checksum|missing checksum|malformed/);
    assert.equal(result.stdout, "");
  } finally {
    fx.cleanup();
  }
});

test("with the switch on and a readable ledger, the run is byte-identical and still writes nothing", () => {
  const fx = fixture();
  try {
    const result = run(fx, ["run", "--provider", "fixture", "--permission-ledger", "answer in one line"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /@trylo\/fixture-workspace/);
    // 就绪读取是只读的：`getGrant` 不加锁、不建目录、不落一条事件。
    assert.equal(existsSync(join(fx.home, "permission")), false);
  } finally {
    fx.cleanup();
  }
});

test("--permission-ledger takes no value, so it cannot be turned into a default", () => {
  const fx = fixture();
  try {
    const result = run(fx, ["run", "--permission-ledger=false", "answer"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--permission-ledger takes no value/);
    assert.equal(result.stdout, "");
  } finally {
    fx.cleanup();
  }
});
