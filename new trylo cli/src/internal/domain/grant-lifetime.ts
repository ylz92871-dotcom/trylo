/**
 * What a grant *is*, and therefore what it may not be used for (WP03.1 / F02).
 *
 * The audit line this answers is blunt: the durable tooling file ledger and the
 * temporary session grant cache have different lifetimes, and treating one as
 * the other is how a permission stops meaning anything. So the three kinds of
 * permission-bearing thing this CLI has are named here once, with the lifetime
 * and the consumer each one is for, and one rule is made checkable:
 *
 *   - a grant of kind A never answers a question of kind B.
 *
 * That rule is not documentation. {@link grantSatisfies} is the only function in
 * the codebase allowed to turn "a grant exists" into "this call is authorised",
 * and it refuses every cross-kind pairing. A caller that wants to know whether it
 * may proceed has to say which kind of question it is asking, so widening a
 * grant's reach is a change to this file rather than a change to a lookup.
 */

import type { PermissionAction } from "../ports/permission.js";

/**
 * The three kinds, named for what they are rather than where they are stored.
 *
 * `tooling_once` is the durable ledger's grant: one approval, spent once, bound
 * to a candidate and a package version, verifiable across processes.
 * `session` is the in-process cache: exact calls, until the process ends.
 * `policy` is the operator's written-down rule, which has no expiry because it
 * was not granted to one call at all.
 */
export type GrantKind = "tooling_once" | "session" | "policy";

export const GRANT_KINDS: ReadonlyArray<GrantKind> = ["tooling_once", "session", "policy"];

export function isGrantKind(value: unknown): value is GrantKind {
  return typeof value === "string" && (GRANT_KINDS as ReadonlyArray<string>).includes(value);
}

/**
 * Lifetime, as a question rather than a number.
 *
 * A duration is not a lifetime: "24 hours" says nothing about what happens when
 * the machine restarts, and for one of these three the restart *is* the expiry.
 * Recording the answer as a kind keeps the difference legible in the one place
 * that has to reason about it.
 */
export type Lifetime = {
  readonly kind: "single_use" | "process" | "until_revoked";
  /** Set for `single_use`: a second consumption is `replayed`, never a new grant. */
  readonly replay: "rejected" | "not_applicable";
  /** True when the grant cannot outlive the process that read it. */
  readonly survives_restart: boolean;
};

export const LIFETIMES: Readonly<Record<GrantKind, Lifetime>> = {
  tooling_once: { kind: "single_use", replay: "rejected", survives_restart: true },
  session: { kind: "process", replay: "not_applicable", survives_restart: false },
  policy: { kind: "until_revoked", replay: "not_applicable", survives_restart: true },
};

/** The ordinary question: may this exact call run right now? */
export const CALL_QUESTION = "call" as const;

/** The durable question: may this candidate at this version be installed? */
export const TOOLING_QUESTION = "tooling_once" as const;

/**
 * The grant kinds each question may be answered by.
 *
 * Read this table as the whole answer to "may A authorise B", and note the
 * asymmetry, because it is the substantive claim this file makes.
 *
 * `CALL_QUESTION` — may this ordinary tool call run — is answerable by a session
 * grant and by a written policy, and by nothing else. A durable tooling grant is
 * absent from that row on purpose: it is bound to a *candidate and a package
 * version*, so it answers "may this package be installed", and a ledger entry
 * that could say "yes" about writing a file would be a grant issued for one
 * thing being spent on another.
 *
 * `tooling_once` appears in exactly one row, its own. A session grant and a
 * written policy cannot answer it either — they have no candidate, no version
 * and no single-use guarantee, so spending one of those against a durable ledger
 * is the substitution this file exists to refuse.
 */
const AUTHORISES: Readonly<Record<GrantKind, ReadonlySet<string>>> = {
  tooling_once: new Set([TOOLING_QUESTION]),
  session: new Set(["session", CALL_QUESTION]),
  policy: new Set(["policy", CALL_QUESTION]),
};

/**
 * Whether a grant of `held` answers `question`.
 *
 * The default is no. That direction is not caution for its own sake: the three
 * kinds differ in who issued them, how long they last and what they were issued
 * *for*, so an allow by default would mean a session answer could silence a
 * durable ledger. A caller that finds itself blocked here has answered the
 * question with the wrong kind of grant, which is a real defect and not a
 * missing feature.
 */
export function grantSatisfies(held: GrantKind, question: string): boolean {
  return AUTHORISES[held].has(question);
}

/**
 * The one place a "this matches" claim becomes an authorisation.
 *
 * Match and authority are separate, and this function is the seam between them.
 * `matches` answers "is this the same call"; the grant's kind answers "was
 * anything of this kind issued for calls like it"; and both must hold. A caller
 * that skips this and checks only `matches` has granted itself a licence from a
 * cache lookup, which is precisely the failure the non-forgeability invariant in
 * `ports/approval-consumption.ts` was written to stop.
 */
export function isAuthorised(input: {
  readonly held: GrantKind | undefined;
  readonly question: string;
  readonly matches: boolean;
  readonly revoked?: boolean;
}): boolean {
  if (input.held === undefined || !input.matches) {
    return false;
  }

  if (input.revoked === true) {
    return false;
  }

  return grantSatisfies(input.held, input.question);
}

/**
 * A session grant covers exactly this action and nothing else.
 *
 * Worth restating because the cache is keyed on a fingerprint that already
 * encodes name and arguments: two calls that differ in any argument value are
 * different calls, and a grant for one is not evidence about the other. The
 * fingerprint is the whole matching rule — there is no second, looser one.
 */
export function sessionGrantCovers(grant: PermissionAction, call: PermissionAction): boolean {
  return grant.pattern === call.pattern;
}

/**
 * The failure a cross-kind substitution produces.
 *
 * Named rather than returned as a bare `false` because the caller that hits it
 * has made a category error, and a boolean would let it be "handled" by
 * retrying. It is a defect report, not a decision.
 */
export type SubstitutionAttempt = {
  readonly held: GrantKind;
  readonly question: string;
  readonly refusal: "wrong_grant_kind";
};

export function substitutionRefusal(held: GrantKind, question: string): SubstitutionAttempt {
  return { held, question, refusal: "wrong_grant_kind" };
}
