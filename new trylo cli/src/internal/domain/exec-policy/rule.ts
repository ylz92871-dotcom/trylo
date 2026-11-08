import type { ExecDecision } from "./decision.js";
import { matchPrefix, type PrefixPattern } from "./pattern.js";

/**
 * What a matched rule reports, and the executable-name semantics that let a
 * rule written for `python` also apply to `/usr/bin/python3.11`.
 *
 * Source of the semantics: Codex `execpolicy/src/rule.rs` and
 * `execpolicy/src/executable_name.rs` at commit
 * `73a1148c9c775c2a4616ce5096291740a00ed68a`.
 */

/**
 * Why the rule exists, rendered wherever the decision is rendered. It is
 * optional upstream but required here the moment a rule takes away a human's
 * say: an operator reading "forbidden" with no reason has no way to tell a
 * deliberate boundary from a stale policy.
 */
export type ExecRule = {
  readonly decision: ExecDecision;
  readonly justification?: string;
};

export type PrefixRule = ExecRule & {
  readonly kind: "prefix";
  readonly pattern: PrefixPattern;
};

export type RuleMatch =
  | {
      readonly kind: "prefix";
      readonly matchedPrefix: ReadonlyArray<string>;
      readonly decision: ExecDecision;
      readonly justification?: string;
      /** Set when the rule was reached through an absolute executable path. */
      readonly resolvedProgram?: string;
    }
  | {
      readonly kind: "heuristics";
      readonly command: ReadonlyArray<string>;
      readonly decision: ExecDecision;
    };

export function matchDecision(match: RuleMatch): ExecDecision {
  return match.decision;
}

/** A rule said something about this command; heuristics are not a rule. */
export function isRuleMatch(match: RuleMatch): boolean {
  return match.kind === "prefix";
}

export function matchPrefixRule(
  rule: PrefixRule,
  argv: ReadonlyArray<string>,
  resolvedProgram?: string,
): RuleMatch | undefined {
  const matchedPrefix = matchPrefix(rule.pattern, argv);
  if (matchedPrefix === undefined) {
    return undefined;
  }

  return {
    kind: "prefix",
    matchedPrefix,
    decision: rule.decision,
    ...(rule.justification === undefined ? {} : { justification: rule.justification }),
    ...(resolvedProgram === undefined ? {} : { resolvedProgram }),
  };
}

const WINDOWS_EXECUTABLE_SUFFIXES = [".exe", ".cmd", ".bat", ".com"] as const;

/**
 * The key a rule is looked up under.
 *
 * Both halves matter on Windows: `node.exe`, `NODE.EXE` and `node` are the same
 * program, so case is folded and every extension this `Process` world accepts is
 * stripped. Without this, a rule written for `python` would silently stop
 * covering `python.exe`, which is the shape most invocations actually have.
 */
export function executableLookupKey(raw: string, platform: "posix" | "windows"): string {
  if (platform !== "windows") {
    return raw;
  }

  const lowered = raw.toLowerCase();

  for (const suffix of WINDOWS_EXECUTABLE_SUFFIXES) {
    if (lowered.endsWith(suffix)) {
      return lowered.slice(0, lowered.length - suffix.length);
    }
  }

  return lowered;
}

/**
 * `C:\tools\python.exe`, `/usr/bin/python` and `python` all answer to `python`.
 * A drive-prefixed token is handled because Windows accepts it as the first
 * word of a command, and stripping it is what makes the basename step correct.
 */
export function executableBasename(raw: string, platform: "posix" | "windows"): string | undefined {
  if (raw.length === 0) {
    return undefined;
  }

  const separators = platform === "windows" ? /[\\/]/ : /\//;
  const parts = raw.split(separators);
  const last = parts[parts.length - 1];
  if (last === undefined || last.length === 0) {
    return undefined;
  }

  const driveToken =
    platform === "windows" && last.length > 2 && /^[a-zA-Z]:/.test(last) ? last.slice(2) : last;
  const name = driveToken.length > 0 ? driveToken : last;

  return executableLookupKey(name, platform);
}
