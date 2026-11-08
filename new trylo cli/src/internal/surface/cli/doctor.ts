import type { SettingsLayer } from "../../settings/layers.js";
import type { CheckStatus } from "./doctor-types.js";
import type { ProjectRulesReport } from "./project-rules-check.js";
import { decodeDocument } from "../../adapters/mcp-registry/document.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type { LearningSwitch } from "./args.js";
import {
  switchEnablesMethod,
  switchEnablesTool,
  switchEnablesUser,
} from "../../integration/user-learning/switch.js";
import { createCliCredentialPortWithReport, type CredentialWarning } from "./credentials-wiring.js";
import { methodBoardRoot } from "./learning-sink.js";
import { mcpRegistryPaths } from "./mcp-wiring.js";
import { userLearningCheck } from "./user-learning-doctor.js";
import { projectRulesCheck } from "./project-rules-check.js";
import { toolLearningCheck } from "./tool-learning-doctor.js";
import { tryloHome } from "./session-paths.js";
import { loadConfig, type ConfigLoadIo, type LayerSource } from "./config-load.js";
import {
  credentialCheck,
  declaredCapabilityCheck,
  providerCheck,
  resolveSelectedProvider,
} from "./doctor-provider.js";

/**
 * Read-only diagnostics.
 *
 * Doctor never repairs, never starts a resident process and never executes a
 * program it found on PATH. Every answer is a stat, a read or pure arithmetic,
 * and the same structured report backs both the human and the JSON rendering —
 * so the two can never disagree.
 */

export type { CheckStatus } from "./doctor-types.js";

export type DoctorCheck = {
  readonly id: string;
  readonly status: CheckStatus;
  readonly detail: string;
};

export type DoctorReport = {
  readonly checks: ReadonlyArray<DoctorCheck>;
  readonly toolCatalogHash: string;
  readonly sessionsDir: string;
};

export type DoctorIo = {
  readonly readFile: (absolutePath: string) => string | undefined;
  readonly isDirectory: (absolutePath: string) => boolean;
  readonly readDir: (
    absolutePath: string,
  ) => ReadonlyArray<{ readonly name: string; readonly bytes: number; readonly modifiedAtMs: number }>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly nodeVersion: string;
  /** Milliseconds since the epoch; the ledger binding stamps writes with it. */
  readonly now: () => number;
};

const MINIMUM_NODE_MAJOR = 20;

/** The five layers, lowest precedence first. `system` is reported even when this
 *  machine has no managed directory: "not evaluated" is an honest answer. */
const REPORTED_LAYERS: ReadonlyArray<SettingsLayer> = [
  "packaged_default",
  "system",
  "user",
  "project",
  "cli_flag",
];

function sourceCheck(layer: SettingsLayer, sources: ReadonlyArray<LayerSource>): DoctorCheck {
  const source = sources.find((item) => item.layer === layer);
  if (source === undefined) {
    return { id: `config.${layer}`, status: "skip", detail: "not evaluated" };
  }

  if (source.status === "missing") {
    return { id: `config.${layer}`, status: "ok", detail: `${source.path ?? ""} not present (optional)` };
  }

  if (source.status === "invalid") {
    return { id: `config.${layer}`, status: "fail", detail: `${source.path ?? ""}: ${source.detail ?? "invalid"}` };
  }

  return { id: `config.${layer}`, status: "ok", detail: source.path ?? "packaged" };
}

export type DoctorOptions = {
  readonly toolCatalogHash: string;
  readonly sessionsDir: string;
  /**
   * The project rules this workspace's runs would adopt, already resolved by
   * `projectContextFor` (WP-CLI-B1 §3.3).
   *
   * Passed in rather than resolved here on purpose. A doctor that walked for
   * rule files itself would be a second walk, and the two would disagree
   * exactly when it matters: a run started with `--workspace sub` adopts `sub`'s
   * rules, and a doctor that quietly used `cwd` would report the parent
   * project's file — a diagnostic contradicting the request it is meant to
   * explain. One resolver, one answer.
   */
  readonly projectRules?: ProjectRulesReport;
  /**
   * Where a credential-backend degradation is reported. Absent means this caller
   * does not surface one — a caller that builds its options by hand (a test, a
   * future embedding) rather than the CLI, which always passes one.
   */
  /**
   * The `--learning` switch, when one was passed. Absent — which is every
   * default path — means this check reports exactly what it reported before the
   * switch existed (D6): the zero-difference gate covers `doctor` too.
   */
  readonly learning?: LearningSwitch;
  readonly warn?: CredentialWarning;
};

