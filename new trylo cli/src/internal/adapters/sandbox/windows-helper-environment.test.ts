import assert from "node:assert/strict";
import test from "node:test";
import { windowsHelperEnvironment } from "./windows/windows-helper-environment.js";
import { childEnvironment } from "../tools/mutating/shell-spawn.js";

test("the broker can locate its ledger while the child overlay excludes host LOCALAPPDATA and secrets", () => {
  const host = { LOCALAPPDATA: "C:\\host-ledger", PATH: "C:\\tools", TRYLO_API_KEY: "never-forward", HTTPS_PROXY: "never-forward" };
  assert.deepEqual(windowsHelperEnvironment(host), { PATH: host.PATH, LOCALAPPDATA: host.LOCALAPPDATA });
  assert.deepEqual(childEnvironment({ env: host }), { PATH: host.PATH });
});

test("an absent host ledger refuses execution rather than inventing a location", () => {
  for (const local of [undefined, "", "  "]) assert.throws(() => windowsHelperEnvironment({ LOCALAPPDATA: local }), /isolation_refused/);
});
