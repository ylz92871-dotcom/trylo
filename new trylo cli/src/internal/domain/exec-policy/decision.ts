/**
 * The three answers an execution policy can give about one command.
 *
 * Source of the semantics: Codex `execpolicy/src/decision.rs` at commit
 * `73a1148c9c775c2a4616ce5096291740a00ed68a`. The set is copied, not
 * reinvented, because each member already carries a distinct terminal meaning:
 *
 *  - `allow`    the policy itself authorises the command; no human is asked;
 *  - `prompt`   the policy has no opinion worth trusting, so a human decides;
 *  - `forbidden` the policy refuses; asking would imply it might be allowed.
 *
 * `allow` is therefore *not* an absent answer and `forbidden` is *not* a
 * stricter `prompt`: the three are what let this layer say something before a
 * person is involved at all.
 */

export const EXEC_DECISIONS = ["allow", "prompt", "forbidden"] as const;

export type ExecDecision = (typeof EXEC_DECISIONS)[number];

/**
 * Severity order. This is the whole reason several rules that match the same
 * command can be folded into one answer safely.
 */
const SEVERITY: Readonly<Record<ExecDecision, number>> = {
  allow: 0,
  prompt: 1,
  forbidden: 2,
};

export function isExecDecision(value: string): value is ExecDecision {
  return (EXEC_DECISIONS as readonly string[]).includes(value);
}

/** The more restrictive of two decisions; equal inputs are order-free. */
export function strictest(left: ExecDecision, right: ExecDecision): ExecDecision {
  return SEVERITY[left] >= SEVERITY[right] ? left : right;
}

/**
 * Fold every decision that applied into one answer, most severe wins.
 *
 * Returns `undefined` for an empty list rather than throwing. Upstream calls
 * `.expect("invariant failed")` here, which is a panic; this package uses typed
 * failures, so an empty match set stays a value the caller must handle. A
 * command that matched nothing is asked about, never assumed safe.
 */
export function strictestOf(decisions: Iterable<ExecDecision>): ExecDecision | undefined {
  let strongest: ExecDecision | undefined;
  for (const decision of decisions) {
    strongest = strongest === undefined ? decision : strictest(strongest, decision);
  }
  return strongest;
}

export type ParsedDecision =
  | { readonly ok: true; readonly decision: ExecDecision }
  | { readonly ok: false; readonly message: string };

/**
 * `network_rule` additionally accepts the word `deny` for readability; every
 * other spelling is refused rather than defaulted, because a policy author who
 * wrote `disallow` meant one of three things and guessing which is worse than
 * failing to load the policy.
 */
export function parseExecDecision(raw: string, allowDenyAlias = false): ParsedDecision {
  if (allowDenyAlias && raw === "deny") {
    return { ok: true, decision: "forbidden" };
  }

  if (!isExecDecision(raw)) {
    return {
      ok: false,
      message: `decision must be one of ${EXEC_DECISIONS.join(", ")}${allowDenyAlias ? ", deny" : ""} (got ${raw})`,
    };
  }

  return { ok: true, decision: raw };
}
