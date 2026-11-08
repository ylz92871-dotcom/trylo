import assert from "node:assert/strict";
import test from "node:test";
import { TOOL_LEDGER_FILE } from "../../learning/agent/subsystems/tool/runtime/index.js";
import { toolLearningCheck, type ToolLearningDoctorIo } from "./tool-learning-doctor.js";
import { toolLearningRoot } from "./tool-learning-config.js";

/**
 * `doctor` 里工具学习那一行（TP-1 §7 N6）。
 *
 * 这一组用例只关心三件事，每件都是「诊断会被人贴进 issue」逼出来的：
 *
 *  - **没账就如实说没有**，而不是报 0（「没跑过」与「跑了但没提议」是两件事）。
 *  - **只报条数**。账里的 `capability` 是模型自己写的一句话，可能捎带用户的事，
 *    所以断言它**一个字都不出现在诊断里**。
 *  - **读不懂的行如实报 unreadable**，而不是把它们当零。
 *
 * 用的是注入的假 `io`，所以没有一条用例碰真实文件系统——与
 * `user-learning-doctor.ts` 同一条纪律：诊断读的是哪一份，必须能被测试摆布。
 */

const HOME = "C:/tmp/tp1-doctor-home";
const ENV: Readonly<Record<string, string | undefined>> = {};

function memoryIo(files: Readonly<Record<string, string>>): {
  readonly io: ToolLearningDoctorIo;
  readonly asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    io: {
      homeDir: HOME,
      env: ENV,

      readFile: (absolutePath) => {
        // 归一化反斜杠：`path.join` 在 Windows 上给的是 `\`，而这张假表的键是 `/`。
        // 不归一化的话每条用例都会拿到 undefined，而症状看起来像「诊断读不到账」。
        const key = absolutePath.replaceAll("\\", "/");
        asked.push(key);
        return files[key];
      },
    },
  };
}

function ledgerPath(): string {
  return `${toolLearningRoot(HOME, ENV)}/${TOOL_LEDGER_FILE}`.replaceAll("\\", "/");
}

function line(kind: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ kind, at: "2026-09-18T00:00:00.000Z", turnId: "t1", ...extra });
}

test("R1 没有账 → skip，并如实说「还没有账」，而不是把它当零", () => {
  const { io, asked } = memoryIo({});
  const check = toolLearningCheck(io, "tool");

  assert.equal(check.id, "learning.tools");
  assert.equal(check.status, "skip");
  assert.equal(check.detail.includes("no ledger yet"), true);
  assert.equal(
    check.detail.replaceAll("\\", "/").includes(toolLearningRoot(HOME, ENV).replaceAll("\\", "/")),
    true,
  );
  // 它问的就是工具账那个文件，不是一个笼统的目录。
  assert.equal(asked.length, 1);
  assert.equal(asked[0]?.replaceAll("\\", "/"), ledgerPath());
});

test("R2 三种记录各数各的，状态 ok", () => {
  const { io } = memoryIo({
    [ledgerPath()]: [
      line("observation", { reason: "no_self_report", detail: "d" }),
      line("proposal", { key: "light_upgrade:run_shell", action: "light_upgrade", capability: "x", reason: "y" }),
      line("throttled", { key: "light_upgrade:run_shell", reason: "cooldown" }),
      line("throttled", { key: "light_upgrade:run_shell", reason: "cooldown" }),
    ].join("\n"),
  });
  const check = toolLearningCheck(io, "all");

  assert.equal(check.status, "ok");
  assert.equal(check.detail.includes("proposals 1"), true);
  assert.equal(check.detail.includes("observations 1"), true);
  assert.equal(check.detail.includes("throttled 2"), true);
  assert.equal(check.detail.includes("all"), true, "报的是开关的实际取值");
});

test("R3 坏行算 unreadable 并让状态变 warn（不许把读不懂的当零）", () => {
  const { io } = memoryIo({
    [ledgerPath()]: [line("proposal", {}), "{ 这不是 JSON", '"一个字符串"'].join("\n"),
  });
  const check = toolLearningCheck(io, "tool");

  assert.equal(check.status, "warn");
  assert.equal(check.detail.includes("proposals 1"), true);
  assert.equal(check.detail.includes("unreadable 2"), true);
});

test("R4 空行不算 unreadable（写坏的最后一行与空白不该报警）", () => {
  const { io } = memoryIo({ [ledgerPath()]: ["", line("proposal", {}), "   ", ""].join("\n") });
  const check = toolLearningCheck(io, "tool");
  assert.equal(check.status, "ok");
  assert.equal(check.detail.includes("proposals 1"), true);
  assert.equal(check.detail.includes("unreadable"), false);
});

test("R5 只报条数：账里的 capability 文本一个字都不进诊断", () => {
  const secret = "用户上周在改的那份合同叫XX";
  const { io } = memoryIo({
    [ledgerPath()]: [line("proposal", { key: "k", action: "light_upgrade", capability: secret, reason: secret })]
      .concat([line("observation", { reason: "no_self_report", detail: secret })])
      .join("\n"),
  });
  const check = toolLearningCheck(io, "tool");

  assert.equal(check.detail.includes(secret), false, "诊断会被贴进 issue，那句话不该那样离开本机");
  assert.equal(check.detail.includes("capability text is never printed"), true);
});
