import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The static hygiene scans shared by verify step 3 and the pre-commit hook.
 *
 * One implementation, two consumers: the gate that runs at verify time and
 * the gate that runs at commit time must be the *same* rule, or the hook is
 * a second opinion about what hygiene means. Everything here is mechanical
 * and dependency-free; the heavier gates (tests, architecture prove-fail,
 * license closure) stay in `verify.mjs`.
 */

const importRe = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;

/**
 * Where touching the environment is the documented job: the process entry
 * file, CLI input surfaces, and adapters whose purpose is reading the
 * platform (PATH resolution, child env, the env-backed credential table).
 * Injection defaults (`options.now ?? Date.now`) are allowed everywhere by
 * pattern, so a file only needs to be listed here for *bare* ambient reads.
 */
const AMBIENT_FILE_ALLOWLIST = new Set([
  "src/cmd/trylo/main.ts", // the one sanctioned owner of `process`
  "src/cmd/trylo/windows-pipeline.ts", // private restricted process entry; stream IO only, no policy or timers
  "src/internal/adapters/sandbox/windows-stdin-host.ts", // trusted private process entry: owns stdin IPC and broker lifetime
  "src/internal/adapters/sandbox/windows-stdin-client.ts", // restricted private process entry: removes IPC capability before target spawn
  // The daemon's own entry point (WP26 / A04). Same justification as main.ts, and
  // it keeps that statement true: this file reads `process.env` once, hands it to
  // `runDaemon` as an argument, and makes no decision of its own. Everything below
  // that line takes its environment as a parameter — see
  // `src/internal/adapters/daemon/process-ambient.ts` for the named seam and why a
  // second exemption was not taken for the whole file.
  "src/cmd/trylo/daemon-main.ts",
  // The process-session wiring for a run (WP26 / A04). Same discipline as
  // daemon-main.ts: it reads `homedir()` and `process.env` once, passes them to
  // `tryloHome(...)` to locate the durable job table, and makes no decision of its
  // own about either value. Everything the registries do takes them as arguments.
  "src/internal/surface/cli/session-view-wiring.ts",
  "src/internal/surface/cli/secret-prompt.ts", // process.stdin, CLI input surface
  "src/internal/surface/cli/doctor.ts", // display-only token-expiry check
  "src/internal/e2e/regression-harness.ts", // harness that drives processes
  "src/internal/adapters/mcp-stdio/transport-env.ts", // the child env allowlist itself
  "src/internal/adapters/sandbox/executable.ts", // PATH/PATHEXT resolution
  "src/internal/adapters/tools/mutating/shell-spawn.ts", // child spawn env
  "src/internal/credentials/env-table.ts", // env-backed credential table
  "src/internal/tooling/quarantine/acquire.ts", // deferred tooling, platform detection
  "src/internal/subagent/runtime.ts", // id generator default; `idGenerator` seam exists
]);

/**
 * Files that may hold `as unknown as`, and why. A double cast erases the
 * type checker exactly where a wrong shape would be silently accepted, so
 * every survivor must be a boundary with a stated reason — and persistence
 * read boundaries now validate at runtime instead (recovery.ts, projection.ts
 * lead by example: guard + fail-closed, no cast).
 */
const DOUBLE_CAST_ALLOWLIST = new Set([
  "src/internal/adapters/session-store/ndjson.ts", // write side: fingerprint -> JsonObject
  "src/internal/subagent/subagent-tool.ts", // usage -> JsonObject at the journal sink
  "src/internal/subagent/runtime.ts", // heterogeneous record registry erasure
  "src/internal/surface/cli/subagent-sink.ts", // envelope -> JsonObject at the sink
]);

/** The fixture *provider* is a feature (test-mode provider), not a fake result. */
const FAKE_IMPORT_EXEMPT_SPECS = ["adapters/provider/fixture.js"];

const ambientRe = /\b(?:Date\.now|Math\.random)\b|\bprocess\.(?:env|exit|stdin|stdout|stderr)\b/;
const doubleCastRe = /\bas\s+unknown\s+as\b/;
const fakeBasenameRe = /^(?:fakes?|fake-[\w-]+|[\w-]+-fake|fixtures?)\.js$/;

function isCommentLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*");
}

function toPosix(p) {
  return p.replaceAll("\\", "/");
}

function walkFiles(dir) {
  const out = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

/**
 * Runs the three scans over `src/`. Returns every issue, plus the file count
 * for the pass message. Never silently skips: if the reachability analysis
 * (needed by the fake-import scan) cannot run, that is itself an issue.
 */
export function runStaticScans(root) {
  const issues = [];
  const srcFiles = walkFiles(join(root, "src")).filter(
    (f) => f.endsWith(".ts") && statSync(f).isFile(),
  );

  const reachRun = spawnSync(process.execPath, [join(root, "scripts", "quality", "reachability.mjs")], {
    capture: true,
    encoding: "utf8",
  });
  let reachableFiles;
  const reachPath = join(root, "dist", "reachability.json");
  if (reachRun.status !== 0 || !existsSync(reachPath)) {
    issues.push("reachability analysis failed; the fake-import scan cannot run and must not be skipped");
    reachableFiles = new Set();
  } else {
    const taxonomy = JSON.parse(readFileSync(reachPath, "utf8")).taxonomy;
    reachableFiles = new Set((taxonomy.production_reachable ?? []).map((f) => `src/${f}`));
  }

  for (const file of srcFiles) {
    const rel = toPosix(file.slice(root.length + 1));
    const isTest = file.endsWith(".test.ts");
    const text = readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes("@ts-ignore")) {
        issues.push(`${rel}:${i + 1}: contains @ts-ignore`);
      }
      if (/catch\s*(\([^\)]*\))?\s*\{\s*\}/.test(line)) {
        issues.push(`${rel}:${i + 1}: contains literal empty catch block`);
      }
      if (!isCommentLine(line)) {
        if (/:\s*any\b/.test(line) || /\bas\s+any\b/.test(line)) {
          issues.push(`${rel}:${i + 1}: contains 'any' type assertion`);
        }
        // Ambient sources, production files only: tests legitimately use
        // bounded wall-clock polls and process fixtures — their determinism
        // is judged by review (the P0 blocker on time-dependent tests), not
        // by grep. Clocks and randomness may appear in production code only
        // as the default of an injection seam (`?? ...` on the same line);
        // process surfaces only in the allowlisted files.
        if (!isTest && ambientRe.test(line)) {
          const clockOrRandom = /\b(?:Date\.now|Math\.random)\b/.test(line);
          const isInjectionDefault = clockOrRandom && line.includes("??");
          if (!isInjectionDefault && !AMBIENT_FILE_ALLOWLIST.has(rel)) {
            issues.push(
              `${rel}:${i + 1}: ambient source outside a seam or the allowlist (inject it, or extend the allowlist with a reason)`,
            );
          }
        }
        // Double casts: allowed only at listed boundaries.
        if (!isTest && doubleCastRe.test(line) && !DOUBLE_CAST_ALLOWLIST.has(rel)) {
          issues.push(`${rel}:${i + 1}: 'as unknown as' outside the boundary allowlist`);
        }
      }
    }

    // Fakes in production: a reachable file importing a fake/fixture module
    // wires a stand-in into the live path — the exact shape of the 2026-09
    // tooling landmines, and of the W1 barrel that pulled memory-fake in.
    // Test files and the fixture provider are exempt.
    if (!isTest && reachableFiles.has(rel)) {
      for (const match of text.matchAll(importRe)) {
        const spec = match[1] ?? "";
        const basename = spec.split("/").pop() ?? "";
        if (
          fakeBasenameRe.test(basename) &&
          !FAKE_IMPORT_EXEMPT_SPECS.some((exempt) => spec.endsWith(exempt))
        ) {
          issues.push(`${rel}: production-reachable file imports the fake module '${spec}'`);
        }
      }
    }
  }

  return { issues, fileCount: srcFiles.length };
}
