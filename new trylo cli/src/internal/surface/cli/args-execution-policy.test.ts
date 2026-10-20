import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "./args.js";

test("filesystem and shell choices are explicit run options", () => {
  const parsed = parseArgs(["run", "--filesystem-access", "host", "--shell", "auto", "hello"]);
  assert.equal(parsed.kind, "run", JSON.stringify(parsed));
  if (parsed.kind === "run") assert.deepEqual(parsed.options, {
    message: ["hello"], readStdin: false, fileAccess: "host", shell: "auto",
  });
});

test("invalid filesystem or shell values fail at the CLI boundary", () => {
  for (const argv of [["--filesystem-access", "anything"], ["--shell", "anything"]]) {
    assert.equal(parseArgs(["run", ...argv, "hello"]).kind, "error");
  }
});
