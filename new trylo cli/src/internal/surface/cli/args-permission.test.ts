import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "./args.js";
import { ASK_POLICIES, APPROVABLE_TOOL_NAMES } from "./permission-plan.js";
import { USAGE } from "./usage.js";

/**
 * B6 (an unknown tool name is a usage error, and it says which names exist) and
 * D8-a (the help text describes what the program does).
 *
 * The refusals are the point. A permission flag that is quietly ignored is
 * worse than one that does not exist: the person believes a boundary is in
 * place and it is not. So every malformed value here must come back as an
 * `error` — the shape the dispatcher turns into exit code 2 — and never as a
 * run with the flag dropped.
 */

function optionsOf(argv: ReadonlyArray<string>) {
  const parsed = parseArgs(argv);
  assert.equal(parsed.kind, "run", `expected a run, got ${parsed.kind}`);
  if (parsed.kind !== "run") {
    throw new Error("unreachable");
  }
  return parsed.options;
}

function errorOf(argv: ReadonlyArray<string>): { message: string; hint: string } {
  const parsed = parseArgs(argv);
  assert.equal(parsed.kind, "error", `expected a usage error, got ${parsed.kind}`);
  if (parsed.kind !== "error") {
    throw new Error("unreachable");
  }
  return { message: parsed.message, hint: parsed.hint };
}

test("B6: an unknown --allow-tools name is refused and the legal names are listed", () => {
  const { message, hint } = errorOf(["run", "hi", "--allow-tools", "nope"]);
  assert.match(message, /unknown tool nope/);
  for (const name of APPROVABLE_TOOL_NAMES) {
    assert.equal(message.includes(name), true, `${name} is a legal name but was not listed`);
  }
  assert.equal(hint.length > 0, true);
});

test("B6: the same refusal applies to --deny-tools, and it names only the unknown entry", () => {
  const { message } = errorOf(["run", "hi", "--deny-tools", "write_file,nope,other"]);
  assert.match(message, /unknown tool nope, other/);
});

test("B6: a list that parses resolves to exactly the names given", () => {
  const options = optionsOf(["run", "hi", "--allow-tools", "write_file, edit_file"]);
  assert.deepEqual(options.allowTools, ["write_file", "edit_file"]);
  const denied = optionsOf(["run", "hi", "--deny-tools=run_shell"]);
  assert.deepEqual(denied.denyTools, ["run_shell"]);
});

test("memory permission names survive both CLI allow and deny parsing", () => {
  const names = ["memory_remember", "memory_correct", "memory_forget"];
  assert.deepEqual(optionsOf(["run", "hi", "--allow-tools", names.join(",")]).allowTools, names);
  assert.deepEqual(optionsOf(["run", "hi", "--deny-tools", names.join(",")]).denyTools, names);
});

test("B6: an empty list is refused rather than read as 'no restriction'", () => {
  const { message } = errorOf(["run", "hi", "--allow-tools", " , "]);
  assert.match(message, /needs at least one tool name/);
});

test("B6: a missing value is refused, never silently swallowed", () => {
  for (const flag of ["--ask", "--allow-tools", "--deny-tools"]) {
    const { message } = errorOf(["run", "hi", flag]);
    assert.match(message, new RegExp(`option ${flag}`));
  }
});

test("D7: --ask accepts only the three policies, and says which", () => {
  for (const policy of ASK_POLICIES) {
    assert.equal(optionsOf(["run", "hi", "--ask", policy]).ask, policy);
  }

  const { message, hint } = errorOf(["run", "hi", "--ask", "sometimes"]);

  assert.match(message, /unknown --ask policy: sometimes/);

  for (const policy of ASK_POLICIES) {
    assert.equal(hint.includes(policy), true, `${policy} was not offered as a legal value`);
  }
});

test("D7: --allow-writes is still the sugar for --ask writes", () => {
  assert.equal(optionsOf(["run", "hi", "--allow-writes"]).allowWrites, true);
  assert.equal(optionsOf(["run", "hi"]).allowWrites, undefined);
  assert.equal(optionsOf(["run", "hi"]).ask, undefined);
});

test("D7: --allow-web is a presence flag with the same contract as --subagent", () => {
  assert.equal(optionsOf(["run", "hi", "--allow-web"]).allowWeb, true);
  assert.equal(optionsOf(["run", "hi"]).allowWeb, undefined);
  const { message, hint } = errorOf(["run", "hi", "--allow-web=false"]);

  assert.match(message, /--allow-web takes no value/);
  assert.match(hint, /the default is no web_fetch tool/);
  // `web_fetch` joined the approvable set, so naming it in --allow-tools parses.
  assert.deepEqual(optionsOf(["run", "hi", "--allow-web", "--allow-tools", "web_fetch"]).allowTools, [
    "web_fetch",
  ]);
});

test("D8-a: the help text describes the flags that exist, and refuses none that work", () => {
  for (const flag of ["--ask", "--allow-tools", "--deny-tools", "--allow-writes", "--allow-web"]) {
    assert.equal(USAGE.includes(flag), true, `${flag} is missing from the help text`);
  }

  // The help used to claim remote MCP was refused while `mcp add --url` worked.
  assert.equal(/--url[^\n]*refused/i.test(USAGE), false);
  assert.equal(USAGE.includes("--url <url>"), true);
  assert.match(USAGE, /--transport stdio\|http\|sse/);
});

test("D5: --allow-tools/--deny-tools accept MCP qualified names (mcp__server__tool)", () => {
  // 运行期工具名正是这个形状（mount.ts）；解析层用静态白名单拒掉它，
  // 非交互 MCP 工作流整体不可用。允许的是"语法合法的限定名"，
  // 存在性仍由运行期（挂载表）判定，这里不断言存在性。
  assert.deepEqual(optionsOf(["run", "hi", "--allow-tools", "mcp__echo__echo_text"]).allowTools, [
    "mcp__echo__echo_text",
  ]);
  assert.deepEqual(optionsOf(["run", "hi", "--deny-tools", "mcp__echo__echo_text"]).denyTools, [
    "mcp__echo__echo_text",
  ]);
  // 与内置名混写也不该拒。
  assert.deepEqual(optionsOf(["run", "hi", "--allow-tools", "write_file,mcp__echo__echo_text"]).allowTools, [
    "write_file",
    "mcp__echo__echo_text",
  ]);
});

test("D5: malformed MCP names are still refused, and the refusal names the MCP shape", () => {
  // tool 半段含分隔符的不是合法限定名（names.ts：拒绝而非转义）。
  const { message } = errorOf(["run", "hi", "--allow-tools", "mcp__bad__a__b"]);
  assert.match(message, /unknown tool mcp__bad__a__b/);
  // 拒绝信息必须点名 MCP 限定名形状，否则下一个 MCP 用户还是不知道该写什么。
  assert.match(message, /mcp__<server>__<tool>|mcp__/);
});
