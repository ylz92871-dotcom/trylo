import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pathToUri, resolveWorkspacePath, uriToPath } from "./lsp-uri.js";
import { extensionOf, languageIdOf } from "./lsp-extension.js";

describe("lsp-uri", () => {
  it("resolves a relative path against the workspace root", () => {
    const uri = pathToUri("src/a.ts", "D:/proj");
    assert.equal(uri, "file:///D:/proj/src/a.ts");
    assert.equal(uriToPath(uri), "D:/proj/src/a.ts");
  });

  it("leaves an absolute path alone regardless of the root", () => {
    assert.equal(pathToUri("D:/other/a.ts", "D:/proj"), "file:///D:/other/a.ts");
    assert.equal(pathToUri("/posix/a.ts", "D:/proj"), "file:///posix/a.ts");
  });

  it("round-trips a workspace path", () => {
    const uri = pathToUri("src/internal/ports/tools.ts", "D:/proj");
    assert.equal(uri, "file:///D:/proj/src/internal/ports/tools.ts");
    assert.equal(uriToPath(uri), "D:/proj/src/internal/ports/tools.ts");
  });

  it("keeps a Windows drive letter readable", () => {
    const uri = pathToUri("D:/CC/trylo/src/a.ts", "D:/proj");
    assert.equal(uri, "file:///D:/CC/trylo/src/a.ts");
    assert.equal(uriToPath(uri), "D:/CC/trylo/src/a.ts");
  });

  it("normalises backslashes so one file has one spelling", () => {
    assert.equal(pathToUri("src\\a\\b.ts", "D:/proj"), pathToUri("src/a/b.ts", "D:/proj"));
    assert.equal(resolveWorkspacePath("D:/proj", "src\\a.ts"), "D:/proj/src/a.ts");
  });

  it("refuses a non-file document rather than inventing a path", () => {
    assert.equal(uriToPath("untitled:Untitled-1"), undefined);
    assert.equal(uriToPath("jdt://contents/foo"), undefined);
  });

  it("encodes a space instead of emitting an invalid URI", () => {
    const uri = pathToUri("my docs/a b.ts", "D:/proj");
    assert.equal(uri.includes(" "), false);
    assert.equal(uriToPath(uri), "D:/proj/my docs/a b.ts");
  });
});

describe("lsp-extension", () => {
  it("reads the extension in lower case", () => {
    assert.equal(extensionOf("src/A.TS"), "ts");
    assert.equal(extensionOf("C:\\proj\\Main.Py"), "py");
  });

  it("treats a dotfile as having no extension", () => {
    // `.gitignore` must not route to whatever server owns the empty extension.
    assert.equal(extensionOf(".gitignore"), undefined);
    assert.equal(extensionOf("src/.env"), undefined);
  });

  it("refuses a file with no extension", () => {
    assert.equal(extensionOf("Makefile"), undefined);
    assert.equal(extensionOf("src/trailing."), undefined);
  });

  it("maps tsx to the react language id, not typescript", () => {
    assert.equal(languageIdOf("a.tsx"), "typescriptreact");
    assert.equal(languageIdOf("a.ts"), "typescript");
  });

  it("returns undefined for an unmapped extension instead of defaulting", () => {
    assert.equal(languageIdOf("a.qqq"), undefined);
  });
});
