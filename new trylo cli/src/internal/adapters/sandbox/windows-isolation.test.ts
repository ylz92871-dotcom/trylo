import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createWindowsIsolation, windowsIsolationDiagnostic } from "./windows-isolation.js";

/**
 * WP04 — the fail-closed contract.
 *
 * The dangerous shape for this adapter is a quiet degradation: a machine with
 * no sandbox installed, a broken fence, or a helper that refuses to start must
 * all end in "the command did not run", never in the command running anyway.
 * Every test below targets that, because it is the property no probe can
 * demonstrate on a machine where the sandbox happens to work.
 *
 * The real-machine behaviour (WFP blocking a direct connect, an ACL denying a
 * write, the helper executing a program) is proven by the scripts in
 * `docs/02-分期工程产出/P00-工程地基与质量门禁/evidence/2026-10-04-WP04-probes/`.
 * These tests are the platform-independent half.
 */

const isWindows = process.platform === "win32";

function request(overrides: Partial<Parameters<ReturnType<typeof createWindowsIsolation>["run"]>[0]> = {}) {
  return {
    argv: ["cmd.exe", "/c", "echo hi"],
    // A mapped or network drive is refused before launch, so the tests that
    // expect a refusal use the real cwd and the ones that expect a launch do
    // not depend on where the repository lives.
    cwd: process.cwd(),
    files: { writableRoots: [], denyWritePaths: [], denyReadPaths: [] },
    network: { allowedDomains: [], deniedDomains: [], egressFenceVerified: true },
    timeoutMs: 5_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

test("a missing helper is reported as broken, never as ready", async () => {
  const port = createWindowsIsolation({ helperPath: path.join(tmpdir(), "definitely-absent-srt-win.exe") });
  const availability = await port.probe();

  assert.notEqual(availability.state, "ready");

  if (availability.state === "unavailable") {
    assert.match(availability.reason, /win32|platform/i);
  } else {
    assert.equal(availability.state, "broken");
    assert.match(availability.reason, /missing/i);
  }
});

test("no state other than ready runs a command", async () => {
  // Whichever way this machine is configured, an unavailable/not-installed/
  // broken sandbox must refuse the command. This is the assertion that keeps
  // the adapter from degrading into an unconfined spawn.
  const port = createWindowsIsolation({ helperPath: path.join(tmpdir(), "definitely-absent-srt-win.exe") });
  const outcome = await port.run(request());

  assert.equal(outcome.outcome, "isolation_failed");

  if (outcome.outcome === "isolation_failed") {
    assert.ok(
      outcome.code === "isolation_unavailable" ||
        outcome.code === "isolation_not_installed" ||
        outcome.code === "isolation_broken",
      `unexpected code ${outcome.code}`,
    );
    // The message has to say the command did not run, so nobody reads the
    // failure as the command's own verdict.
    assert.match(outcome.message, /not run/i);
  }
});

test("an unavailable backend names the platform rather than blaming the machine", async () => {
  if (isWindows) {
    return;
  }

  const availability = await createWindowsIsolation().probe();

  assert.equal(availability.state, "unavailable");

  if (availability.state === "unavailable") {
    assert.match(availability.reason, /Windows/);
  }
});

test("a glob never reaches the helper as a literal path", async () => {
  // srt-win rejects globs; passing one through would either fail the whole
  // launch or, worse, be treated as a literal directory name. The adapter
  // drops them so the policy cannot silently widen.
  const port = createWindowsIsolation({ helperPath: path.join(tmpdir(), "absent-srt-win.exe") });
  const outcome = await port.run(
    request({
      files: {
        writableRoots: [],
        denyWritePaths: ["C:/temp/*", "C:/Users/Public"],
        denyReadPaths: ["D:/**/secrets"],
      },
    }),
  );

  // The launch is refused for the missing helper, so the assertion here is
  // only that the request was well-formed enough to reach that point without
  // throwing — the glob filtering itself is asserted by buildArgv coverage.
  assert.equal(outcome.outcome, "isolation_failed");
});

test("an aborted signal ends as cancelled and never as a completed run", async () => {
  const controller = new AbortController();
  controller.abort();
  const outcome = await createWindowsIsolation().run(request({ signal: controller.signal }));
  // On a machine without the sandbox this is a typed failure; the point is
  // that it is not reported as a successful execution of the command.
  assert.notEqual(outcome.outcome, "completed");
});

test("doctor surfaces the state without attempting an install", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "trylo-wp04-diag-"));
  try {
    const row = await windowsIsolationDiagnostic({ helperPath: path.join(dir, "absent.exe") });
    assert.equal(row.backend, "windows-srt");
    assert.ok(row.state !== "ready");
    assert.ok(row.detail.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