export function collectDoctor(io: DoctorIo, options: DoctorOptions): DoctorReport {
  const configIo: ConfigLoadIo = {
    readFile: io.readFile,
    profileDir: tryloHome(io.homeDir, io.env),
    cwd: io.cwd,
  };
  const loaded = loadConfig(configIo, {});
  const checks: DoctorCheck[] = [];

  const major = Number.parseInt(io.nodeVersion.replace(/^v/, "").split(".")[0] ?? "0", 10);

  checks.push({
    id: "runtime.node",
    status: major >= MINIMUM_NODE_MAJOR ? "ok" : "fail",
    detail: `${io.nodeVersion} (need >= ${MINIMUM_NODE_MAJOR})`,
  });
  checks.push({
    id: "workspace.root",
    status: io.isDirectory(io.workspaceRoot) ? "ok" : "fail",
    detail: io.workspaceRoot,
  });
  checks.push({
    id: "workspace.tools",
    status: "ok",
    detail: `read_only catalog ${options.toolCatalogHash}`,
  });

  if (!loaded.ok) {
    checks.push({
      id: `config.${loaded.failure.layer}`,
      status: "fail",
      detail: `${loaded.failure.path ?? loaded.failure.layer}: ${loaded.failure.detail}`,
    });
  } else {
    for (const layer of REPORTED_LAYERS) {
      checks.push(sourceCheck(layer, loaded.sources));
    }

    checks.push({
      id: "provider.fixture",
      status: "ok",
      detail: "offline deterministic provider available",
    });
    // Resolved the way a run resolves it — declaration `selected` first, then the
    // config value — because a doctor that read only the config would keep saying
    // "fixture" after `providers switch` had selected something else, and the one
    // diagnostic meant to be believed would be the lie.
    const selection = resolveSelectedProvider(io, loaded.resolved);
    const provider = selection === undefined ? "fixture" : selection.providerId;
    const model = selection === undefined ? "default" : selection.model;

    checks.push(providerCheck(provider, model, selection, loaded));
    const capability = declaredCapabilityCheck(io);
    if (capability !== undefined) {
      checks.push(capability);
    }

    checks.push(
      credentialCheck(
        createCliCredentialPortWithReport(io, options.warn ?? ((): void => {})),
        provider,
        io.now,
      ),
    );
  }

  checks.push(learningCheck(io, options.learning));

  // The user half of the switch, reported only when the switch named it. The
  // line above stays the same sentence in every other case — including
  // `--learning=method`, where it is still true *and* still the only learning
  // line a method-only run has ever printed (the zero-difference gate counts
  // `doctor`'s output, so a second line appearing without being asked for would
  // be a regression, not an improvement).
  if (options.learning !== undefined && switchEnablesUser(options.learning)) {
    checks.push(userLearningCheck(io, options.learning));
  }

  // The tool-learning half, on the same terms: it appears only when the switch
  // named it, and it reports counts rather than the model's own sentences.
  if (options.learning !== undefined && switchEnablesTool(options.learning)) {
    checks.push(toolLearningCheck(io, options.learning));
  }

  checks.push(mcpRegistryCheck(io));
  // Reported from the source list the run adopts, never from a fresh walk. A
  // `fail` here is `doctor` exiting 52, which is the right weight for "this
  // project states rules your run cannot read".
  checks.push(projectRulesCheck(options.projectRules?.sources, options.projectRules?.problems));
  checks.push({
    id: "sessions.dir",
    status: io.isDirectory(options.sessionsDir) ? "ok" : "skip",
    detail: io.isDirectory(options.sessionsDir)
      ? `${options.sessionsDir} (${io.readDir(options.sessionsDir).length} file entries)`
      : `${options.sessionsDir} is created on the first --session run`,
  });

  return { checks, toolCatalogHash: options.toolCatalogHash, sessionsDir: options.sessionsDir };
}

