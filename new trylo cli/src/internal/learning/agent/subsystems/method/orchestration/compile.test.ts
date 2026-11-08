import assert from "node:assert/strict";
import test from "node:test";
import { withUse, variantOf } from "../assets/archive.js";
import {
  DEFAULT_METHOD_GRANT,
  MAX_CARD_CHARS,
  cardLengthOf,
  type AppliesWhen,
  type MethodCard,
  type VariantRecord,
} from "../domain/contracts.js";
import {
  compileSlot,
  slotCharsOf,
  slotLinesOf,
  type CompileRequest,
} from "./compile.js";

/**
 * 上场编译（合同 T9）。
 *
 * 「上场是编译，不是检索」这件事在这里是可测的：没有 provider、没有磁盘、没有
 * 随机——同一份档编译两次必然得到同一个槽，而三道硬顶（张数、字符、单卡）各自
 * 都有一条用例。反方那一栏（「超预算上场」「空钩子导致全库上场」）分别由
 * 「谁先到谁封」与「没有钩子就不因标签过滤」两条钉住。
 */

const LINEAGE = { createdFrom: { turnId: "trn-c", beat: 1, reason: "containment" as const } };

function cardOf(hint: string, appliesWhen: AppliesWhen = {}, family?: MethodCard["family"]): MethodCard {
  return {
    schemaVersion: 1,
    hint,
    appliesWhen,
    labels: ["containment"],
    ...(family === undefined ? {} : { family }),
    lineage: LINEAGE,
  };
}

function variant(
  versionId: string,
  hint: string,
  appliesWhen: AppliesWhen = {},
  accounting: ReadonlyArray<"supports" | "counterexamples"> = [],
): VariantRecord {
  return variantOf({
    versionId,
    proposalId: `prop-${versionId}`,
    card: cardOf(hint, appliesWhen),
    accounting,
  });
}

/** 上场次数：用真助手折，而不是手搓 ledger。 */
function used(
  archive: ReadonlyArray<VariantRecord>,
  versionId: string,
  times: number,
): ReadonlyArray<VariantRecord> {
  let next: ReadonlyArray<VariantRecord> = archive;
  for (let index = 0; index < times; index += 1) {
    next = withUse(next, versionId, index + 1);
  }
  return next;
}

function request(overrides: Partial<CompileRequest> = {}): CompileRequest {
  return {
    archive: [],
    toolNames: ["echo", "write_file"],
    currentFamily: undefined,
    hookLabels: undefined,
    slotChars: 800,
    slotCards: 3,
    ...overrides,
  };
}

test("an empty or unmatched archive compiles an empty slot, not an error", () => {
  assert.deepEqual(compileSlot(request()).hints, []);
  // 工具对不上：卡是关于 write_file 的，而本轮目录里没有它。
  const mismatch = compileSlot(
    request({ archive: [variant("v1", "always quote the path", { tools: ["write_file"] })], toolNames: ["echo"] }),
  );

  assert.deepEqual(mismatch.hints, []);
  assert.equal(mismatch.chars, 0);
});

test("a card only applies in the failure family it names", () => {
  const archive = [
    variant("v1", "check the root before writing", { failureFamily: "containment" }),
  ];

  assert.deepEqual(compileSlot(request({ archive })).hints, []);
  assert.deepEqual(compileSlot(request({ archive, currentFamily: "containment" })).hints, [
    "check the root before writing",
  ]);
  assert.deepEqual(compileSlot(request({ archive, currentFamily: "budget" })).hints, []);
});

test("the previous beat's hook filters candidates, and no hook filters nothing", () => {
  const archive = [variant("v1", "prefer relative paths", { labels: ["containment"] })];

  // 没有钩子：不因标签过滤。「没有依据就什么都不选」会把一次普通的注入变成空槽。
  assert.deepEqual(compileSlot(request({ archive })).hints, ["prefer relative paths"]);
  assert.deepEqual(
    compileSlot(request({ archive, hookLabels: ["containment"] })).hints,
    ["prefer relative paths"],
  );
  assert.deepEqual(compileSlot(request({ archive, hookLabels: ["budget"] })).hints, []);
});

test("slot A is the most specific card, and it sits first", () => {
  // `failureFamily` 是「只在正撞着这一族时适用」，所以这条用例必须也把当前族
  // 说成 containment，否则最窄的那张根本进不了候选，比的就不是具体度了。
  const narrow = variant("narrow", "keep the write inside the root", {
    tools: ["echo"],
    failureFamily: "containment",
  });
  const wide = variant("wide", "mention the tool name", { labels: ["repeat_call"] });
  const compiled = compileSlot(
    request({ archive: [wide, narrow], currentFamily: "containment" }),
  );

  assert.deepEqual(compiled.hints[0], "keep the write inside the root");
  assert.deepEqual(
    compiled.variants.map((item) => item.versionId),
    ["narrow", "wide"],
  );
});

