import {
  isCredentialAccountId,
  isCredentialProviderId,
  type CredentialFailure,
  type CredentialGetAccountInput,
  type CredentialProviderId,
  type CredentialResolved,
  type CredentialResult,
} from "../ports/credentials.js";
import { failure } from "./records.js";
import { resolveNamedAccount, resolveProvider, type ResolveInput } from "./resolve.js";

/**
 * The ledger's *reads*, split from `verbs.ts` by concern.
 *
 * `verbs.ts` holds the verbs that change a ledger; this file holds the two that
 * only look at it. The split is not cosmetic: every read shares the same two
 * questions — is the id known, and can both scopes be read — and keeping them
 * together is what keeps that pair stated once. `resolve.ts` owns the rules
 * themselves; these are the port-shaped adapters over them, and they stay thin
 * on purpose.
 */

export type ReadDeps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly hasProject: boolean;
  readonly readLedgers: () => { user: ResolveInput["user"]; project: ResolveInput["project"] } | CredentialFailure;
};

function resolveInput(
  deps: ReadDeps,
  ledgers: { user: ResolveInput["user"]; project: ResolveInput["project"] },
  providerId: CredentialProviderId,
): ResolveInput {
  return {
    providerId,
    env: deps.env,
    project: ledgers.project,
    hasProject: deps.hasProject,
    user: ledgers.user,
  };
}

/** The family's current credential, env first. A miss is `layer:"none"`, not an error. */
export function get(
  deps: ReadDeps,
  providerId: CredentialProviderId,
): CredentialResult<CredentialResolved> {
  if (!isCredentialProviderId(providerId)) {
    return failure("unknown_provider", `unknown provider ${JSON.stringify(providerId)}`);
  }

  const ledgers = deps.readLedgers();
  if ("ok" in ledgers) {
    return ledgers;
  }

  return { ok: true, value: resolveProvider(resolveInput(deps, ledgers, providerId)) };
}

/** One named account, ledger only. The rule and its reasoning live in `resolve.ts`. */
export function getAccount(
  deps: ReadDeps,
  input: CredentialGetAccountInput,
): CredentialResult<CredentialResolved> {
  if (!isCredentialProviderId(input.providerId)) {
    return failure("unknown_provider", `unknown provider ${JSON.stringify(input.providerId)}`);
  }

  if (!isCredentialAccountId(input.accountId)) {
    return failure("invalid_account_id", `${JSON.stringify(input.accountId)} is not a valid account id`);
  }

  const ledgers = deps.readLedgers();
  if ("ok" in ledgers) {
    return ledgers;
  }

  return resolveNamedAccount(input, ledgers, deps.hasProject);
}
