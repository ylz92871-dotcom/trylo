import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  GATE_REFUSAL_CODES,
  admitCard,
  type GateContext,
  type GateRefusalCode,
} from "./gate.js";
import { MAX_CARD_CHARS, type MethodRelease } from "./contracts.js";
import { emptyVocabulary } from "./vocabulary.js";

/**
 * 门的十条杠，一条拒绝路径一个夹具（`testdata/method-learning/gate/**`）。
 *
 * 夹具是**文件**而不是内联字符串，因为这里要证明的东西是「模型真的会这么写」：
 * 一段在代码里拼出来的超长 hint 证明不了模型会写长的，而一个被读进来的文件至少
 * 让这段文本有了独立的形状。
 *
 * 这里同时钉住两件门**不做**的事：
 *
 *  - 拒绝之后没有第二次机会——`admitCard` 只回一个码，调用方拿不到一张被修过的
 *    卡（门不编辑）；
 *  - 「读不出码」与「读得出但不合格」是两回事，所以 10 条杠的拒绝码两两不同，
 *    而夹具集合与 `GATE_REFUSAL_CODES` 恰好一一对应。
 */

const fixtureDir = path.join(process.cwd(), "testdata", "method-learning", "gate");

/** `card_too_large` 唯一的超帽来源：工具名列表（其余字段都有更小的帽）。 */
const MANY_TOOLS: ReadonlyArray<string> = [
  "mcp__workspace__read_text_file",
  "mcp__workspace__write_text_file",
  "mcp__workspace__list_directory",
  "mcp__workspace__search_in_files",
  "mcp__workspace__move_path_entry",
  "mcp__workspace__delete_path_entry",
  "mcp__browser__navigate_to_url",
  "mcp__browser__capture_page_shot",
  "mcp__browser__click_element_by_text",
  "mcp__browser__type_into_field_named",
  "mcp__repo__stage_all_changes",
  "mcp__repo__commit_with_message",
  "mcp__repo__open_draft_request",
  "mcp__repo__list_open_requests",
  "mcp__shell__run_command_line",
  "mcp__shell__read_environment_var",
  "mcp__http__fetch_json_document",
  "mcp__http__post_json_document",
  "mcp__notes__append_note_entry",
  "mcp__notes__search_note_entries",
  "mcp__clock__read_current_time",
  "mcp__clock__list_time_zones",
  "mcp__quota__read_remaining_budget",
  "mcp__quota__request_more_budget",
];

const RELEASE: MethodRelease = {
  releaseId: "rel-1",
  turnId: "turn-1",
  beat: 2,
  reason: "containment",
  tool: "write_file",
  code: "path_outside_workspace",
  fingerprint: "0123456789abcdef",
  repeats: 2,
  model: "default",
  slotChars: 800,
  slotCards: 3,
};

const CONTEXT: GateContext = {
  vocabulary: emptyVocabulary(),
  toolNames: ["write_file", "read_file", ...MANY_TOOLS],
  release: RELEASE,
};

/** 夹具文件名 → 期望的裁决。admitted 那一条是唯一的非拒绝。 */
const EXPECTED: Readonly<Record<string, GateRefusalCode | "admitted">> = {
  "card_not_json.txt": "card_not_json",
  "card_shape_invalid.txt": "card_shape_invalid",
  "card_hint_invalid.txt": "card_hint_invalid",
  "card_hint_too_long.txt": "card_hint_too_long",
  "card_label_not_in_vocabulary.txt": "card_label_not_in_vocabulary",
  "card_label_over_cap.txt": "card_label_over_cap",
  "card_family_not_in_closed_set.txt": "card_family_not_in_closed_set",
  "card_applies_when_invalid.txt": "card_applies_when_invalid",
  "card_unknown_tool.txt": "card_unknown_tool",
  "card_forbidden_word.txt": "card_forbidden_word",
  "card_hook_invalid.txt": "card_hook_invalid",
  "card_too_large.txt": "card_too_large",
  "admitted.txt": "admitted",
};

test("every refusal bar has exactly one fixture, and nothing is left uncovered", async () => {
  const files = (await readdir(fixtureDir)).sort();
  assert.deepEqual(files, Object.keys(EXPECTED).sort());
  const covered = new Set(files.map((file) => EXPECTED[file]));
  for (const code of GATE_REFUSAL_CODES) {
    assert.equal(covered.has(code), true, `no fixture refuses with ${code}`);
  }
});

test("each fixture is refused with its own code, and the admitted one is admitted", async () => {
  for (const [file, expected] of Object.entries(EXPECTED)) {
    const text = await readFile(path.join(fixtureDir, file), "utf8");
    const verdict = admitCard(text, CONTEXT);
    assert.equal(verdict.kind, expected === "admitted" ? "admitted" : "refused", file);
    if (expected !== "admitted" && verdict.kind === "refused") {
      assert.equal(verdict.code, expected, file);
    }
  }
});

test("the admitted card carries the hypothesis, the scope and the release it came from", async () => {
  const text = await readFile(path.join(fixtureDir, "admitted.txt"), "utf8");
  const verdict = admitCard(text, CONTEXT);

  assert.equal(verdict.kind, "admitted");

  if (verdict.kind !== "admitted") {
    return;
  }

  assert.equal(verdict.card.hint, "Keep every path inside the workspace root.");
  assert.deepEqual(verdict.card.appliesWhen, {
    tools: ["write_file"],
    failureFamily: "containment",
  });
  assert.deepEqual(verdict.card.labels, ["containment"]);
  assert.deepEqual(verdict.card.lineage.createdFrom, {
    turnId: "turn-1",
    beat: 2,
    reason: "containment",
  });
  assert.equal(verdict.card.lineage.parentVersionId, undefined);
  // 钩子只活一拍，所以它不在卡里，而在裁决上。
  assert.deepEqual(verdict.hook, {
    labels: ["containment"],
    need: "did a write land outside the root?",
  });
  // 申请追加的那一个词当拍即入词表，否则模型下一次仍会用到它。
  assert.deepEqual(verdict.additions, [{ id: "path_scope", gloss: "路径必须落在工作区里" }]);
});

test("the gate does not edit: a refused card yields no card at all", async () => {
  const text = await readFile(path.join(fixtureDir, "card_hint_too_long.txt"), "utf8");
  const verdict = admitCard(text, CONTEXT);
  assert.equal(verdict.kind, "refused");
  assert.deepEqual(Object.keys(verdict).sort(), ["code", "kind"]);
});

test("the oversized fixture is refused for size and for nothing else", () => {
  // 同一副形状，只把工具名列表从二十四个缩到一个：一个被拒一个被收，所以拒绝
  // 的原因只可能是字符总量。若哪天它改从别的杠上被拒，这条用例会红。
  const shape = (tools: ReadonlyArray<string>): string =>
    JSON.stringify({
      hint: "x".repeat(200),
      labels: ["containment"],
      appliesWhen: { tools },
    });
  const big = shape(MANY_TOOLS);

  assert.equal(big.length > MAX_CARD_CHARS, true, `fixture text is only ${big.length} chars`);
  assert.deepEqual(admitCard(big, CONTEXT), { kind: "refused", code: "card_too_large" });
  assert.equal(admitCard(shape(["write_file"]), CONTEXT).kind, "admitted");
});
