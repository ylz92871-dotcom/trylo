// Trylo Work — artifact open security gate tests
// (M3 closure spec §9.3, fixing M3-P1-11).
//
// Artifact paths arrive from the daemon/agent and are
// untrusted. validateArtifactTarget is the renderer-side
// first line: canonicalize both sides, then prove the
// target is strictly inside the project root on a SEGMENT
// boundary. These tests pin every denial class and the
// URL escape hatch.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  artifactDenialText,
  isHttpArtifact,
  validateArtifactTarget,
} from "../src/artifact-paths.js";

describe("validateArtifactTarget (§9.3, M3-P1-11)", () => {
  const ROOT = "C:/work/demo-ws";

  it("accepts a target strictly inside the root", () => {
    const verdict = validateArtifactTarget("C:/work/demo-ws/.trylo/out/a.md", ROOT);
    assert.deepEqual(verdict, { ok: true, canonical: "C:/work/demo-ws/.trylo/out/a.md" });
  });

  it("is case-insensitive on Windows drive and directory casing", () => {
    const verdict = validateArtifactTarget("c:\\work\\DEMO-WS\\out\\a.md", "c:/work/demo-ws");
    assert.equal(verdict.ok, true);
  });

  it("rejects a sibling root at the SEGMENT boundary (C:/work/demo-ws2)", () => {
    const verdict = validateArtifactTarget("C:/work/demo-ws2/evil.md", ROOT);
    assert.deepEqual(verdict, { ok: false, reason: "outside_root" });
  });

  it("rejects the root itself — opening the root is not an artifact action", () => {
    assert.deepEqual(validateArtifactTarget(ROOT, ROOT), {
      ok: false,
      reason: "outside_root",
    });
  });

  it("rejects .. traversal instead of silently collapsing it", () => {
    const verdict = validateArtifactTarget("C:/work/demo-ws/out/../../secret.md", ROOT);
    assert.deepEqual(verdict, { ok: false, reason: "traversal" });
  });

  it("rejects device and UNC paths", () => {
    assert.deepEqual(validateArtifactTarget("\\\\.\\PhysicalDrive0", ROOT), {
      ok: false,
      reason: "device_path",
    });
    assert.deepEqual(validateArtifactTarget("\\\\server\\share\\a.md", ROOT), {
      ok: false,
      reason: "device_path",
    });
    // Reserved device name even with an extension.
    assert.deepEqual(validateArtifactTarget("C:/work/demo-ws/out/NUL.txt", ROOT), {
      ok: false,
      reason: "device_path",
    });
  });

  it("rejects when no project root is available", () => {
    assert.deepEqual(validateArtifactTarget("C:/work/demo-ws/out/a.md", undefined), {
      ok: false,
      reason: "missing_root",
    });
    assert.deepEqual(validateArtifactTarget("C:/work/demo-ws/out/a.md", "   "), {
      ok: false,
      reason: "missing_root",
    });
  });

  it("rejects malformed targets", () => {
    assert.deepEqual(validateArtifactTarget("", ROOT), {
      ok: false,
      reason: "malformed",
    });
    assert.deepEqual(validateArtifactTarget("relative/no/root.md", ROOT), {
      ok: false,
      reason: "outside_root",
    });
  });

  it("keeps POSIX containment strict (case-sensitive)", () => {
    const verdict = validateArtifactTarget("/Repo/out/a.md", "/repo");
    assert.deepEqual(verdict, { ok: false, reason: "outside_root" });
    assert.deepEqual(validateArtifactTarget("/repo/out/a.md", "/repo"), {
      ok: true,
      canonical: "/repo/out/a.md",
    });
  });
});

describe("isHttpArtifact (§9.3 URL escape hatch)", () => {
  it("accepts http/https URLs", () => {
    assert.equal(isHttpArtifact("http://example.com"), true);
    assert.equal(isHttpArtifact("HTTPS://example.com/a?b=1"), true);
    assert.equal(isHttpArtifact("  https://example.com  "), true);
  });

  it("rejects other schemes and control characters", () => {
    assert.equal(isHttpArtifact("file://c:/windows"), false);
    assert.equal(isHttpArtifact("javascript:alert(1)"), false);
    assert.equal(isHttpArtifact("https://example.com/\u0000"), false);
    assert.equal(isHttpArtifact("C:/work/demo-ws/out/a.md"), false);
    assert.equal(isHttpArtifact(undefined), false);
  });
});

describe("artifactDenialText (§9.3: disabled actions explain why)", () => {
  it("returns a non-empty user-facing text for every reason", () => {
    for (const reason of [
      "missing_root",
      "malformed",
      "traversal",
      "device_path",
      "outside_root",
    ] as const) {
      const text = artifactDenialText(reason);
      assert.ok(text.length > 0, `no denial text for ${reason}`);
    }
  });
});
