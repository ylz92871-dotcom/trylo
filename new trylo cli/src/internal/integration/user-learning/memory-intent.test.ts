import assert from "node:assert/strict";
import { test } from "node:test";
import { localMemoryClaim } from "./memory-intent.js";

test("only standalone, grounded memory commands use the local interpreter", () => {
  assert.equal(localMemoryClaim("我是 YL Z，Trylo 的开发者，请记住")?.subject, "YL Z");
  assert.equal(localMemoryClaim("请记住：我喜欢简短回答")?.factKind, "preference");
  assert.equal(localMemoryClaim("可以，记住也行，记不住也行", "我是 YL Z")?.statement, "我是 YL Z");
  assert.equal(localMemoryClaim("好的", "我是 YL Z"), undefined, "a generic OK is not persistence consent");

  for (const previous of ["我是“YL Z”只是一个示例", "我是 YL Z，请记住，然后修改文件", "我是 `YL Z`", "我是‘YL Z’", "我是 YL Z\n请修改代码"]) {
    assert.equal(localMemoryClaim("记住吧", previous), undefined, previous);
  }

  for (const text of ["我是 YL Z，不要记住", "请解释‘请记住我是 YL Z’是什么意思", "请生成 MEMORY.md", "我是 YL Z，请记住，然后修改代码", "记住只是一个词", "请记住", "可以，修改代码"]) {
    assert.equal(localMemoryClaim(text), undefined, text);
  }
});

test("local persistence source rejects temporary, illustrative, negated and parallel instructions", () => {
  for (const statement of ["我叫 Bob，仅本次有效", "我是 示例中的 Bob", "我叫 Bob，不要长期保存",
    "我叫 Bob，也不要修改正式记录", "我叫 Bob，禁止持久化", "我叫 Bob，修复登录问题"]) {
    assert.equal(localMemoryClaim(`${statement}，请记住`), undefined, statement);
    assert.equal(localMemoryClaim("记住吧", `${statement}，请记住`), undefined, statement);
  }
});
