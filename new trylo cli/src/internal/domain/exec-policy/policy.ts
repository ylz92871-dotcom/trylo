import { strictestOf, type ExecDecision } from "./decision.js";
import { matchDecision, matchPrefixRule, executableBasename, type PrefixRule, type RuleMatch } from "./rule.js";
import { renderPatternToken, type PrefixPattern } from "./pattern.js";

/**
 * Turning a set of prefix rules into one answer about one command.
 *
 * Source of the semantics: Codex `execpolicy/src/policy.rs` at commit
 * `73a1148c9c775c2a4616ce5096291740a00ed68a`. Two decisions are worth writing
 * down because they are the ones a reader would otherwise "simplify" into bugs:
 *
 *  1. Rules are keyed by the *first token*, so matching is a lookup, not a
 *     scan. A first token of alternatives becomes several rules when the policy
 *     is built (see `parse.ts`); the map key is always one word.
 *  2. Several rules can match at once, and the **most severe** wins
 *     (`strictestOf`). Individually harmless rules must not add up to
 *     permission.
 */

export type ExecPolicy = {
  readonly rulesByProgram: ReadonlyMap<string, ReadonlyArray<PrefixRule>>;
  /**
   * Absolute paths a program name is allowed to be found at. Declaring it here
   * narrows rather than widens: once declared, `/tmp/evil/python` no longer
   * inherits the rules written for `python`.
   */
  readonly hostExecutables: ReadonlyMap<string, ReadonlyArray<string>>;
};

export type ExecPolicyOptions = {
  readonly platform: "posix" | "windows";
  /** Honour `hostExecutables` when the command names its program by path. */
  readonly resolveHostExecutables: boolean;
};

/**
 * What the caller knows that this module does not — mostly "who is allowed to
 * decide here". It is injected rather than imported so that this file stays a
 * pure evaluator: the owner of the approval policy stays whoever owns it
 * today, and nothing here can quietly authorise a command by itself.
 */
export type HeuristicFallback = (argv: ReadonlyArray<string>) => ExecDecision;

export type ExecPolicyEvaluation = {
  readonly decision: ExecDecision;
  readonly matchedRules: ReadonlyArray<RuleMatch>;
};

/** True when a rule — not the fallback — said something. */
export function evaluationMatched(evaluation: ExecPolicyEvaluation): boolean {
  return evaluation.matchedRules.some((match) => match.kind === "prefix");
}

export const EMPTY_POLICY: ExecPolicy = {
  rulesByProgram: new Map(),
  hostExecutables: new Map(),
};

export function withPrefixRule(policy: ExecPolicy, rule: PrefixRule): ExecPolicy {
  const existing = policy.rulesByProgram.get(rule.pattern.first) ?? [];
  const rulesByProgram = new Map(policy.rulesByProgram);
  rulesByProgram.set(rule.pattern.first, [...existing, rule]);
  return { rulesByProgram, hostExecutables: policy.hostExecutables };
}

/**
 * Policies from several sources are combined additively. A later source cannot
 * remove a rule an earlier one added, which is the direction that keeps a
 * project-level "forbidden" standing when a personal policy is layered on top.
 */
export function mergeExecPolicy(base: ExecPolicy, overlay: ExecPolicy): ExecPolicy {
  const rulesByProgram = new Map(base.rulesByProgram);

  for (const [program, rules] of overlay.rulesByProgram) {
    rulesByProgram.set(program, [...(rulesByProgram.get(program) ?? []), ...rules]);
  }

  const hostExecutables = new Map(base.hostExecutables);

  for (const [name, paths] of overlay.hostExecutables) {
    hostExecutables.set(name, paths);
  }

  return { rulesByProgram, hostExecutables };
}

/** Every `allow`-ed prefix, for operator-facing output. Sorted and deduped. */
export function allowedPrefixes(policy: ExecPolicy): ReadonlyArray<ReadonlyArray<string>> {
  const byKey = new Map<string, ReadonlyArray<string>>();

  for (const rules of policy.rulesByProgram.values()) {
    for (const rule of rules) {
      if (rule.decision !== "allow") {
        continue;
      }
      const prefix = renderRulePrefix(rule.pattern);
      byKey.set(prefix.join(" "), prefix);
    }
  }

  return [...byKey.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([, prefix]) => prefix);
}

function renderRulePrefix(pattern: PrefixPattern): ReadonlyArray<string> {
  return [pattern.first, ...pattern.rest.map(renderPatternToken)];
}

function matchExactRules(
  policy: ExecPolicy,
  argv: ReadonlyArray<string>,
): ReadonlyArray<RuleMatch> {
  const head = argv[0];
  if (head === undefined) {
    return [];
  }

  const rules = policy.rulesByProgram.get(head) ?? [];

  return rules
    .map((rule) => matchPrefixRule(rule, argv))
    .filter((match): match is RuleMatch => match !== undefined);
}

/**
 * `/opt/homebrew/bin/python script.py` should answer to a rule written for
 * `python`. The basename stands in for the full path while matching, and the
 * real path is reported back so an operator sees *which* program ran — the
 * point of the rule is the program, and the path is the part that can differ.
 */
function matchHostExecutableRules(
  policy: ExecPolicy,
  argv: ReadonlyArray<string>,
  options: ExecPolicyOptions,
): ReadonlyArray<RuleMatch> {
  const head = argv[0];
  if (head === undefined) {
    return [];
  }

  const basename = executableBasename(head, options.platform);
  if (basename === undefined) {
    return [];
  }

  const rules = policy.rulesByProgram.get(basename);
  if (rules === undefined) {
    return [];
  }

  const declared = policy.hostExecutables.get(basename);
  if (declared !== undefined && !declared.includes(head)) {
    return [];
  }

  const rewritten = [basename, ...argv.slice(1)];

  return rules
    .map((rule) => matchPrefixRule(rule, rewritten, head))
    .filter((match): match is RuleMatch => match !== undefined);
}

/**
 * Every rule that applies, in no meaningful order. Empty when the policy has no
 * opinion about this command — which is a different fact from "allowed", and
 * the reason {@link evaluateExecPolicy} takes a fallback rather than assuming.
 */
export function matchesForCommand(
  policy: ExecPolicy,
  argv: ReadonlyArray<string>,
  options: ExecPolicyOptions,
): ReadonlyArray<RuleMatch> {
  const exact = matchExactRules(policy, argv);
  if (exact.length > 0) {
    return exact;
  }

  if (options.resolveHostExecutables) {
    const viaPath = matchHostExecutableRules(policy, argv, options);
    if (viaPath.length > 0) {
      return viaPath;
    }
  }

  return [];
}

export function evaluateExecPolicy(
  policy: ExecPolicy,
  argv: ReadonlyArray<string>,
  options: ExecPolicyOptions,
  heuristics: HeuristicFallback,
): ExecPolicyEvaluation {
  const matched = matchesForCommand(policy, argv, options);
  const decided = strictestOf(matched.map(matchDecision));
  if (decided === undefined) {
    const decision = heuristics(argv);
    return {
      decision,
      matchedRules: [{ kind: "heuristics", command: [...argv], decision }],
    };
  }

  return { decision: decided, matchedRules: matched };
}
