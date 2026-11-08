import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runStaticScans } from "./static-scans.mjs";

/**
 * The commit-time gate. Scope: exactly the checks that are cheap enough to
 * run on every commit — the format gate that once stayed red for two days
 * unnoticed (autocrlf made it invisible to `git status`), and the static
 * hygiene scans shared with verify step 3. The heavier gates (tests,
 * architecture prove-fail, license closure) remain `npm run verify`; this
 * hook exists so a red gate cannot ride along with the next commit.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

const formatRun = spawnSync(process.execPath, [join(here, "format-check.mjs")], {
  capture: true,
  encoding: "utf8",
});
if (formatRun.status !== 0) {
  process.stderr.write(formatRun.stdout + formatRun.stderr);
  process.exit(1);
}

const { issues } = runStaticScans(root);

if (issues.length > 0) {
  process.stderr.write(`${issues.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write("pre-commit: format + static hygiene pass\n");
