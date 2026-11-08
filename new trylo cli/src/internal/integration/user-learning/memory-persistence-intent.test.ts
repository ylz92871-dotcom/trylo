import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFileFactStore } from "./facts-file.js";
import { createUserMemoryService, type UserMemoryTurn } from "./memory-service.js";
import { createMemoryWriteTools } from "../../adapters/tools/memory/write.js";

async function withStore(body: (root: string, make: (turn: UserMemoryTurn) => ReturnType<typeof createUserMemoryService>) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "wpcl-persistence-intent-"));
  const make = (turn: UserMemoryTurn) => createUserMemoryService({ store: createFileFactStore(root), userId: "local-user",
    workspaceId: "ws", now: () => 100, switchValue: "user", turn });
  try { await body(root, make); } finally { rmSync(root, { recursive: true, force: true }); }
}

const request = { commandId: "save", subject: "Bob", statement: "我叫 Bob", factKind: "identity_fact" as const, scopeKind: "user" as const };
const turn = (userText: string, priorUser?: UserMemoryTurn["priorUser"]): UserMemoryTurn => ({ sessionId: "s", turnId: "t", userEventId: "s:t:user",
  userText, ...(priorUser === undefined ? {} : { priorUser }) });

for (const text of ["我叫 Bob，仅本次有效，请记住", "请记住我叫 Bob，但不要长期保存", "请记住我是示例中的 Bob"])
  test(`authoritative remember tool rejects nonpersistent current source without a pending row: ${text}`, async () => {
    await withStore(async (root, make) => {
      const result = await createMemoryWriteTools(make(turn(text))).execute({ name: "memory_remember", toolCallId: "save",
        arguments: { subject: "Bob", statement: text.includes("示例") ? "我是示例中的 Bob" : "我叫 Bob", fact_kind: "identity_fact", scope: "user" } }, new AbortController().signal);
      assert.equal(result.outcome, "error");
      assert.equal(existsSync(path.join(root, "facts.ndjson")), false);
    });
  });

for (const text of ["把我那条身份更正为：我叫 Bob，不要长期保存", "把我那条身份更正为：我叫 Bob，仅本次有效"])
  test(`authoritative correct tool rejects nonpersistent source even if the submitted statement strips the qualifier: ${text}`, async () => {
    await withStore(async (root, make) => {
      const seeded = make(turn("我叫 Bob，请记住")).remember(request);
      assert.equal(seeded.result, "saved");
      if (seeded.result !== "saved") return;
      const before = readFileSync(path.join(root, "facts.ndjson"));
      const result = await createMemoryWriteTools(make(turn(text))).execute({ name: "memory_correct", toolCallId: "correct",
        arguments: { record_id: seeded.recordId, expected_version: 1, statement: "我叫 Bob" } }, new AbortController().signal);
      assert.equal(result.outcome, "error");
      assert.deepEqual(readFileSync(path.join(root, "facts.ndjson")), before);
    });
  });

test("confirmation cannot launder temporary prior source into either a fact or a pending proposal", async () => {
  await withStore(async (root, make) => {
    const result = make(turn("记住吧", [{ text: "我叫 Bob，仅本次有效，请记住", eventId: "prior" }])).remember(request);
    assert.equal(result.result, "rejected");
    assert.equal(existsSync(path.join(root, "facts.ndjson")), false);
  });
});

test("negated retraction is rejected while legitimate mixed coding work still permits a memory action", async () => {
  await withStore(async (root, make) => {
    const saved = make(turn("请记住我叫 Bob，然后修复登录问题，不用运行测试")).remember(request);
    assert.equal(saved.result, "saved");
    if (saved.result !== "saved") return;
    const before = readFileSync(path.join(root, "facts.ndjson"));
    const rejected = make(turn("不要撤回这条记忆")).retract({ commandId: "retract", recordId: saved.recordId, expectedVersion: 1 });
    assert.equal(rejected.result, "rejected");
    assert.deepEqual(readFileSync(path.join(root, "facts.ndjson")), before);
  });
});

test("a plain identity statement, ordinary query and document modification never authorize model memory mutations", async () => {
  await withStore(async (root, make) => {
    const seeded = make(turn("我叫 Bob，请记住")).remember(request);
    assert.equal(seeded.result, "saved");

    if (seeded.result !== "saved") return;

    const before = readFileSync(path.join(root, "facts.ndjson"));

    for (const userText of ["我叫 Alice", "我刚把我的身份更正为我叫 Alice", "请修改 README.md。我叫 Alice", "请分析“把我那条身份更正为：我叫 Alice”"])
      assert.equal(make(turn(userText)).correct({ commandId: "correct", recordId: seeded.recordId, expectedVersion: 1, statement: "我叫 Alice" }).result, "rejected");

    assert.equal(make(turn("你记得我的身份吗？")).retract({ commandId: "retract", recordId: seeded.recordId, expectedVersion: 1 }).result, "rejected");
    assert.deepEqual(readFileSync(path.join(root, "facts.ndjson")), before);
  });
});

