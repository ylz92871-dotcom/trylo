import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  CONTAINMENT_FAILURE_CODES,
  RELEASE_POLICY,
  createReleaseLedger,
  releaseFor,
  withRelease,
  type BeatFacts,
  type ReleaseLedger,
} from "./release.js";
import { DEFAULT_METHOD_GRANT, type ObservedFact } from "./contracts.js";

/**
 * 放权判定（合同 T5 的判定侧、T12 的「不自动」侧）。
 *
 * 这是纯函数，所以这里不需要板、不需要档、不需要 provider：一个纯函数能被直接
 * 摆布，正是「机会 ≠ 课题」这条机理在工程上的好处——「这一拍允不允许带学习
 * 意图」与「学什么」是两件事，所以前者可以被单独钉死。
 *
 * 三条数写在 `RELEASE_POLICY` 里，本文件用**表**断它们而不是用字面量，改政策
 * 时这里不需要跟着改（除非改动本身就是要破坏这些性质）。
 */

const TURN = "trn-r";

function fact(code: string, overrides: Partial<ObservedFact> = {}): ObservedFact {
  return { tool: "echo", code, fingerprint: "fp-a", ...overrides };
}

function beat(
  n: number,
  failures: ReadonlyArray<ObservedFact>,
  succeededTools: ReadonlyArray<string> = [],
): BeatFacts {
  return { turnId: TURN, beat: n, failures, succeededTools };
}

/**
 * 把一串拍折进账，返回每一拍的决策。
 *
 * `withRelease` 必须在这里显式调一次，因为 `releaseFor` **不**替你记这一次放权：
 * 板才是账的所有者（`board.ts::observeBeat` 就是这么接的）。少了它，同一个三元
 * 组会在下一拍被再放一次权——本文件里有两条用例专门钉住那一件事。
 */
function tick(
  beats: ReadonlyArray<BeatFacts>,
  ledger: ReleaseLedger = createReleaseLedger(TURN),
): { readonly ledger: ReleaseLedger; readonly decisions: ReadonlyArray<string> } {
  const decisions: string[] = [];
  let current = ledger;

  for (const one of beats) {
    const result = releaseFor(current, one);

    current =
      result.decision.kind === "release"
        ? withRelease(result.ledger, result.decision.release)
        : result.ledger;
    decisions.push(
      result.decision.kind === "release"
        ? `release:${result.decision.release.reason}`
        : `${result.decision.kind}:${result.decision.reason}`,
    );
  }

  return { ledger: current, decisions };
}

test("one failure is a data point, never a lesson", () => {
  const { decisions } = tick([beat(1, [fact("tool_timeout")])]);
  assert.deepEqual(decisions, ["hold:not_repeated"]);
});

test("a repeated call is a release on the second sighting, one beat later", () => {
  const repeated = fact("tool_timeout");
  const result = releaseFor(
    releaseFor(createReleaseLedger(TURN), beat(1, [repeated])).ledger,
    beat(2, [repeated]),
  );

  assert.equal(result.decision.kind, "release");

  if (result.decision.kind !== "release") {
    return;
  }

  assert.equal(result.decision.release.reason, "repeat_call");
  assert.equal(result.decision.release.tool, "echo");
  assert.equal(result.decision.release.code, "tool_timeout");
  assert.equal(result.decision.release.beat, 2);
  assert.equal(result.decision.release.repeats, 2);
  assert.equal(result.decision.release.turnId, TURN);
});

test("a containment failure is a reason the first time it is seen", () => {
  // 两个不同的码，同一拍，比的是「理由有没有在第一次就成立」。遏制失败自带
  // 理由（越界了一次就够），普通失败要等第二次（一个数据点是噪声）。
  const containment = releaseFor(
    createReleaseLedger(TURN),
    beat(1, [fact("path_outside_workspace")]),
  );
  const plain = releaseFor(createReleaseLedger(TURN), beat(1, [fact("tool_timeout")]));

  assert.deepEqual(
    containment.decision.kind === "hold" ? containment.decision.reason : containment.decision.kind,
    "need_another_attempt",
  );
  assert.deepEqual(
    plain.decision.kind === "hold" ? plain.decision.reason : plain.decision.kind,
    "not_repeated",
  );
  // 理由本身落进了账，所以第二拍不必再看历史就能放权。
  const record = Object.values(containment.ledger.records)[0];

  assert.equal(record?.reason, "containment");
});

test("two identical calls inside one beat are one beat of evidence", () => {
  const repeated = fact("tool_timeout");
  const result = releaseFor(createReleaseLedger(TURN), beat(1, [repeated, repeated]));
  const records = Object.values(result.ledger.records);

  // 去重发生在计数里，所以「一拍内试了两次」是**一个**数据点：它不足以凑够
  // `requiredOccurrences`，因此这一拍连候选都算不上。
  assert.equal(records.length, 1);
  assert.equal(records[0]?.occurrences, 1);
  assert.equal(records[0]?.firstBeat, 1);
  assert.equal(records[0]?.lastBeat, 1);
});

