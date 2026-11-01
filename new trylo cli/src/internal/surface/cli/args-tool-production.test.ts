import assert from "node:assert/strict";
import test from "node:test";
import { parseTools, TOOLS_USAGE } from "./args-tools.js";

test("tools help advertises the bounded production inventory used by Desktop", () => {
  assert.match(TOOLS_USAGE, /^trylo tools production-list \[--json\]/m);
});

test("production commands require a license, an exact activation review, and bounded verification permission options", () => {
  assert.equal(parseTools(["production-list", "--json"]).kind, "production-list");
  assert.equal(parseTools(["production-list", "--allow-tools", "all"]).kind, "error");
  assert.equal(parseTools(["production-list", "foreign-path"]).kind, "error");
  assert.equal(parseTools(["production-plan", "origin", "fresh.json", "--license", "MIT"]).kind, "production-plan");
  assert.equal(parseTools(["production-verify", "v", "--allow-tools", "run_shell"]).kind, "production-verify");
  assert.equal(parseTools(["production-show", "v", "--json"]).kind, "production-show");
  assert.equal(parseTools(["production-activate", "v", "--approve", "review"]).kind, "production-activate");
  for (const tokens of [["production-plan", "v", "checks.json"], ["production-plan", "v", "checks.json", "--license", "UNLICENSED"],
    ["production-activate", "v"], ["production-activate", "v", "--auto"], ["production-verify", "v", "--allow-tools", "all"],
    ["production-verify", "v", "--pass"], ["production-show", "v", "--receipt", "forged"]]) assert.equal(parseTools(tokens).kind, "error");
});
