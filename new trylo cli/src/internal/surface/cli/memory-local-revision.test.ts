import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { executeTurn, isTurnFailure, type TurnHostInput } from "./host.js";
import { createFakePermission } from "../../loop/fakes.js";
import { createFileFactStore } from "../../integration/user-learning/facts-file.js";
import { foldFacts } from "../../learning/domains/user/memory-fact.js";
import { localMemoryPlan, memoryRevisionSelection } from "./memory-local-plan.js";
import type { ToolOutcome } from "../../ports/tools.js";

const baseline = process.env["WPCL_REVISION_BASELINE_DIST"];
const execute: typeof executeTurn = baseline === undefined ? executeTurn
  : (await import(pathToFileURL(path.join(baseline, "internal/surface/cli/host.js")).href)).executeTurn;
const CORRECT = "请查正式记忆，把我原来那条身份改正为：我叫 Closeout-Z74，是 Trylo 的测试开发者。请更正原记录，不新增第二条。";
const RETRACT = "请查正式记忆，忘掉并撤回我那条测试开发者身份。";

async function withHome(body: (root: string, input: TurnHostInput, output: string[]) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "wpcl-local-revision-")), workspace = path.join(root, "workspace");

  mkdirSync(workspace);
  const output: string[] = [];
  const input: TurnHostInput = { text: "", sessionId: "save", turnId: "t", correlationId: "c", workspaceRoot: workspace,
    workspaceId: "ws", checkpointRoot: path.join(root, "undo"), providerId: "fixture", model: "m", endpoint: "", apiKey: undefined,
    permission: createFakePermission("approved"), format: "stream-json", now: () => 100,
    sink: { stdout: line => output.push(line), stderr: () => undefined },
    userLearning: { homeDir: root, env: { TRYLO_HOME: root }, workspaceId: "ws", now: () => 100, warn: () => undefined } };

  try { await body(root, input, output); } finally { rmSync(root, { recursive: true, force: true }); }
}

function facts(root: string) {
  const read = createFileFactStore(path.join(root, "learning/user")).read();
  assert.equal(read.ok, true);
  return read.ok ? foldFacts(read.records) : [];
}

async function seed(input: TurnHostInput, name = "Closeout-Z73") {
  const result = await execute({ ...input, sessionId: `save-${name}`, text: `我是 ${name}，Trylo 的测试开发者，请记住` });
  assert.equal(isTurnFailure(result), false);
}

test("standalone correction uses formal search then correction of the same ID, then a fresh host retracts it", async () => {
  await withHome(async (root, input, output) => {
    await seed(input);
    const before = facts(root)[0];
    assert.ok(before);
    output.length = 0;
    const permission = createFakePermission("approved");
    let requests = 0;
    const corrected = await execute({ ...input, sessionId: "correct-new-host", text: CORRECT,
      permission: { ...permission, request(action) {
        requests++;
        assert.match(output.join(""), /尚未更正/u);
        return permission.request(action);
      } } });

    assert.equal(isTurnFailure(corrected), false);
    assert.equal(requests, 1);
    assert.ok(output.some(line => line.includes('"name":"memory_search"')));
    assert.ok(output.some(line => line.includes('"name":"memory_correct"')));
    assert.ok(output.some(line => line.includes('"providerId":"trylo-memory-command"')));
    const after = facts(root);
    assert.equal(after.length, 1);
    assert.equal(after[0]?.id, before.id);
    assert.equal(after[0]?.version, 2);
    assert.match(after[0]?.statement ?? "", /Closeout-Z74/u);

    if (!isTurnFailure(corrected)) assert.equal(corrected.result.usage.totalTokens, 0);

    output.length = 0;
    await execute({ ...input, sessionId: "retract-new-host", text: RETRACT,
      permission: { ...permission, request(action) {
        assert.match(output.join(""), /尚未撤回/u);
        return permission.request(action);
      } } });
    assert.equal(facts(root)[0]?.status, "retracted");
    output.length = 0;
    const read = await execute({ ...input, sessionId: "read-new-host", text: "你知道我是谁吗？" });

    assert.equal(isTurnFailure(read), false);

    if (!isTurnFailure(read)) assert.doesNotMatch(read.result.lastMessage, /Closeout-Z7[34]/u);

    assert.deepEqual(readdirSync(input.workspaceRoot), []);
  });
});