/**
 * The learning check, in two branches that are deliberately unequal.
 *
 * The default branch is byte-for-byte the sentence this check always printed:
 * the zero-difference gate (I1) is a promise about `doctor`'s output too, and a
 * user who never asked for learning must not see a different diagnostic just
 * because a switch now exists. That sentence is *also* what `--learning=user`
 * prints, and it is still true there — the packaged profile really is the
 * learning-free one and P01 activation really is not consumed; what the switch
 * added is the ledger, and `user-learning-doctor.ts` is where that is reported.
 *
 * Only a switch that actually turns the method half on says more — and what it
 * says is the one fact worth saying: the board is wired, and *where* its
 * archive lives. The root is asked of the same formula the composition root
 * uses (`learning-sink.ts`), and `LA-RUN`'s end-to-end proves they agree by
 * checking the board really writes there.
 */
function learningCheck(io: DoctorIo, learning: LearningSwitch | undefined): DoctorCheck {
  if (learning === undefined || !switchEnablesMethod(learning)) {
    return {
      id: "learning.isolation",
      status: "ok",
      detail: "packaged no_learning profile; P01 activation is not consumed",
    };
  }
  return {
    id: "learning.isolation",
    status: "ok",
    detail: `method learning wired (board root: ${methodBoardRoot(io.homeDir, io.env)})`,
  };
}

/**
 * The MCP registry, read and reported — never exercised.
 *
 * Doctor's rule is that it never starts a program it found, and the MCP
 * registry is exactly the kind of file that makes that rule load-bearing: every
 * entry names a command. So this check asks the *document* what it holds — two
 * reads and a pure decode — and stops there. Whether any of those servers
 * answers is a connect-time fact, and the place a user sees it is a run's own
 * warnings, not a diagnostic command that would have to spawn them to know.
 *
 * A file that cannot be decoded is a `fail` rather than a `skip`: the registry
 * is the only record of what the user configured, and a broken one means the
 * next `mcp add` would clobber whatever it really said.
 */
function mcpRegistryCheck(io: DoctorIo): DoctorCheck {
  const paths = mcpRegistryPaths({ homeDir: io.homeDir, cwd: io.cwd, env: io.env });
  const scopes: ReadonlyArray<{ readonly scope: string; readonly file: string }> = [
    { scope: "user", file: paths.userFile },
    { scope: "project", file: paths.projectFile },
  ];
  const unreadable: string[] = [];
  let total = 0;
  let enabled = 0;

  for (const entry of scopes) {
    const raw = io.readFile(entry.file);
    if (raw === undefined) {
      continue;
    }

    const decoded = decodeDocument(raw, entry.file);
    if (!decoded.ok) {
      unreadable.push(`${entry.scope}:${decoded.code}`);
      continue;
    }

    total += decoded.value.servers.length;
    enabled += decoded.value.servers.filter((server) => server.enabled).length;
  }

  if (unreadable.length > 0) {
    return { id: "mcp.registry", status: "fail", detail: `unreadable (${unreadable.join(", ")})` };
  }

  if (total === 0) {
    return { id: "mcp.registry", status: "skip", detail: "no MCP servers registered" };
  }

  return {
    id: "mcp.registry",
    status: "ok",
    detail: `${enabled}/${total} enabled; whether they answer is reported by the run that opens them`,
  };
}



export function doctorExitCode(report: DoctorReport): ExitCode {
  return report.checks.some((check) => check.status === "fail") ? EXIT_CODES.CONFIG : EXIT_CODES.OK;
}

export function renderDoctorText(report: DoctorReport): string {
  return report.checks.map((check) => `${check.status.toUpperCase().padEnd(4)} ${check.id}  ${check.detail}`).join("\n");
}
