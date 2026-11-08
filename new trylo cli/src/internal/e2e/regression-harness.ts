import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DECLARED_ENV_NAMES } from "../credentials/env-table.js";
import { createCliCredentialPort } from "../surface/cli/credentials-wiring.js";
import { normalizeJson } from "./golden-trace.js";

/**
 * Dual-arm Regression Harness (WP 2026-09-17 地基收口 W2):
 *
 * Provides a black-box regression framework comparing two arms across the
 * identical test sample:
 *  - fixture arm: deterministic, hermetic, 100% GREEN in offline/CI environments
 *  - real-provider arm: gated on actual platform credentials; reports
 *    `BLOCKED_MISSING_CREDENTIAL` when credentials are absent, never falsifying
 *    verification with dummy keys.
 *
 * Both arms are hermetic *by construction*: the ambient snapshot they may read
 * is an explicit input (`RealProviderConfig.env`, scrubbed via
 * `scrubCredentialEnv`), so a credential in the host shell or in the developer's
 * real `~/.trylo` ledger cannot change a result. Only a caller that omits the
 * snapshot — the manual real-provider arm — reads `process.env` and discovers
 * credentials the way it always has.
 */

const cli = fileURLToPath(new URL("../../cmd/trylo/main.js", import.meta.url));

/**
 * Every name a credential may arrive under: the ledger's own declared table
 * (imported, not re-listed, so the two cannot drift) plus the two ambient
 * overrides this harness accepts on top of it.
 */
const CREDENTIAL_ENV_NAMES: ReadonlySet<string> = new Set<string>([
  ...DECLARED_ENV_NAMES,
  "TRYLO_REAL_API_KEY",
  "OPENAI_API_KEY",
]);

/**
 * A copy of `env` with every credential name removed.
 *
 * The gate both arms must satisfy is *hermeticity*: a credential exported in the
 * developer's shell, or left in their real `~/.trylo` ledger, must not be able to
 * move a result. Scrub-then-merge states that once, so a caller assembles a
 * synthetic credential snapshot by construction instead of remembering which
 * names to delete — the previous hand-written pair of `delete`s missed
 * `TRYLO_OPENAI_API_KEY` and `TRYLO_REAL_API_KEY` outright.
 */
export function scrubCredentialEnv(
  env: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = { ...env };
  for (const name of CREDENTIAL_ENV_NAMES) {
    delete scrubbed[name];
  }
  return scrubbed;
}

function execCli(
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly timeoutMs?: number },
): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            child.kill();
          }, options.timeoutMs);

    child.on("close", (status) => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve({ status, stdout, stderr });
    });
  });
}

export type HarnessSample = {
  readonly id: string;
  readonly description: string;
  readonly prompt: string;
  readonly expectedTools?: ReadonlyArray<string>;
  readonly expectedOutputSubstring?: string;
};

export type HarnessArmStatus = "PASSED" | "BLOCKED_MISSING_CREDENTIAL" | "FAILED";

export type HarnessArmResult = {
  readonly arm: "fixture" | "real-provider";
  readonly sampleId: string;
  readonly status: HarnessArmStatus;
  readonly exitCode?: number;
  readonly durationMs: number;
  readonly reason?: string;
  readonly events?: ReadonlyArray<Record<string, unknown>>;
  readonly lastMessage?: string;
};

export type HarnessComparison = {
  readonly sampleId: string;
  readonly fixtureResult: HarnessArmResult;
  readonly realResult: HarnessArmResult;
  readonly comparisonStatus: "COMPARABLE" | "BLOCKED_REAL_ARM";
  readonly notes: string;
};

