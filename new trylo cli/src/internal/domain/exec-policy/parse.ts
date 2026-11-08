import { parseExecDecision } from "./decision.js";
import { parsePatternTokens } from "./pattern.js";
import type { ExecPolicy } from "./policy.js";
import { executableBasename, matchPrefixRule, type PrefixRule } from "./rule.js";

/**
 * Turning an operator's policy document into a policy.
 *
 * Source of the semantics: Codex `execpolicy/src/parser.rs` at commit
 * `73a1148c9c775c2a4616ce5096291740a00ed68a`. Upstream writes these rules in
 * Starlark; this leaves that dialect out and keeps everything else — the three
 * shape checks, the *examples must actually match* self-verification, and the
 * expansion of an alternative first token into one rule per alternative.
 *
 * Examples are given as argument arrays rather than command strings. A second
 * command-line splitter would be a second opinion about quoting, and the two
 * would eventually disagree about something that matters; the one that already
 * exists (`adapters/sandbox/command.ts`) belongs to the shell boundary, not
 * here.
 *
 * `host_executable` names must be bare names with no extension, which is one
 * step stricter than upstream's "one path component": accepting `python.exe`
 * there would leave two different spellings of the same program fighting over
 * one lookup key, and the operator's own rules would then silently stop
 * covering the spelling they wrote.
 */

export type SourcePlatform = "posix" | "windows";

/** A pattern word: a string matches exactly, an array offers alternatives. */
export type PolicyPatternWord = string | ReadonlyArray<string>;

export type PolicyRuleSource = {
  readonly pattern: ReadonlyArray<PolicyPatternWord>;
  readonly decision: string;
  readonly justification?: string;
  /** Commands this rule must match — proof that it does what it says. */
  readonly match?: ReadonlyArray<ReadonlyArray<string>>;
  /** Commands it must not match — proof that it is not wider than it says. */
  readonly notMatch?: ReadonlyArray<ReadonlyArray<string>>;
};

export type PolicyHostExecutableSource = {
  readonly name: string;
  readonly paths: ReadonlyArray<string>;
};

export type PolicySource = {
  readonly rules: ReadonlyArray<PolicyRuleSource>;
  readonly hostExecutables?: ReadonlyArray<PolicyHostExecutableSource>;
};

export type PolicyParseFailure = {
  /** Index into `source.rules`, or -1 for a host-executable entry. */
  readonly rule: number;
  readonly message: string;
};

export type PolicyParseResult =
  | { readonly ok: true; readonly policy: ExecPolicy }
  | { readonly ok: false; readonly failures: ReadonlyArray<PolicyParseFailure> };

type RuleBuild =
  | { readonly ok: true; readonly rules: ReadonlyArray<PrefixRule> }
  | { readonly ok: false; readonly message: string };

const EMPTY_JUSTIFICATION = Symbol("empty justification");

/**
 * A whitespace-only `justification` is refused rather than stored: it renders
 * as though a reason were missing while looking as though one were given, and
 * that gap is exactly the operator's ability to review what was decided.
 */
function readJustification(raw: string | undefined): string | undefined | typeof EMPTY_JUSTIFICATION {
  if (raw === undefined) {
    return undefined;
  }
  return raw.trim().length === 0 ? EMPTY_JUSTIFICATION : raw;
}

/**
 * One written rule becomes one rule per alternative head word. The lookup key
 * is always a single word, so downstream never has to guess where a rule lives.
 */
function buildRules(source: PolicyRuleSource): RuleBuild {
  const decision = parseExecDecision(source.decision);
  if (!decision.ok) {
    return { ok: false, message: decision.message };
  }

  const justification = readJustification(source.justification);
  if (justification === EMPTY_JUSTIFICATION) {
    return { ok: false, message: "justification cannot be empty" };
  }

  const tokens = parsePatternTokens(source.pattern);
  if (!tokens.ok) {
    return { ok: false, message: tokens.message };
  }

  const head = tokens.tokens[0];
  const rest = tokens.tokens.slice(1);

  if (head === undefined) {
    return { ok: false, message: "pattern cannot be empty" };
  }

  const heads = head.kind === "single" ? [head.text] : head.texts;

  return {
    ok: true,
    rules: heads.map((first) => ({
      kind: "prefix" as const,
      decision: decision.decision,
      pattern: { first, rest },
      ...(justification === undefined ? {} : { justification }),
    })),
  };
}