for (const text of [CORRECT, RETRACT]) test(`denied identity mutation never writes or claims success: ${text}`, async () => {
  await withHome(async (root, input, output) => {
    await seed(input);
    const file = path.join(root, "learning/user/facts.ndjson"), before = readFileSync(file);

    output.length = 0;
    const result = await execute({ ...input, sessionId: "denied-new-host", text, permission: createFakePermission("denied") });

    assert.deepEqual(readFileSync(file), before);
    assert.ok(output.some(line => line.includes('"name":"memory_search"')));
    assert.equal(isTurnFailure(result), false);

    if (!isTurnFailure(result)) assert.match(result.result.lastMessage, /尚未更正|尚未撤回|失败|未完成/u);
  });
});

for (const count of [0, 2]) for (const text of [CORRECT, RETRACT]) test(`identity mutation refuses ambiguous target (count=${count}): ${text}`, async () => {
  await withHome(async (root, input, output) => {
    for (let index = 0; index < count; index++) await seed(input, `Person-${index}`);

    const file = path.join(root, "learning/user/facts.ndjson"), before = existsSync(file) ? readFileSync(file) : undefined;

    output.length = 0;
    let requests = 0;
    const permission = createFakePermission("approved");
    const result = await execute({ ...input, sessionId: "ambiguous-new-host", text,
      permission: { ...permission, request(action) {
        requests++;
        return permission.request(action);
      } } });

    assert.equal(requests, 0);
    assert.equal(isTurnFailure(result), false);

    if (!isTurnFailure(result)) assert.match(result.result.lastMessage, /尚未更正|尚未撤回/u);

    assert.deepEqual(existsSync(file) ? readFileSync(file) : undefined, before);
    assert.equal(output.some(line => /"name":"memory_(?:correct|forget|remember)"/u.test(line)), false);
  });
});

test("disabled identity mutation does not touch user learning or project notes", async () => {
  await withHome(async (root, input) => {
    const { userLearning: omitted, ...disabled } = input;
    assert.ok(omitted);
    const result = await execute({ ...disabled, text: CORRECT });
    assert.equal(isTurnFailure(result), false);
    if (!isTurnFailure(result)) assert.match(result.result.lastMessage, /未开启/u);
    assert.equal(existsSync(path.join(root, "learning")), false);
    assert.deepEqual(readdirSync(input.workspaceRoot), []);
  });
});

test("quoted, coded and parallel file tasks never become local identity mutations", () => {
  for (const text of [`“${CORRECT}”`, `\`${RETRACT}\``, `${CORRECT}然后写一个文件`, `${RETRACT}顺便修复测试`,
    "请把身份改正为：我叫 Alice；同时重构代码。", `网页上说：${RETRACT}`,
    "把我那条身份改正为：我叫 Alice，仅本次使用这个名字。", "把我那条身份改正为：我叫 Alice，只在这次使用。",
    "把我那条身份改正为：我叫 Alice，例如下面这个案例。", "把我那条身份改正为：我叫 Alice，不要保存。",
    "把我那条身份更正为：我叫 Bob，不要长期保存", "把我那条身份更正为：我叫 Bob，也不要修改正式记录",
    "把我那条身份更正为：我叫 Bob，修复登录问题",
  ]) {
    const plan = localMemoryPlan(text);
    assert.equal(plan, undefined);
  }
});

