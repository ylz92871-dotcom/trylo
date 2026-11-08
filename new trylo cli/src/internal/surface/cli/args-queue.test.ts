import assert from "node:assert/strict";
import { test } from "node:test";
import { parseQueue } from "./args-queue.js";
import type { ParsedCommand } from "./args-primitives.js";

/**
 * `trylo queue` 的解析面。
 *
 * 这一层只做两件事，且两件都能在不出进程、不碰磁盘的情况下验完：把三个动词
 * 读成三个选项形状，以及把不该接受的输入挡在**创建任何文件之前**。
 *
 * 第二件是这里真正要守的东西。队列路径由会话 id 派生，所以一个含 `..` 的
 * id 就是一条逃出队列目录的路径；而 `blank` 消息如果先建文件再拒绝，下一次
 * 读会看到「空队列」，而不是「从没排过」——后者才是那个人需要知道的。
 */

function optionsOf(command: ParsedCommand): Record<string, unknown> {
  assert.notEqual(command.kind === "error", true, `expected a queue command, got: ${JSON.stringify(command)}`);
  const options = (command as { options?: Record<string, unknown> }).options;
  assert.notEqual(options, undefined, `${command.kind} carries no options`);
  return options ?? {};
}

function errorMessage(command: ParsedCommand): string {
  assert.equal(command.kind, "error", `expected a usage error, got: ${command.kind}`);
  return (command as { message: string }).message;
}

test("add reads the two required flags and keeps the text verbatim", () => {
  const command = parseQueue(["add", "--session", "s-1", "--message", "  hello  "]);
  assert.equal(command.kind, "queue_add");
  assert.deepEqual(optionsOf(command), { sessionId: "s-1", text: "  hello  ", json: false });
});

test("add accepts the inline form and the json switch", () => {
  const command = parseQueue(["add", "--session=s-1", "--message=hi", "--json"]);
  assert.deepEqual(optionsOf(command), { sessionId: "s-1", text: "hi", json: true });
});

test("a message that begins with a dash is a value, not a mystery flag", () => {
  const command = parseQueue(["add", "--session", "s-1", "--message", "--force"]);
  assert.equal(optionsOf(command)["text"], "--force");
});

test("list defaults to twenty and accepts a limit up to the cap", () => {
  assert.equal(optionsOf(parseQueue(["list", "--session", "s-1"]))["limit"], 20);
  assert.equal(optionsOf(parseQueue(["list", "--session", "s-1", "--limit", "5"]))["limit"], 5);
  assert.equal(optionsOf(parseQueue(["list", "--session", "s-1", "--limit", "100"]))["limit"], 100);
});

test("a limit outside the cap is refused rather than clamped", () => {
  // Clamping would be a quiet lie: `--limit 1000` would print twenty lines and
  // the person would believe they saw the queue.
  for (const limit of ["0", "-1", "101", "abc", "2.5"]) {
    assert.match(
      errorMessage(parseQueue(["list", "--session", "s-1", "--limit", limit])),
      /--limit must be a whole number from 1 to 100/,
      `limit ${limit} should be refused`,
    );
  }
});

test("drop needs both the session and the id", () => {
  assert.deepEqual(optionsOf(parseQueue(["drop", "--session", "s-1", "--id", "q-1"])), {
    sessionId: "s-1",
    id: "q-1",
    json: false,
  });
  assert.match(errorMessage(parseQueue(["drop", "--session", "s-1"])), /requires --id/);
});

test("every verb refuses a missing session, in its own words", () => {
  // `drop` reports the missing `--id` first, because that check runs first. What
  // is asserted here is only that none of the three accepts a command with no
  // session — which one complaint it leads with is a wording choice, not a
  // contract.
  for (const sub of ["add", "list", "drop"]) {
    assert.equal(
      parseQueue([sub]).kind,
      "error",
      `${sub} should refuse a missing session`,
    );
  }

  // And where the session is the only thing missing, all three say so.
  assert.match(errorMessage(parseQueue(["add", "--message", "x"])), /requires --session/);
  assert.match(errorMessage(parseQueue(["list"])), /requires --session/);
  assert.match(errorMessage(parseQueue(["drop", "--id", "q-1"])), /requires --session/);
});

test("a session id that could escape the queue directory is refused", () => {
  // The queue path is `${tryloHome}/queue/<id>.ndjson`, so `..` here is not a
  // cosmetic id — it is a path. Refused at the parser, where the person can see
  // what they typed, rather than by the filesystem with a message about a path
  // they never typed.
  for (const id of ["../escape", "a/b", "..", "with space"]) {
    assert.match(
      errorMessage(parseQueue(["list", "--session", id])),
      /not a usable session id/,
      `id ${id} should be refused`,
    );
  }
});

test("a blank message is refused here, before anything is created", () => {
  assert.match(
    errorMessage(parseQueue(["add", "--session", "s-1", "--message", "   "])),
    /non-empty --message/,
  );
});

test("a flag from another family is refused by name", () => {
  assert.match(
    errorMessage(parseQueue(["add", "--session", "s-1", "--message", "x", "--force"])),
    /queue add does not accept --force/,
  );
});

test("an unknown subcommand lists the three that exist", () => {
  const command = parseQueue(["send"]);
  assert.equal(command.kind, "error");
  assert.match(errorMessage(command), /unknown queue subcommand: send/);
  // The three verbs live in the hint, which is where every other family puts
  // its "try one of these" line.
  assert.match((command as { hint: string }).hint, /add\|list\|drop/);
});

test("no subcommand at all is a usage error, not an empty queue read", () => {
  assert.match(errorMessage(parseQueue([])), /queue requires a subcommand/);
});

test("help is the family help on every path into the family", () => {
  for (const argv of [["--help"], ["-h"], ["add", "--help"], ["list", "-h"], ["drop", "--help"]]) {
    const command = parseQueue(argv);
    assert.equal(command.kind, "family_help", `${argv.join(" ")} should be family help`);
    assert.deepEqual(optionsOf(command), { family: "queue" });
  }
});
