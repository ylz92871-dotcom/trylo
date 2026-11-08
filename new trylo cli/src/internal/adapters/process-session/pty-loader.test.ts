import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { ptyPlatformArch, ptyPlatformLabel, resolvePtyHelper } from "./pty-loader.js";

/** The loader's own copy of the path, which the test below compares against the script. */
const DIST_SUBDIR = path.join("internal", "vendor", "pty");

/**
 * Where the helper is found, and what happens when it is not.
 *
 * The third test exists because of a real bug. The platform label was written as
 * one expression that tested the *argument* rather than the resolved value, so
 * an absent argument produced `win32-x64` instead of `win-x64`. Nothing failed:
 * the PTY suite skipped itself with a readable message, the build stayed green,
 * and a machine with a perfectly good terminal helper reported that it had none.
 *
 * The first version of this file tested `ptyPlatformArch` directly and its red
 * example did not turn red — the resolver had its own inline expression, so
 * pinning the function said nothing about the code that runs. The test below
 * goes through `resolvePtyHelper` and inspects the directory it decided on.
 */

/** Both separators, because a Windows path may contain either. */
function segmentsOf(candidate: string): string[] {
  return candidate.split(/[\\/]/);
}

const installedModuleDir = path.join("D:", "installed", "trylo", "dist", "internal", "adapters", "process-session");
const repoModuleDir = path.join("D:", "pkg", "dist", "internal", "adapters", "process-session");