test("a whole beat has to pass between the two sightings", () => {
  const repeated = fact("tool_timeout");
  // 拍 1 与拍 2 之间没有别的拍：`beatsToWaitAfterFirstFailure` 要求的是间隔，
  // 而这里两拍相邻，所以放权成立；把它压进同一拍（上一条）就不成立。
  const { decisions } = tick([beat(1, [repeated]), beat(2, [repeated])]);

  assert.deepEqual(decisions, ["hold:not_repeated", "release:repeat_call"]);
  assert.equal(RELEASE_POLICY.beatsToWaitAfterFirstFailure, 1);
  assert.equal(RELEASE_POLICY.requiredOccurrences, 2);
});

test("one release per turn is a hard ceiling", () => {
  // 两个不同的三元组在拍 2 都已经够格。拍 2 只批一次，所以另一个在拍 3 撞上
  // 额度，而不是撞上自己的条件。
  const a = fact("tool_timeout", { tool: "echo", fingerprint: "fp-a" });
  const b = fact("tool_timeout", { tool: "write_file", fingerprint: "fp-b" });
  const { decisions } = tick([
    beat(1, [a, b]),
    beat(2, [a, b]),
    beat(3, [a, b]),
  ]);

  assert.deepEqual(decisions, ["hold:not_repeated", "release:repeat_call", "idle:no_budget"]);
  assert.equal(RELEASE_POLICY.maxReleasesPerTurn, 1);
});

test("a triple that has already been released is not a candidate again", () => {
  const repeated = fact("tool_timeout");
  // 把额度调宽，单独测这一条：否则 `maxReleasesPerTurn` 会先把它挡住，红的地方
  // 就不是这里要说的事了。
  const wide = { ...DEFAULT_METHOD_GRANT, releases: 5 };
  const first = releaseFor(createReleaseLedger(TURN), beat(1, [repeated]), wide);
  const second = releaseFor(first.ledger, beat(2, [repeated]), wide);

  assert.equal(second.decision.kind, "release");
  const afterSecond =
    second.decision.kind === "release"
      ? withRelease(second.ledger, second.decision.release)
      : second.ledger;
  const third = releaseFor(afterSecond, beat(3, [repeated]), wide);

  assert.deepEqual(
    third.decision.kind === "hold" ? third.decision.reason : third.decision.kind,
    "not_repeated",
  );
});

test("success clears the count for its own tool, and only its own", () => {
  const echo = fact("tool_timeout", { tool: "echo" });
  const write = fact("tool_timeout", { tool: "write_file" });
  const first = releaseFor(createReleaseLedger(TURN), beat(1, [echo, write]));
  // 别的工具成功：两个计数都留着。
  const otherSucceeded = releaseFor(first.ledger, beat(2, [], ["other"]));

  assert.deepEqual(
    Object.values(otherSucceeded.ledger.records).map((record) => record.occurrences).sort(),
    [1, 1],
  );
  // echo 自己成功：它的计数被清掉，write_file 的不动。
  const echoSucceeded = releaseFor(first.ledger, beat(2, [], ["echo"]));
  const kept = Object.values(echoSucceeded.ledger.records);

  assert.equal(kept.length, 1);
  assert.equal(kept[0]?.fact.tool, "write_file");
});

test("a beat with a failure and a success still counts the failure", () => {
  const repeated = fact("tool_timeout");
  const { decisions } = tick([
    beat(1, [repeated]),
    beat(2, [repeated], ["echo"]),
  ]);

  // 同一工具成功**同时**同一工具失败：清空发生在计数之前，所以这一拍是新的一次
  // 计数，不是第二拍。这一条钉住的是 `recordFacts` 里两次操作的先后。
  assert.deepEqual(decisions, ["hold:not_repeated", "hold:not_repeated"]);
});

test("another turn's report is not this ledger's business", () => {
  const ledger = createReleaseLedger("trn-a");
  const result = releaseFor(ledger, { turnId: "trn-b", beat: 1, failures: [fact("x")], succeededTools: [] });

  assert.equal(result.decision.kind, "idle");

  if (result.decision.kind !== "idle") {
    return;
  }

  assert.equal(result.decision.reason, "wrong_turn");
  // 另一个 turn 的上报连一个字节都不该折进来。
  assert.deepEqual(result.ledger, ledger);
});

test("the containment code list is the one the adapter actually denies with", async () => {
  // 学习层不得 import adapters（`io-boundary.test.ts`），所以这份表是按值抄的。
  // 抄本的唯一风险是漂移，所以这里直接读原件、要求两个集合相等——一个按值副本
  // 只有在有人**同时**改了原件的情况下才会红，而那正是不该发生的事。
  const source = await readFile(
    path.join(process.cwd(), "src", "internal", "adapters", "tools", "shared", "workspace.ts"),
    "utf8",
  );
  const block = /export type PathDenyCode =([\s\S]*?);/.exec(source);

  assert.notEqual(block, null, "PathDenyCode must still be declared as a union of literals");

  if (block === null || block[1] === undefined) {
    return;
  }

  const declared = [...block[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1] ?? "");

  assert.deepEqual([...declared].sort(), [...CONTAINMENT_FAILURE_CODES].sort());
});