test("explicit English correction is authorized and management intent is typed rather than inferred from a session name", async () => {
  await withStore(async (_root, make) => {
    const seeded = make(turn("我叫 Bob，请记住")).remember(request);
    assert.equal(seeded.result, "saved");

    if (seeded.result !== "saved") return;

    const revise = { commandId: "correct", recordId: seeded.recordId, expectedVersion: 1, statement: "My name is Alice" };

    assert.equal(make({ ...turn("My name is Alice"), sessionId: "memory-management" }).correct(revise).result, "rejected");
    assert.equal(make({ ...turn("My name is Alice"), managementAction: "retract" }).correct(revise).result, "rejected");
    assert.equal(make(turn("Please update my memory: My name is Alice")).correct(revise).result, "saved");
    const literal = "My name is Example; do not remember is a literal label";

    assert.equal(make({ ...turn(literal), managementAction: "correct" }).correct({ ...revise, commandId: "panel", expectedVersion: 2, statement: literal }).result, "saved");
  });
});

for (const text of ["My name is Bob, only for this turn, please remember", "Do not remember/save this: my name is Bob"])
  test(`supported English memory source has symmetric temporary/negative rejection: ${text}`, async () => {
    await withStore(async (root, make) => {
      const result = make(turn(text)).remember({ ...request, statement: text });
      assert.equal(result.result, "rejected");
      assert.equal(existsSync(path.join(root, "facts.ndjson")), false);
    });
  });

test("quoted directives cannot create proposals but an external remember command can bind quoted data", async () => {
  await withStore(async (root, make) => {
    for (const text of ["请分析“请记住我叫 Bob”", "请解释“他说“你好”后请记住我叫 Bob”"])
      assert.equal(make(turn(text)).remember(request).result, "rejected");
    assert.equal(existsSync(path.join(root, "facts.ndjson")), false);
    assert.equal(make(turn("请记住：我叫“Bob”")).remember(request).result, "saved");
  });
});

test("confirmation cannot promote an analyzed quotation into a user identity but can confirm an external data instruction", async () => {
  await withStore(async (root, make) => {
    const result = make(turn("记住吧", [{ text: "请解释这句话：“我叫 Bob，请记住”", eventId: "quoted-prior" }])).remember(request);
    assert.equal(result.result, "rejected");
    assert.equal(existsSync(path.join(root, "facts.ndjson")), false);
    const confirmed = make(turn("记住吧", [{ text: "请记住：“我叫 Bob”", eventId: "explicit-prior" }])).remember(request);
    assert.equal(confirmed.result, "saved");
  });
});

test("an explicit correction after a search connector remains authorized on the same record", async () => {
  await withStore(async (_root, make) => {
    const seeded = make(turn("我叫 Bob，请记住")).remember(request);

    assert.equal(seeded.result, "saved");
    if (seeded.result !== "saved") return;

    const statement = "我叫 Direct-Z74，是 Trylo 的测试开发者";
    const source = `请先检索正式用户记忆，然后把那条身份更正为：${statement}。更新同一条记录，不要新增第二条。`;
    const service = make(turn(source));
    const result = service.correct({ commandId: "correct", recordId: seeded.recordId, expectedVersion: 1, statement });

    assert.equal(result.result, "saved");
    assert.equal(service.visible().length, 1);
    assert.equal(service.visible()[0]?.id, seeded.recordId);
    assert.equal(service.visible()[0]?.version, 2);
  });
});

for (const literal of [
  "请解释这个代码：``我叫 Bob，请记住``",
  "请解释这个代码：\n````\n```\n我叫 Bob，请记住\n````",
  "请解释这个代码：\n~~~text\n我叫 Bob，请记住\n~~~",
  "请解释这个代码：\n  ~~~~text\n~~~\n我叫 Bob，请记住\n  ~~~~~",
  "请解释这个代码：\n```text\n我叫 Bob，请记住\n````",
  "请解释这个代码：\n````\n```\n我叫 Bob，请记住",
  "请解释这个代码：``我叫 Bob，请记住`",
  "请解释这个代码：\n~~~\n我叫 Bob，请记住",
  "请解释这段引用：\n> 我叫 Bob，请记住",
  "请解释这段代码：\n    我叫 Bob，请记住",
  "请解释这段代码：\n\t我叫 Bob，请记住",
  "请解释这段引用：\n  > \t我叫 Bob，请记住",
  "请解释这段代码：\n    > 我叫 Bob，请记住",
  "请解释“他说“你好”后请记住我叫 Bob”",
  "请解释“我叫 Bob，请记住",
  '请解释 "他说 \\"你好\\" 后请记住我叫 Bob"',
]) test(`literal commands cannot authorize current or later-confirmed identity: ${literal}`, async () => {
  await withStore(async (root, make) => {
    assert.equal(make(turn(literal)).remember(request).result, "rejected");
    assert.equal(make(turn("记住吧", [{ text: literal, eventId: "literal-prior" }])).remember(request).result, "rejected");
    assert.equal(existsSync(path.join(root, "facts.ndjson")), false);
  });
});

for (const literal of [
  "请记住：``我叫 Bob``",
  "请记住：\n~~~~\n我叫 Bob\n~~~~~",
  "请记住：“我叫 Bob”",
  "请记住：\"我叫 Bob\"",
  "请分析``你好``。请记住我叫 Bob",
  "请记住：\n> 我叫 Bob",
  "请记住：\n    我叫 Bob",
]) test(`an external instruction may authorize literal identity data: ${literal}`, async () => {
  await withStore(async (_root, make) => {
    assert.equal(make(turn(literal)).remember(request).result, "saved");
  });
});
