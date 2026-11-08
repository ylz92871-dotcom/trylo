import assert from "node:assert/strict";
import test from "node:test";
import { exposureAllowsCall, exposureForTool, toolDeniedByRules } from "./policy.js";

test("omit and code-mode rules hide tools before deny rules run", () => {
  assert.equal(
    exposureForTool("secret", undefined, {
      omitTools: ["secret"],
      codeModeDirectOnly: [],
      searchEnabled: true,
      hasDeferred: true,
      codeMode: false,
    }),
    "hidden",
  );
  assert.equal(
    exposureForTool("code_tool", "code", {
      omitTools: [],
      codeModeDirectOnly: ["code"],
      searchEnabled: false,
      hasDeferred: false,
      codeMode: false,
    }),
    "code_mode_only",
  );
  assert.equal(
    exposureForTool("pdf_lint", undefined, {
      omitTools: [],
      codeModeDirectOnly: [],
      searchEnabled: true,
      hasDeferred: true,
      codeMode: false,
    }),
    "deferred",
  );
  assert.equal(
    exposureForTool("read", undefined, {
      omitTools: [],
      codeModeDirectOnly: [],
      searchEnabled: false,
      hasDeferred: false,
      codeMode: false,
    }),
    "direct",
  );
});

test("mcp server deny strips the whole server; deny wins over exposure", () => {
  assert.equal(toolDeniedByRules("mcp__gh__read", ["mcp__gh"]), true);
  assert.equal(toolDeniedByRules("mcp__gh__read", ["mcp__other"]), false);
  assert.equal(toolDeniedByRules("read", ["read"]), true);
  const hidden = exposureAllowsCall("hidden", { codeMode: false, denied: false });

  assert.equal(hidden.ok, false);
  const denied = exposureAllowsCall("direct", { codeMode: false, denied: true });

  assert.equal(denied.ok, false);
  const gated = exposureAllowsCall("code_mode_only", { codeMode: false, denied: false });

  assert.equal(gated.ok, false);
  assert.equal(exposureAllowsCall("code_mode_only", { codeMode: true, denied: false }).ok, true);
  assert.equal(exposureAllowsCall("deferred", { codeMode: false, denied: false }).ok, true);
});

test("BLOCK-3 mcp__server__* wildcard strips the whole server", () => {
  assert.equal(toolDeniedByRules("mcp__gh__read", ["mcp__gh__*"]), true);
  assert.equal(toolDeniedByRules("mcp__gh__write", ["mcp__gh__*"]), true);
  assert.equal(toolDeniedByRules("mcp__other__read", ["mcp__gh__*"]), false);
  assert.equal(toolDeniedByRules("mcp__gh__read", ["mcp__gh__read"]), true);
  assert.equal(toolDeniedByRules("mcp__gh__write", ["mcp__gh__read"]), false);
  assert.equal(toolDeniedByRules("mcp__playwright__navigate", ["mcp__playwright__*"]), true);
});
