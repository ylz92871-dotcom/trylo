import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectDoctor, doctorExitCode, renderDoctorText, type DoctorIo, type DoctorOptions } from "./doctor.js";
import { runDoctor } from "./doctor-run.js";
import { projectContextFor } from "./project-rules.js";
import { projectRulesCheck } from "./project-rules-check.js";
import type { CliContext } from "./context.js";

/**
 * WP-CLI-B1 §3.3: a diagnostic a user can check the run against.
 *
 * Two claims are under test, and they are different ones.
 *
 * The first is that the line says the useful thing — which file, which subtree,
 * which version — while staying small enough to paste into a bug report. The
 * size half is not a style preference: a project's `AGENTS.md` routinely names
 * internal hosts and release procedures, and a diagnostic that printed it would
 * be copying the project's secrets into terminal scrollback on every `doctor`.
 *
 * The second is the one §3.3 actually forbids: doctor and run must not each
 * resolve rules their own way. That is asserted against the real filesystem
 * through the real `runDoctor`, because a test that passed hand-built source
 * lists to both sides would be asserting that a function is deterministic, which
 * was never in doubt.
 */

function workspaceWith(
  files: Readonly<Record<string, string>>,
): { readonly root: string; readonly cleanup: () => void } {
  const root = mkdtempSync(join(os.tmpdir(), "trylo-b1-diag-"));

  for (const [relative, text] of Object.entries(files)) {
    const absolute = join(root, relative);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, text);
  }

  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * A context that reads the real disk, because the resolver must see the real files.
 *
 * `homeDir` is deliberately **not** `cwd`. On a real machine the home directory
 * and the project are different places, and a test that conflates them makes the
 * resolver's root indistinguishable from any other — which is exactly the
 * mistake this file exists to catch. The value below is a second temp directory,
 * so "which directory did doctor resolve against" has a wrong answer available.
 */
function contextFor(cwd: string): CliContext {
  return {
    env: {},
    homeDir: join(os.tmpdir(), "trylo-b1-diag-home-does-not-exist"),
    cwd,
    nodeVersion: "v22.0.0",
    platform: "linux",
    stdinIsTty: false,

    readFile: (absolutePath) => {
      try {
        return readFileSync(absolutePath, "utf8");
      } catch {
        return undefined;
      }
    },

    isDirectory: () => true,
    readDir: () => [],
    writeFile: () => true,
    readStdin: async () => "",
    readLine: async () => undefined,
    readSecret: async () => undefined,
    stdout: () => {},
    stderr: () => {},
    now: () => 1_700_000_000_000,
    newId: (prefix) => `${prefix}-b1diag`,
  };
}

const doctorIo = (root: string): DoctorIo => ({
  readFile: () => undefined,
  isDirectory: () => true,
  readDir: () => [],
  env: {},
  homeDir: root,
  cwd: root,
  workspaceRoot: root,
  nodeVersion: "v22.0.0",
  now: () => 1_700_000_000_000,
});

const baseOptions = (root: string): DoctorOptions => ({
  toolCatalogHash: "hash",
  sessionsDir: join(root, "sessions"),
});

function lineFor(root: string): { readonly id: string; readonly status: string; readonly detail: string } {
  const report = collectDoctor(doctorIo(root), baseOptions(root));
  const found = report.checks.find((check) => check.id === "project.rules");
  assert.ok(found, `doctor must report project.rules; it reported ${report.checks.map((c) => c.id).join(", ")}`);
  return found;
}

test("an adopted rule file is reported with its scope and a short hash", () => {
  const workspace = workspaceWith({ "AGENTS.md": "house rules\n" });
  try {
    const context = projectContextFor(contextFor(workspace.root), workspace.root);

    assert.ok(context);
    const check = projectRulesCheck(context.sources, context.problems);

    assert.equal(check.status, "ok");
    assert.match(check.detail, /AGENTS\.md/);
    assert.match(check.detail, /whole workspace/);
    // The hash a user compares against the previous run's, truncated to
    // something readable rather than a full sha256.
    const hash = context.sources[0]?.contentHash ?? "";

    assert.ok(hash.length === 16, "the resolver keeps a 16-char hash");
    assert.ok(check.detail.includes(hash.slice(0, 8)));
    assert.ok(!check.detail.includes(hash), "the diagnostic shows the short hash, not the full one");
  } finally {
    workspace.cleanup();
  }
});

