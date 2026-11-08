import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "./args.js";
import { USAGE } from "./usage.js";

test("retired routing commands and explicit flags fail clearly before execution", () => {
  for (const args of [["learn", "routing", "invoke", "--request-id", "old", "--tokens", "10"],
    ["learn", "routing", "inspect"], ["learn", "routing", "feedback"], ["learn", "routing", "--help"],
    ["run", "--routing-learning", "hello"], ["exec", "--routing-learning=false", "hello"],
    ["run", "--routing-budget-tokens=0", "hello"], ["run", "--routing-collect", "off", "hello"]]) {
    const parsed = parseArgs(args);
    assert.equal(parsed.kind, "error", JSON.stringify(args));
    if (parsed.kind === "error") assert.match(parsed.message, /retired|已退役/i);
  }
});

test("normal learning choices retain their contract without independent routing options or advertised entry", () => {
  const parsed = parseArgs(["run", "--learning=all", "hello"]);

  assert.equal(parsed.kind, "run");

  if (parsed.kind === "run") {
    assert.equal(parsed.options.learning, "all");
    assert.equal(Object.keys(parsed.options).some(key => key.startsWith("routing")), false);
  }

  assert.equal(parseArgs(["learn", "collaboration", "--budget", "0"]).kind, "learn");
  assert.equal(parseArgs(["learn", "check", "--status"]).kind, "learn");
  assert.equal(USAGE.includes("--routing-learning"), false);
  assert.equal(USAGE.includes("learn routing"), false);
});