test("slot B orders by uses, then by supports", () => {
  const base = [
    variant("a", "alpha"),
    variant("b", "beta"),
    variant("c", "gamma"),
  ];
  // 三张的具体度相同，所以槽 A 也用「次数」这一键取出。
  const byUses = used(used(used(base, "a", 3), "c", 2), "b", 1);

  assert.deepEqual(compileSlot(request({ archive: byUses })).hints, ["alpha", "gamma", "beta"]);

  const bySupports = [
    variant("x", "ex", {}, ["supports", "supports"]),
    variant("y", "why", {}, ["supports"]),
  ];

  assert.deepEqual(compileSlot(request({ archive: bySupports })).hints, ["ex", "why"]);
});

test("the card count is capped", () => {
  const archive = [variant("a", "alpha"), variant("b", "beta"), variant("c", "gamma")];
  const compiled = compileSlot(request({ archive, slotCards: 2 }));
  assert.equal(compiled.hints.length, 2);
  assert.equal(compiled.variants.length, 2);
});

test("the char budget stops at the first card that does not fit, and does not skip it", () => {
  // 两个字段都是为了拿到「最贴」的位置，且都恒真：`tools` 命中目录，`sameSession`
  // 不参与过滤。用 `failureFamily` 当第二个字段会让这张卡只在某一族里进候选，
  // 那测到的就是另一条规则了。
  const huge = variant("huge", "H".repeat(100), { tools: ["echo"], sameSession: true });
  const small = variant("small", "tiny");
  const budget = 20;

  // `huge` 是最贴的那一张，排在槽 A；它放不下，于是整个槽就到此为止——不会跳过
  // 它去试后面那张放得下的。跳过会让结果取决于后面有什么，而槽的顺序本身有含义。
  const stopped = compileSlot(request({ archive: [small, huge], slotChars: budget }));

  assert.deepEqual(stopped.hints, []);

  // 同一份预算，把放不下的那张拿掉，小的那张本来就装得下：上面那个空槽是「停
  // 在第一个放不下的」，不是「什么都装不下」。
  const fits = compileSlot(request({ archive: [small], slotChars: budget }));

  assert.deepEqual(fits.hints, ["tiny"]);
});

test("a card wider than the card cap is not packed even if the budget would allow it", () => {
  // 门已经按整卡字符拒过超帽的卡，但档是共享的：读进来的一律再量一次。
  const fat: MethodCard = cardOf("F".repeat(120), {
    tools: Array.from({ length: 30 }, (_value, index) => `tool_${index}_${"x".repeat(30)}`),
  });

  assert.equal(cardLengthOf(fat) > MAX_CARD_CHARS, true, "fixture must exceed the card cap");
  const record = variantOf({ versionId: "fat", proposalId: "prop-fat", card: fat, accounting: [] });
  const compiled = compileSlot(request({ archive: [record], slotChars: 8_000 }));

  assert.deepEqual(compiled.hints, []);
});

test("the charged characters are the rendered lines, and compiling twice agrees", () => {
  const archive = [variant("a", "alpha"), variant("b", "beta")];
  const first = compileSlot(request({ archive }));
  const second = compileSlot(request({ archive }));

  assert.deepEqual(first, second);
  // ME0：计费的量就是**渲染出来的那些行**——每行带着这一版的短引用。这条断言
  // 把「渲染」与「计费」钉在同一处（`compile.ts::slotLineFor`），于是谁改了
  // 渲染而忘了改计费，红在这里，而不是在提示词超预算之后。
  assert.equal(
    first.chars,
    slotLinesOf(first.hints).reduce((total, line) => total + line.length, 0),
  );
  assert.equal(first.chars, slotCharsOf(first.hints));
  assert.equal(slotCharsOf([]), 0);
});

test("T9: the default grant is a char budget first, and a card count only as a fallback", () => {
  // 默认额度是**已拍**的那两个数（`§8.3`，2026-09-16）：800 / 3 那一版把张数当
  // 主顶，会让一张写得长的卡把整槽挤空，而预算本来就是按字符算的。
  assert.deepEqual(
    { slotChars: DEFAULT_METHOD_GRANT.slotChars, slotCards: DEFAULT_METHOD_GRANT.slotCards },
    { slotChars: 1200, slotCards: 8 },
  );

  // 预算先封、张数只是兜底：八张写满 hint（200 = `MAX_HINT_CHARS`）的卡装不进
  // 1200 字符，所以装出来的张数**少于**兜底值——张数是结果，不是目标。
  const wide = Array.from({ length: 8 }, (_value, index) => variant(`v${index}`, "x".repeat(200)));
  const compiled = compileSlot(
    request({
      archive: wide,
      slotChars: DEFAULT_METHOD_GRANT.slotChars,
      slotCards: DEFAULT_METHOD_GRANT.slotCards,
    }),
  );

  assert.equal(compiled.hints.length < DEFAULT_METHOD_GRANT.slotCards, true);
  assert.equal(compiled.chars <= DEFAULT_METHOD_GRANT.slotChars, true);

  // 而 `0 张` 是正常结果：空档不报错，也不为了凑够张数去超预算。
  assert.deepEqual(compileSlot(request()).hints, []);
});
