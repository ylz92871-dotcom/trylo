import assert from "node:assert/strict";
import test from "node:test";
import { npmGithubRepository } from "./npm-repository.js";
import { npmBin } from "./npm-tree-package-check.js";

test("npm's historical GitHub source labels normalize without granting downloader hosts or credentials", () => {
  const expected = "https://github.com/owner/repository";
  for (const url of ["owner/repository", "github:owner/repository", "http://github.com/owner/repository", "git://github.com/owner/repository.git",
    "git://git@github.com/owner/repository.git", "git+https://github.com/owner/repository.git", "git+ssh://git@github.com/owner/repository.git", "git@github.com:owner/repository.git"]) {
    assert.equal(npmGithubRepository({ type: "git", url }), expected, url);
  }
  for (const url of ["https://attacker.invalid/owner/repository", "https://token@github.com/owner/repository", "https://github.com/owner/repository/../secret", "file:///repo", "owner/repository#main"]) assert.equal(npmGithubRepository(url), undefined);
});
test("a string npm bin exposes only the package basename and cannot be relabeled as a nonexistent command", () => {
  const manifest = { name: "@owner/tool", bin: "./cli.js" }, files = [{ path: "cli.js" }];
  assert.equal(npmBin(manifest, "tool", files), "cli.js"); assert.equal(npmBin(manifest, "other", files), undefined);
  assert.equal(npmBin({ name: "tool", bin: { "own-command": "./cli.js" } }, "own-command", files), "cli.js");
});
