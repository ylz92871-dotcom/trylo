import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * `--subagent` 的组合级合同（`cmd/trylo` 层，黑盒进程）。
 *
 * 子代理运行时（spawn/wait/cancel、事件信封、journal 持久）由 `subagent/` 自己的
 * 测试背书；`wirePorts` 对 `subagent.enabled` 的挂载由 `wiring.test.ts` 背书。本文件
 * 只回答接线问题：
 *
 *  1. 开关存在且是「出现即全部含义」——`--subagent=false` 必须被拒绝，而不是被
 *     读成「是」或静默忽略；
 *  2. 开关打开时，一次真实 provider（fixture 脚本）的运行照常完成——挂载
 *     `delegate_subagent` 不得改变不调用它的运行的结果；
 *  3. 开关关闭是默认：不带 `--subagent` 的运行与从前逐字节一致。
 *
 * 红例（证明这三条由接线产生）：在未实现的代码上，`--subagent` 是
 * `unknown option`（退出码 2），第 1、2 条红。
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
  const root = mkdtempSync(join(os.tmpdir(), "trylo-subagent-flag-"));
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

test("--subagent mounts the runtime without changing a run that never calls it", () => {
  const fx = fixture();
  try {
    const plain = run(fx, ["run", "--provider", "fixture", "answer in one line"]);

    assert.equal(plain.status, 0, plain.stderr);
    const withFlag = run(fx, ["run", "--provider", "fixture", "--subagent", "answer in one line"]);

    assert.equal(withFlag.status, 0, withFlag.stderr);
    assert.match(withFlag.stdout, /@trylo\/fixture-workspace/);
    // The fixture script calls read_file, not delegate_subagent: the answer
    // text must be the same run, not a different one that merely succeeded.
    assert.equal(withFlag.stdout, plain.stdout);
  } finally {
    fx.cleanup();
  }
});

test("--subagent takes no value, so it cannot be turned into a default", () => {
  const fx = fixture();
  try {
    const result = run(fx, ["run", "--subagent=false", "answer"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--subagent takes no value/);
    assert.equal(result.stdout, "");
  } finally {
    fx.cleanup();
  }
});