function rulesMatch(argv: ReadonlyArray<string>, rules: ReadonlyArray<PrefixRule>): boolean {
  return rules.some((rule) => matchPrefixRule(rule, argv) !== undefined);
}

/**
 * Examples are checked rather than trusted.
 *
 * A rule that cannot match the command it was written for does nothing while
 * looking like protection; a rule that matches something unintended is worse
 * than a rule that was never written. Both fail the load instead of quietly
 * changing what the policy means.
 */
function exampleFailures(
  rules: ReadonlyArray<PrefixRule>,
  source: PolicyRuleSource,
): ReadonlyArray<string> {
  const failures: string[] = [];
  const ownPolicy = new Map<string, PrefixRule[]>();

  for (const rule of rules) {
    ownPolicy.set(rule.pattern.first, [...(ownPolicy.get(rule.pattern.first) ?? []), rule]);
  }

  for (const example of source.match ?? []) {
    const rulesForKey = ownPolicy.get(example[0] ?? "");
    if (rulesForKey === undefined || !rulesMatch(example, rulesForKey)) {
      failures.push(`match example ${JSON.stringify(example)} is not matched by this rule`);
    }
  }

  for (const example of source.notMatch ?? []) {
    const rulesForKey = ownPolicy.get(example[0] ?? "");
    if (rulesForKey !== undefined && rulesMatch(example, rulesForKey)) {
      failures.push(`not_match example ${JSON.stringify(example)} is matched by this rule`);
    }
  }

  return failures;
}

function hostExecutableFailure(
  entry: PolicyHostExecutableSource,
  platform: SourcePlatform,
): string | undefined {
  if (entry.name.length === 0) {
    return `host_executable name must be a bare executable name without an extension (got "${entry.name}")`;
  }

  const key = executableBasename(entry.name, platform);
  if (key !== entry.name) {
    return `host_executable name must be a bare executable name without an extension (got "${entry.name}")`;
  }

  for (const candidate of entry.paths) {
    if (!isAbsolutePath(candidate, platform)) {
      return `host_executable paths must be absolute (got "${candidate}")`;
    }
    if (executableBasename(candidate, platform) !== key) {
      return `host_executable path "${candidate}" must have basename "${entry.name}"`;
    }
  }

  return undefined;
}

function isAbsolutePath(raw: string, platform: SourcePlatform): boolean {
  return platform === "windows"
    ? /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\") || raw.startsWith("/")
    : raw.startsWith("/");
}

export function parseExecPolicyDocument(
  source: PolicySource,
  platform: SourcePlatform,
): PolicyParseResult {
  const failures: PolicyParseFailure[] = [];
  const rulesByProgram = new Map<string, PrefixRule[]>();

  source.rules.forEach((ruleSource, index) => {
    const built = buildRules(ruleSource);
    if (!built.ok) {
      failures.push({ rule: index, message: built.message });
      return;
    }

    for (const rule of built.rules) {
      const existing = rulesByProgram.get(rule.pattern.first) ?? [];
      rulesByProgram.set(rule.pattern.first, [...existing, rule]);
    }

    for (const message of exampleFailures(built.rules, ruleSource)) {
      failures.push({ rule: index, message });
    }
  });

  const hostExecutables = new Map<string, string[]>();

  for (const entry of source.hostExecutables ?? []) {
    const failure = hostExecutableFailure(entry, platform);
    if (failure === undefined) {
      hostExecutables.set(entry.name, [...new Set(entry.paths)]);
    } else {
      failures.push({ rule: -1, message: failure });
    }
  }

  if (failures.length > 0) {
    return { ok: false, failures };
  }

  return { ok: true, policy: { rulesByProgram, hostExecutables } };
}