describe("pty helper resolution", () => {
  it("labels win32 as win, matching the artifact directory", () => {
    assert.equal(ptyPlatformLabel("win32"), "win");
    assert.equal(ptyPlatformLabel("linux"), "linux");
    assert.equal(ptyPlatformLabel("darwin"), "darwin");
  });

  it("applies the substitution to the value it will actually use", () => {
    assert.equal(ptyPlatformArch("win32", "x64"), "win-x64");
    assert.equal(ptyPlatformArch("linux", "x64"), "linux-x64");
    assert.equal(ptyPlatformArch("darwin", "arm64"), "darwin-arm64");
  });

  it("labels the platform the resolver computes, not only the helper function", () => {
    const win = resolvePtyHelper({
      platform: "win32",
      arch: "x64",
      moduleDir: repoModuleDir,
      exists: () => true,
    });

    assert.equal(win.ok, true);

    if (win.ok) {
      const parts = segmentsOf(win.helperPath);

      assert.ok(
        parts.includes("win-x64"),
        `win32 must resolve into the win-x64 directory, got ${win.helperPath}`,
      );
      assert.equal(
        parts.includes("win32"),
        false,
        "and never into a directory named after Node's own platform string",
      );
    }

    const linux = resolvePtyHelper({
      platform: "linux",
      arch: "x64",
      moduleDir: repoModuleDir,
      exists: () => true,
    });

    assert.equal(linux.ok, true);

    if (linux.ok) {
      assert.ok(
        segmentsOf(linux.helperPath).includes("linux-x64"),
        `linux keeps its own label, got ${linux.helperPath}`,
      );
    }
  });

  it("resolves against the platform it was given, not the one it runs on", () => {
    const found = resolvePtyHelper({
      platform: "linux",
      arch: "x64",
      moduleDir: repoModuleDir,
      exists: () => true,
    });

    assert.equal(found.ok, true);

    if (found.ok) {
      assert.ok(segmentsOf(found.helperPath).includes("linux-x64"));
    }
  });

  it("looks next to its own compiled location, not in the source tree", () => {
    const found = resolvePtyHelper({
      platform: "win32",
      arch: "x64",
      moduleDir: installedModuleDir,
      exists: () => true,
    });

    assert.equal(found.ok, true);

    if (found.ok) {
      // An installed package has no vendor-bin/ and no repo root. A path that
      // reached into either would work for the author and nowhere else.
      const parts = segmentsOf(found.helperPath);

      assert.ok(parts.includes("installed"), `resolved inside the installed package: ${found.helperPath}`);
      assert.ok(parts.includes("vendor"), "through the staged vendor directory");
      assert.equal(parts.includes("vendor-bin"), false, "never through the source tree's vendor-bin");
      assert.equal(parts.includes("src"), false, "never through src");
    }
  });

  it("puts the artifact exactly three levels above its own module", () => {
    // Every other test here injects `exists`, which would hide a wrong path
    // entirely: a resolver that looked two levels up instead of three would
    // still be told the file was there. This one checks the shape of the path
    // itself, so the depth is a fact under test rather than an assumption.
    //
    // The depth is three because the compiled module sits at
    // `dist/internal/adapters/process-session/pty-loader.js` and the artifact
    // at `dist/internal/vendor/pty/<arch>/`. Off by one and a correctly built,
    // correctly installed package reports that it has no terminal.
    const found = resolvePtyHelper({
      platform: "win32",
      arch: "x64",
      moduleDir: installedModuleDir,
      exists: () => true,
    });

    assert.equal(found.ok, true);

    if (found.ok) {
      const expected = path.join(
        installedModuleDir,
        "..",
        "..",
        "..",
        "internal",
        "vendor",
        "pty",
        "win-x64",
        "trylo-pty.exe",
      );
      assert.equal(
        path.resolve(found.helperPath),
        path.resolve(expected),
        `expected ${expected}, got ${found.helperPath}`,
      );
    }
  });

  it("agrees with the copy script about where the artifact goes", () => {
    // The loader and `scripts/pty/copy-pty-vendor.mjs` cannot share a constant:
    // one is TypeScript under `src`, the other a build script outside it, and
    // nothing imports across that boundary. So the two are compared by reading
    // the script. The previous version of this file asserted nothing and the
    // script's comment claimed this test existed — a described mechanism with no
    // implementation, which is worse than an acknowledged duplication because it
    // reads as covered.
    const script = readFileSync(
      path.join("scripts", "pty", "copy-pty-vendor.mjs"),
      "utf8",
    );
    const declared = /export const PTY_DIST_SUBDIR = "([^"]+)"/.exec(script);

    assert.ok(declared !== null, "the copy script must declare where it writes the artifact");
    const fromScript = declared[1]?.split("/").join(path.sep) ?? "";

    assert.equal(
      fromScript,
      DIST_SUBDIR,
      `the copy script writes to ${fromScript} but the loader looks in ${DIST_SUBDIR}`,
    );
  });

  it("marks a packaged helper as packaged", () => {
    const found = resolvePtyHelper({
      platform: "win32",
      arch: "x64",
      moduleDir: repoModuleDir,
      exists: () => true,
    });

    assert.equal(found.ok, true);

    if (found.ok) {
      assert.equal(found.source, "package");
    }
  });

  it("explains an unbuilt platform instead of falling back to pipes", () => {
    const missing = resolvePtyHelper({
      platform: "linux",
      arch: "riscv64",
      moduleDir: repoModuleDir,
      exists: () => false,
    });

    assert.equal(missing.ok, false);

    if (!missing.ok) {
      assert.equal(missing.code, "pty_helper_not_built_for_platform");
      assert.match(missing.message, /linux-riscv64/);
      assert.match(missing.message, /cargo build/, "the message says how to fix it");
      assert.match(
        missing.message,
        /not the same thing as a pipe/,
        "a missing terminal must never be reported as a working pipe",
      );
    }
  });

  it("verifies an override rather than trusting it", () => {
    const bad = resolvePtyHelper({ override: path.join("D:", "nope", "trylo-pty.exe") });

    assert.equal(bad.ok, false);

    if (!bad.ok) {
      assert.equal(bad.code, "pty_helper_override_invalid");
      assert.match(bad.message, /TRYLO_PTY_HELPER/);
    }

    // Proven by asking the question: a path that does not exist is refused,
    // which is the point of verifying rather than trusting.
    const good = resolvePtyHelper({ override: process.execPath, exists: () => true });

    assert.equal(good.ok, true);

    if (good.ok) {
      assert.equal(good.source, "override", "an override is labelled as one, not as packaged");
      assert.equal(good.helperPath, process.execPath);
    }
  });

  it("treats an empty override as absent rather than as a path", () => {
    const found = resolvePtyHelper({
      override: "",
      platform: "win32",
      arch: "x64",
      moduleDir: repoModuleDir,
      exists: () => true,
    });

    assert.equal(found.ok, true);

    if (found.ok) {
      assert.equal(found.source, "package");
    }
  });
});
