import type { ExecDecision } from "./decision.js";
import { executableBasename } from "./rule.js";

/**
 * What to do with a command no rule matched, and the one hard-coded danger
 * signal that must never be met with silence.
 *
 * Source of the danger semantics: Codex
 * `shell-command/src/command_safety/is_dangerous_command.rs` at commit
 * `73a1148c9c775c2a4616ce5096291740a00ed68a`. The wrapper unwrapping and the
 * depth cap are copied; the shell-literal expansion is **not** (see below).
 */

/** Where a heuristics sourcefit ends and a guess begins, copied from upstream. */
export const MAX_DANGEROUS_WRAPPER_DEPTH = 8;

export type DangerousCommandMatch = "forced_rm" | "other";

/**
 * `rm -f`, `rm -rf`, `rm --force` and `rm /tmp/x -f` are all one fact: the
 * operator asked for deletion that does not stop to be asked. `--` ends the
 * option section, so `rm -- -f` removes a file called `-f` and is not forced.
 */
export function rmArgsIncludeForce(args: ReadonlyArray<string>): boolean {
  for (const arg of args) {
    if (arg === "--") {
      return false;
    }

    if (arg === "--force") {
      return true;
    }

    if (arg.startsWith("-") && !arg.startsWith("--") && arg.includes("f")) {
      return true;
    }
  }
  return false;
}

/**
 * Skips the leading flags and `NAME=VALUE` assignments `env` accepts, leaving
 * the command it is being used to launch. `--` ends them explicitly, and an
 * argument that is none of those is the program.
 */
function skipEnvPreamble(args: ReadonlyArray<string>): ReadonlyArray<string> {
  let index = 0;

  while (index < args.length) {
    const arg = args[index];
    if (arg === "--") {
      return args.slice(index + 1);
    }

    const isIgnore = arg === "-i" || arg === "--ignore-environment";
    const isAssignment =
      arg !== undefined && arg.includes("=") && arg.startsWith("-") === false && arg.split("=")[0]?.length !== 0;
    if (!isIgnore && !isAssignment) {
      return args.slice(index);
    }

    index += 1;
  }

  return [];
}

/** `trap`'s action is shell source in its first operand; it is re-read as such. */
function trapAction(argv: ReadonlyArray<string>): string | undefined {
  let index = 1;
  if (argv[index] === "--") {
    index += 1;
  }
  const action = argv[index];
  return action === undefined || action.startsWith("-") ? undefined : action;
}

export function dangerousCommandMatch(
  argv: ReadonlyArray<string>,
  platform: "posix" | "windows",
): DangerousCommandMatch | undefined {
  return dangerousCommandMatchAtDepth(argv, 0, platform);
}

function dangerousCommandMatchAtDepth(
  argv: ReadonlyArray<string>,
  depth: number,
  platform: "posix" | "windows",
): DangerousCommandMatch | undefined {
  // Past the cap we stop understanding the command, and "I stopped
  // understanding it" is not allowed to read as "I checked it and it is fine".
  if (depth > MAX_DANGEROUS_WRAPPER_DEPTH) {
    return "other";
  }

  const head = argv[0];
  if (head === undefined) {
    return undefined;
  }

  const program = executableBasename(head, platform);

  if (program === "rm" && rmArgsIncludeForce(argv.slice(1))) {
    return "forced_rm";
  }

  const inner = (rest: ReadonlyArray<string>): DangerousCommandMatch | undefined =>
    dangerousCommandMatchAtDepth(rest, depth + 1, platform);

  // `sudo rm -rf x` is the dangerous command wearing a hat, so check the wearer
  // rather than stopping at `sudo`.
  if (program === "sudo") {
    return inner(argv.slice(1));
  }

  if (program === "env") {
    return inner(skipEnvPreamble(argv.slice(1)));
  }

  if (program === "trap") {
    const action = trapAction(argv);
    return action === undefined ? undefined : inner(["sh", "-c", action]);
  }

  return undefined;
}

/**
 * How much the host is prepared to be asked, named after the three upstream
 * answers rather than after any one interface so this layer never owns the
 * answer to "who decides".
 */
export type ApprovalPosture = "never" | "on_request" | "unless_trusted";

export type UnmatchedCommandInput = {
  readonly dangerous: boolean;
  readonly posture: ApprovalPosture;
  /** The call asks for something the sandbox would have to be relaxed to give. */
  readonly requestsSandboxOverride: boolean;
};

/**
 * The fallback decision for a command no rule matched.
 *
 * One deliberate divergence from upstream, and it is the safety-critical one:
 * with `never`, Codex answers `allow` because a real OS sandbox is standing
 * behind the command. This package has no OS sandbox — its restricted network
 * mode strips proxy variables and nothing more — so answering `allow` here
 * would be copying the permission without copying the protection. The existing
 * Trylo CLI already answers a non-interactive run with a refusal, and this
 * keeps that: importing an implementation never widens what the host allows.
 */
export function unmatchedCommandDecision(input: UnmatchedCommandInput): ExecDecision {
  if (input.dangerous) {
    return input.posture === "never" ? "forbidden" : "prompt";
  }
  switch (input.posture) {
    case "never":
      return "forbidden";
    case "unless_trusted":
      return "prompt";
    case "on_request":
      return input.requestsSandboxOverride ? "prompt" : "allow";
  }
}