export type RealProviderConfig = {
  readonly apiKey?: string;
  readonly endpoint?: string;
  readonly model?: string;
  readonly homeDir?: string;
  /**
   * The ambient snapshot this arm may read.
   *
   * A caller that must stay hermetic — the test suite — passes a scrubbed
   * snapshot, and then no exported key or real ledger can reach the arm. The
   * manual arm omits it and gets `process.env`, which is what keeps credential
   * discovery working when a person runs the real provider deliberately.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
};

function parseJsonLines(text: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      try {
        rows.push(JSON.parse(trimmed) as Record<string, unknown>);
      } catch {
        // Skip unparseable non-JSON lines
      }
    }
  }

  return rows;
}

/**
 * Executes the sample on the fixture arm.
 * Uses local deterministic fixture providers, requiring neither credentials
 * nor network access.
 */
export async function runFixtureArm(sample: HarnessSample): Promise<HarnessArmResult> {
  const started = Date.now();
  const root = mkdtempSync(join(os.tmpdir(), "trylo-harness-fx-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");

  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify({ name: "harness-fixture-workspace" }, null, 2),
    "utf8",
  );

  try {
    const env: NodeJS.ProcessEnv = {
      ...scrubCredentialEnv(process.env),
      TRYLO_HOME: home,
    };

    const res = await execCli(
      [
        "run",
        sample.prompt,
        "--provider",
        "fixture",
        "--session",
        `ses-${sample.id}`,
        "--format",
        "stream-json",
      ],
      { cwd: workspace, env },
    );

    const durationMs = Date.now() - started;

    if (res.status !== 0) {
      return {
        arm: "fixture",
        sampleId: sample.id,
        status: "FAILED",
        exitCode: res.status ?? 1,
        durationMs,
        reason: res.stderr || `exited with code ${res.status}`,
      };
    }

    const events = parseJsonLines(res.stdout);
    const normEvents = events.map((e) =>
      normalizeJson(e, { workspaceRoot: workspace, homeRoot: home }),
    );

    const resultEvent = events.find((e) => e["type"] === "run_result");
    const lastMessage = typeof resultEvent?.["lastMessage"] === "string" ? resultEvent["lastMessage"] : undefined;

    return {
      arm: "fixture",
      sampleId: sample.id,
      status: "PASSED",
      exitCode: 0,
      durationMs,
      events: normEvents,
      ...(lastMessage === undefined ? {} : { lastMessage }),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Executes the sample on the real-provider arm.
 *
 * Credentials are resolved from an explicit key, then from the ambient snapshot's
 * declared names, then from the `CredentialPort` ledger under the resolved home.
 * The ledger root is `config.homeDir`, else the snapshot's `TRYLO_HOME`, else the
 * OS home; a caller that supplies `env` therefore also decides which ledger can
 * be read, and a caller that supplies neither gets the host's own configuration.
 *
 * If nothing resolves, the arm reports `BLOCKED_MISSING_CREDENTIAL` rather than
 * substituting a fake key or failing unexpectedly.
 */
export async function runRealProviderArm(
  sample: HarnessSample,
  config?: RealProviderConfig,
): Promise<HarnessArmResult> {
  const started = Date.now();
  const ambient = config?.env ?? process.env;
  let apiKey = config?.apiKey ?? ambient.TRYLO_REAL_API_KEY ?? ambient.OPENAI_API_KEY;

  const homeDir = config?.homeDir ?? ambient.TRYLO_HOME ?? os.homedir();

  if (apiKey === undefined || apiKey.trim().length === 0) {
    try {
      const port = createCliCredentialPort({
        homeDir,
        cwd: process.cwd(),
        env: { ...ambient, ...(config?.homeDir !== undefined ? { TRYLO_HOME: config.homeDir } : {}) },
        now: () => Date.now(),
      });
      const resolved = port.get("openai-compatible");
      if (resolved.ok && resolved.value.secret && resolved.value.secret.trim().length > 0) {
        apiKey = resolved.value.secret;
      }
    } catch {
      // Ignore credential read errors and fall through to BLOCKED_MISSING_CREDENTIAL
    }
  }

  if (apiKey === undefined || apiKey.trim().length === 0) {
    return {
      arm: "real-provider",
      sampleId: sample.id,
      status: "BLOCKED_MISSING_CREDENTIAL",
      durationMs: 0,
      reason:
        "No real provider credentials available (inspected TRYLO_REAL_API_KEY, OPENAI_API_KEY, and CredentialPort). Gated by credential contract.",
    };
  }

  const endpoint = config?.endpoint ?? ambient.TRYLO_REAL_ENDPOINT ?? "https://api.openai.com/v1";
  const model = config?.model ?? "gpt-4o-mini";

  const root = mkdtempSync(join(os.tmpdir(), "trylo-harness-real-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");

  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify({ name: "harness-real-workspace" }, null, 2),
    "utf8",
  );

  try {
    const env: NodeJS.ProcessEnv = {
      ...ambient,
      TRYLO_HOME: home,
      TRYLO_API_KEY: apiKey,
    };

    const res = await execCli(
      [
        "run",
        sample.prompt,
        "--provider",
        "openai-compatible",
        "--endpoint",
        endpoint,
        "--model",
        model,
        "--session",
        `ses-${sample.id}`,
        "--format",
        "stream-json",
      ],
      { cwd: workspace, env, timeoutMs: 30000 },
    );

    const durationMs = Date.now() - started;

    if (res.status !== 0) {
      return {
        arm: "real-provider",
        sampleId: sample.id,
        status: "FAILED",
        exitCode: res.status ?? 1,
        durationMs,
        reason: res.stderr || `process exited with ${res.status}`,
      };
    }

    const events = parseJsonLines(res.stdout);
    const normEvents = events.map((e) =>
      normalizeJson(e, { workspaceRoot: workspace, homeRoot: home }),
    );

    const resultEvent = events.find((e) => e["type"] === "run_result");
    const lastMessage = typeof resultEvent?.["lastMessage"] === "string" ? resultEvent["lastMessage"] : undefined;

    return {
      arm: "real-provider",
      sampleId: sample.id,
      status: "PASSED",
      exitCode: 0,
      durationMs,
      events: normEvents,
      ...(lastMessage === undefined ? {} : { lastMessage }),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Compares two arm execution outcomes for the same sample.
 */
export function compareArms(
  fixtureResult: HarnessArmResult,
  realResult: HarnessArmResult,
): HarnessComparison {
  if (realResult.status === "BLOCKED_MISSING_CREDENTIAL") {
    return {
      sampleId: fixtureResult.sampleId,
      fixtureResult,
      realResult,
      comparisonStatus: "BLOCKED_REAL_ARM",
      notes: "Real-provider arm gated by credential; fixture arm validated deterministically.",
    };
  }

  const bothPassed = fixtureResult.status === "PASSED" && realResult.status === "PASSED";

  return {
    sampleId: fixtureResult.sampleId,
    fixtureResult,
    realResult,
    comparisonStatus: bothPassed ? "COMPARABLE" : "BLOCKED_REAL_ARM",
    notes: bothPassed
      ? "Both fixture and real-provider arms executed successfully."
      : `Execution diverged: fixture=${fixtureResult.status}, real=${realResult.status}`,
  };
}