test("the rule text itself never reaches the diagnostic", () => {
  const secretish = "internal-host build01 deploy key sk-live-DO-NOT-LEAK";
  const workspace = workspaceWith({ "AGENTS.md": `${secretish}\n` });

  try {
    const context = projectContextFor(contextFor(workspace.root), workspace.root);

    assert.ok(context);
    const check = projectRulesCheck(context.sources, context.problems);

    assert.ok(!check.detail.includes("DO-NOT-LEAK"), "rule prose must not be printed");
    assert.ok(!check.detail.includes(secretish));
    // And the machine face agrees: the check object carries no `text` field to
    // serialize, so `--json` cannot leak it either.
    assert.deepEqual(Object.keys(check).sort(), ["detail", "id", "status"]);
  } finally {
    workspace.cleanup();
  }
});

test("a subdirectory rule is reported against its own subtree", () => {
  const workspace = workspaceWith({
    "AGENTS.md": "root rules\n",
    "docs/AGENTS.md": "docs rules\n",
  });
  try {
    const context = projectContextFor(contextFor(join(workspace.root, "docs")), workspace.root);
    assert.ok(context);
    const check = projectRulesCheck(context.sources, context.problems);

    assert.match(check.detail, /AGENTS\.md \(whole workspace/);
    assert.match(check.detail, /docs\/AGENTS\.md \(docs\/ and below/);
  } finally {
    workspace.cleanup();
  }
});

test("a workspace with no rule file reports skip, not a failure", () => {
  const workspace = workspaceWith({ "src/index.ts": "export const x = 1;\n" });
  try {
    const check = lineFor(workspace.root);

    assert.equal(check.status, "skip");
    // The message names what was looked for: a user who *believes* they have a
    // rules file needs to learn which three names were checked.
    assert.match(check.detail, /AGENTS\.md/);
    assert.match(check.detail, /CLAUDE\.md/);
    assert.match(check.detail, /GEMINI\.md/);
  } finally {
    workspace.cleanup();
  }
});

/**
 * The teeth of the whole check.
 *
 * A rule file that exists but cannot be read is `fail`, and `doctor` exits 52.
 * Reporting it as `skip` would be the comfortable lie: the project stated rules,
 * the run will proceed without some of them, and the model will quietly ignore
 * conventions the user believes it was given.
 */
test("a rule file that cannot be read fails the diagnostic and the exit code", () => {
  const check = projectRulesCheck([], ["project_instructions_oversized:AGENTS.md"]);

  assert.equal(check.status, "fail");
  assert.match(check.detail, /oversized:AGENTS\.md/);

  const report = collectDoctor(doctorIo("/tmp/nowhere"), {
    ...baseOptions("/tmp/nowhere"),
    projectRules: { sources: [], problems: ["project_instructions_unreadable:AGENTS.md"] },
  });

  assert.equal(doctorExitCode(report), 52, "a broken rule file is a config-class exit, not a warning");
});

/**
 * §3.3's actual prohibition: one resolver, one answer.
 *
 * Both sides run for real against the same directory, and the doctor's line has
 * to name the same files the resolver hands a run. A doctor that walked for
 * itself would pass this test whenever the two walks agreed — which is to say,
 * whenever nobody tested them apart.
 */
test("doctor and the run's resolver report the same files", () => {
  const workspace = workspaceWith({
    "AGENTS.md": "root rules\n",
    "src/AGENTS.md": "src rules\n",
  });
  try {
    const ctx = contextFor(workspace.root);
    const runSees = projectContextFor(ctx, workspace.root);

    assert.ok(runSees);

    const run = runDoctor(ctx);
    const check = run.report.checks.find((entry) => entry.id === "project.rules");

    assert.ok(check);
    // Count first. Two resolvers pointed at the wrong root both report *no*
    // rules, and "both empty" compares equal — so a substring loop over an empty
    // source list would pass while the two had quietly stopped agreeing about
    // anything. Asserting the count is what gives the comparison teeth.
    assert.equal(runSees.sources.length, 1, "a run started at the root adopts exactly the root rule");
    assert.equal(check.status, "ok", "doctor must find what the run finds");

    for (const source of runSees.sources) {
      assert.ok(
        check.detail.includes(source.relativePath),
        `doctor must name ${source.relativePath}, the file the run adopts`,
      );
      assert.ok(check.detail.includes(source.contentHash.slice(0, 8)));
    }
  } finally {
    workspace.cleanup();
  }
});

/**
 * Where doctor and a run genuinely share a root, and what that means.
 *
 * `doctor` takes no `--workspace`, so its root is `cwd` — which is also what
 * `trylo run` uses when no `--workspace` is passed. The two therefore resolve
 * against the same directory by construction, and starting from a subdirectory
 * means "this subdirectory *is* the project": its rule file is reported as the
 * whole-workspace one, because for this run that is exactly what it is.
 *
 * The case worth stating is the one that is *not* this: a run started inside a
 * workspace still adopts the root's rules (covered in
 * `project-rules-wiring.test.ts`), and a run given `--workspace docs` is a
 * different project from a `doctor` in the parent. Comparing those two is
 * comparing two different runs, not catching a diagnostic that disagrees with
 * the request it explains.
 */
test("doctor in a subdirectory treats that directory as the project root", () => {
  const workspace = workspaceWith({
    "AGENTS.md": "root rules\n",
    "docs/AGENTS.md": "docs rules\n",
  });
  try {
    const fromDocs = join(workspace.root, "docs");
    const ctx = contextFor(fromDocs);
    const runSees = projectContextFor(ctx, fromDocs);

    assert.ok(runSees);
    assert.deepEqual(
      runSees.sources.map((source) => [source.relativePath, source.scope]),
      [["AGENTS.md", "workspace_root"]],
      "docs is the root here, so its own rule file is the whole-workspace rule",
    );

    const check = runDoctor(ctx).report.checks.find((entry) => entry.id === "project.rules");

    assert.ok(check);
    assert.ok(check.detail.includes("AGENTS.md (whole workspace"), check.detail);
    // The parent's file is genuinely out of scope: the resolver is bounded by the
    // workspace root on purpose, and a subdirectory run pointed at `docs` must
    // not silently inherit the parent project's conventions.
    assert.ok(!check.detail.includes("docs/AGENTS.md"), check.detail);
  } finally {
    workspace.cleanup();
  }
});

test("the doctor line renders in the text output a user actually reads", () => {
  const workspace = workspaceWith({ "AGENTS.md": "house rules\n" });
  try {
    const ctx = contextFor(workspace.root);
    const text = renderDoctorText(runDoctor(ctx).report);
    // The renderer pads status and id into columns; a detail carrying newlines
    // must still start on a recognisable line, which is what a user greps for.
    assert.match(text, /^OK\s+project\.rules\s+1 rule file adopted:$/m);
    assert.match(text, /^ {2}AGENTS\.md \(whole workspace, [0-9a-f]{8}\)$/m);
  } finally {
    workspace.cleanup();
  }
});

test("a caller that passes no rule report still gets a line, because it asked nothing", () => {
  // Absent means "this caller did not resolve rules", not "this project has
  // none". Reporting `skip` there would claim a fact the caller never checked.
  const report = collectDoctor(doctorIo("/tmp/nowhere"), baseOptions("/tmp/nowhere"));
  const check = report.checks.find((entry) => entry.id === "project.rules");

  assert.ok(check);
  assert.equal(check.status, "skip");
  assert.match(check.detail, /not evaluated|no AGENTS\.md/);
});
