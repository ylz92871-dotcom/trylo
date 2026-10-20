import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DirectoryEntry, FileSystemReader } from "../read-only/limits.js";
import { resolve } from "node:path";
import { FileFinder } from "./file-finder.js";

/**
 * A reader over an in-memory tree, so these tests assert the contract rather
 * than the shape of somebody's temporary directory.
 *
 * Paths are normalised to `/` on the way in *and* on the way out, because the
 * production code reaches the filesystem through `node:path`, which on Windows
 * hands back `\w\.gitignore` for `path.join("/w", ".gitignore")`. A double that
 * did not normalise would silently stop finding `.gitignore` — and the test would
 * pass for the wrong reason on a POSIX machine while the real code was fine.
 */
function normalise(path: string): string {
  return path.replaceAll("\\", "/");
}

function readerFor(files: Readonly<Record<string, string>>): FileSystemReader {
  const store = new Map<string, string>(Object.entries(files).map(([key, value]) => [normalise(key), value]));
  return {
    async readOptionalUtf8(absolutePath) {
      return store.get(normalise(absolutePath));
    },
    async readFileUtf8(absolutePath: string): Promise<string> {
      const text = store.get(normalise(absolutePath));
      if (text === undefined) throw new Error(`ENOENT ${absolutePath}`);
      return text;
    },
    async readDir(absolutePath: string): Promise<ReadonlyArray<DirectoryEntry>> {
      const prefix = normalise(absolutePath).endsWith("/") ? normalise(absolutePath) : `${normalise(absolutePath)}/`;
      const names = new Map<string, boolean>();
      for (const key of store.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash < 0) names.set(rest, false);
        else names.set(rest.slice(0, slash), true);
      }
      return [...names].map(([name, isDirectory]) => ({ name, isDirectory }));
    },
    async statBytes(): Promise<number> {
      return 0;
    },
  };
}

// Physical-path admission resolves a rooted Windows spelling to its drive.
// Keep the virtual reader in the same canonical namespace as production.
const ROOT = resolve("/w");

function finderFor(files: Readonly<Record<string, string>>, maxIndexedFiles?: number): FileFinder {
  return new FileFinder({
    workspaceRoot: ROOT,
    reader: readerFor(files),
    ...(maxIndexedFiles === undefined ? {} : { maxIndexedFiles }),
  });
}

const never = new AbortController().signal;

describe("FileFinder", () => {
  it("finds a file from a fragment of its name", async () => {
    const finder = finderFor({
      [`${ROOT}/src/internal/surface/cli/mention.ts`]: "export const a = 1;",
      [`${ROOT}/src/internal/ports/tools.ts`]: "export type B = 2;",
      [`${ROOT}/README.md`]: "# hi",
    });
    const found = await finder.find("mention", 5, never);
    assert.deepEqual(found.matches.map((m) => m.path), ["src/internal/surface/cli/mention.ts"]);
  });

  it("matches on path segments, not just the basename", async () => {
    const finder = finderFor({
      [`${ROOT}/src/ports/tools.ts`]: "",
      [`${ROOT}/src/other.ts`]: "",
    });
    const found = await finder.find("portstools", 5, never);
    assert.equal(found.matches[0]?.path, "src/ports/tools.ts");
  });

  it("returns nothing for an empty query instead of an arbitrary listing", async () => {
    const finder = finderFor({ [`${ROOT}/a.ts`]: "" });
    const found = await finder.find("   ", 5, never);
    // A picker with no query must offer nothing; a confident list invites a
    // random pick.
    assert.deepEqual(found.matches, []);
  });

  it("says the index is incomplete when a ceiling was hit", async () => {
    const files: Record<string, string> = { [`${ROOT}/keep.ts`]: "" };
    for (let i = 0; i < 30; i += 1) files[`${ROOT}/f${i}.ts`] = "";
    const finder = finderFor(files, 5);
    const found = await finder.find("zzzznothing", 5, never);
    // The distinction the whole contract exists for: an empty answer must not be
    // able to masquerade as "this project has no such file".
    assert.deepEqual(found.matches, []);
    assert.equal(found.indexTruncated, true);
    assert.ok(found.reasons.includes("file_limit"));
  });

  it("does not claim completeness when nothing was truncated", async () => {
    const finder = finderFor({ [`${ROOT}/a.ts`]: "" });
    const found = await finder.find("zzzznothing", 5, never);
    assert.deepEqual(found.matches, []);
    assert.equal(found.indexTruncated, false);
  });

  it("honours .gitignore so a suggested file is one read_file can open", async () => {
    const finder = finderFor({
      [`${ROOT}/.gitignore`]: "secret.ts\nbuild/\n",
      [`${ROOT}/secret.ts`]: "hidden",
      [`${ROOT}/build/out.ts`]: "generated",
      [`${ROOT}/visible.ts`]: "ok",
    });
    const found = await finder.find("secret", 5, never);
    assert.deepEqual(found.matches, []);
    const visible = await finder.find("visible", 5, never);
    assert.deepEqual(visible.matches.map((m) => m.path), ["visible.ts"]);
  });

  it("finds files with non-ASCII names", async () => {
    const finder = finderFor({
      [`${ROOT}/src/端口导航.ts`]: "",
      [`${ROOT}/src/其他.ts`]: "",
    });
    const found = await finder.find("端口", 5, never);
    assert.deepEqual(found.matches.map((m) => m.path), ["src/端口导航.ts"]);
  });

  it("excludes the default heavy directories", async () => {
    const finder = finderFor({
      [`${ROOT}/node_modules/pkg/index.js`]: "",
      [`${ROOT}/dist/bundle.js`]: "",
      [`${ROOT}/src/index.ts`]: "",
    });
    const found = await finder.find("index", 10, never);
    assert.deepEqual(found.matches.map((m) => m.path), ["src/index.ts"]);
  });

  it("builds the index once and reuses it", async () => {
    let reads = 0;
    const base = readerFor({ [`${ROOT}/a.ts`]: "", [`${ROOT}/b.ts`]: "" });
    const counting: FileSystemReader = {
      ...base,
      async readDir(path: string) {
        reads += 1;
        return base.readDir(path);
      },
    };
    const finder = new FileFinder({ workspaceRoot: ROOT, reader: counting });
    await finder.find("a", 5, never);
    const afterFirst = reads;
    await finder.find("b", 5, never);
    // A finder re-enumerating per keystroke is the reason fuzzy search feels slow.
    assert.equal(reads, afterFirst);
  });

  it("stops cleanly when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const finder = finderFor({ [`${ROOT}/a.ts`]: "" });
    const found = await finder.find("a", 5, controller.signal);
    assert.deepEqual(found.matches, []);
  });

  it("respects the limit", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i += 1) files[`${ROOT}/target${i}.ts`] = "";
    const finder = finderFor(files);
    const found = await finder.find("target", 3, never);
    assert.equal(found.matches.length, 3);
  });
});