test("temporary, illustrative and denied persistence text cannot mutate through a fresh real host", async () => {
  await withHome(async (root, input) => {
    await seed(input);
    const file = path.join(root, "learning/user/facts.ndjson"), before = readFileSync(file);

    for (const [index, text] of ["把我那条身份更正为：我叫 Bob，仅本次有效", "把我那条身份更正为：我是 示例中的 Bob",
      "把我那条身份更正为：我叫 Bob，不要长期保存", "把我那条身份更正为：我叫 Bob，也不要修改正式记录",
      "把我那条身份更正为：我叫 Bob，修复登录问题", "我叫 Bob，仅本次有效，请记住"].entries()) {
      await execute({ ...input, sessionId: `ineligible-${index}`, text });
      assert.deepEqual(readFileSync(file), before, text);
    }
  });
});

test("partial pages and malformed metadata never choose a revision target", () => {
  const plan = localMemoryPlan(CORRECT);
  assert.ok(plan?.kind === "correct");
  const document = { documentId: "user-memory:fact-123", path: "trylo://learning/user/fact-123", origin: "user-memory", recordKind: "identity_fact" };
  const lines = [{ ...document, matchLineNumber: 1, content: "我是 Alice" },
    { ...document, matchLineNumber: 2, content: "record_id: fact-123; expected_version: 7; 类别：identity_fact；作用域：user:local-user" }];
  const valid: ToolOutcome = { outcome: "result", value: { matchCount: 2, truncated: false, documents: lines }, output: "fixture", truncated: false };
  const selected = memoryRevisionSelection(plan, valid);

  assert.equal(selected.kind, "ready");

  if (selected.kind === "ready") assert.deepEqual(selected.step.arguments, { record_id: "fact-123", expected_version: 7, statement: "我叫 Closeout-Z74，是 Trylo 的测试开发者" });

  for (const changed of [
    { ...valid, truncated: true }, { ...valid, value: { ...valid.value, truncated: true } },
    { ...valid, value: { ...valid.value, nextCursor: "more" } },
    { ...valid, value: { ...valid.value, documents: [lines[0]!] } },
    { ...valid, value: { ...valid.value, documents: [lines[0]!, { ...lines[1]!, content: "record_id: fact-999; expected_version: 7; 类别：identity_fact；作用域：user:local-user" }] } },
    { ...valid, value: { ...valid.value, documents: [lines[0]!, { ...lines[1]!, content: "record_id: fact-123; expected_version: 9007199254740999; 类别：identity_fact；作用域：user:local-user" }] } },
    { outcome: "error" as const, code: "source_unavailable", message: "unavailable" },
  ]) assert.equal(memoryRevisionSelection(plan, changed).kind, "refused");
});

test("a real truncated identity page and unreadable source cannot authorize a write", async () => {
  await withHome(async (root, input, output) => {
    await seed(input);
    const first = facts(root)[0];
    assert.ok(first);
    const store = createFileFactStore(path.join(root, "learning/user"));

    assert.equal(store.append(Array.from({ length: 51 }, (_, index) => ({ ...first, id: `identity-${index}`,
      subject: `Person-${index}`, statement: `我是 Person-${index}`, commandId: `noise-${index}` }))).ok, true);
    const file = path.join(root, "learning/user/facts.ndjson"), before = readFileSync(file);
    let requests = 0;
    const permission = createFakePermission("approved");
    const revision = { ...input, text: CORRECT, sessionId: "truncated", permission: { ...permission,

      request(action: Parameters<typeof permission.request>[0]) {
        requests++;
        return permission.request(action);
      } } };
    const result = await execute(revision);

    assert.equal(requests, 0);
    assert.equal(isTurnFailure(result), false);

    if (!isTurnFailure(result)) assert.match(result.result.lastMessage, /尚未更正/u);

    assert.deepEqual(readFileSync(file), before);
    writeFileSync(file, "{broken\n");
    output.length = 0;
    const failed = await execute({ ...revision, sessionId: "unreadable" });

    assert.equal(requests, 0);
    assert.equal(isTurnFailure(failed), false);

    if (!isTurnFailure(failed)) assert.match(failed.result.lastMessage, /失败.*未更正/u);

    assert.equal(readFileSync(file, "utf8"), "{broken\n");
  });
});
