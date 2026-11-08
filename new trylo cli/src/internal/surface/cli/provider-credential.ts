import { createCliCredentialPortWithReport, credentialWarningTo } from "./credentials-wiring.js";
import type { CliContext } from "./context.js";
import { isKeyedProviderKind, isProviderKind, type ProviderKind } from "../../adapters/provider/providers-file.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";

/**
 * The credential half of a provider's report.
 *
 * Every rule here is about honesty rather than secrecy: whether a provider can
 * authenticate is always *stated* — never rendered as silence — and the value
 * itself never enters any output, in either format.
 *
 * The third rule is the one the account binding added. When a declaration names
 * an account, the row is about *that* account, not about whichever one the
 * family's current pointer happens to name, because "logged in" must not be able
 * to mean "logged in somewhere else". That is why the resolver used here is
 * `getAccount`, not `get`: `get` follows the pointer, and following it would
 * turn a binding into a suggestion.
 */

/**
 * The account that family's current pointer names, or `undefined` when none.
 *
 * `providers add` binds this when `--account` is omitted, so that a one-key
 * setup needs no flag and a second host added later cannot inherit the first
 * host's key.
 */
export function currentAccountIdOf(ctx: CliContext): string | undefined {
  const status = createCliCredentialPortWithReport(ctx, credentialWarningTo(ctx)).status();
  if (!status.ok) {
    return undefined;
  }

  const row = status.value.find((entry) => entry.providerId === "openai-compatible");
  if (row === undefined || !row.loggedIn || row.accountId.length === 0) {
    return undefined;
  }

  return row.accountId;
}

export type CredentialState =
  | { readonly required: false; readonly note: string }
  | {
      readonly required: true;
      readonly loggedIn: boolean;
      readonly layer: string;
      readonly account: string;
      readonly authType?: string;
      /** True when this row is the account a declaration *named*, not the family current. */
      readonly bound?: boolean;
    }
  | { readonly required: true; readonly unavailable: string };

/**
 * Whether this provider can authenticate right now (PW-4, the AUTH2 bridge).
 *
 * Asked of the ledger's `status`, which is the one view that answers the
 * question *without* producing a secret: it says which layer resolved, which
 * account is current and whether that account is logged in. The value itself is
 * never in this process's output.
 *
 * "Not logged in" is reported, not hidden. A command that printed nothing when
 * there is no credential would let a person read silence as "configured", which
 * is the one claim this package must never help anyone make (D5).
 *
 * With an `accountId`, the question becomes "can *that* account authenticate",
 * and the ledger's `getAccount` answers it — a miss is reported as exactly that,
 * never silently replaced by the family's current account.
 */
export function credentialStateOf(
  ctx: CliContext,
  kind: ProviderKind,
  accountId?: string,
): CredentialState {
  if (!isKeyedProviderKind(kind)) {
    return { required: false, note: `${kind} is offline and needs no credential` };
  }

  const port = createCliCredentialPortWithReport(ctx, credentialWarningTo(ctx));

  if (accountId !== undefined) {
    const resolved = port.getAccount({ providerId: "openai-compatible", accountId });
    if (!resolved.ok) {
      return { required: true, loggedIn: false, layer: "none", account: accountId, bound: true };
    }

    return {
      required: true,
      loggedIn: resolved.value.layer !== "none",
      layer: resolved.value.layer,
      account: resolved.value.accountId,
      bound: true,
      ...(resolved.value.authType === undefined ? {} : { authType: resolved.value.authType }),
    };
  }

  const status = port.status();
  if (!status.ok) {
    return { required: true, unavailable: `${status.code}: ledger unusable (value never printed)` };
  }

  const row = status.value.find((entry) => entry.providerId === "openai-compatible");
  if (row === undefined) {
    return { required: true, loggedIn: false, layer: "none", account: "" };
  }

  return {
    required: true,
    loggedIn: row.loggedIn,
    layer: row.layer,
    account: row.accountId,
    ...(row.authType === undefined ? {} : { authType: row.authType }),
  };
}

export function renderCredential(state: CredentialState): string {
  if (!state.required) {
    return `cred     ${state.note}`;
  }

  if ("unavailable" in state) {
    return `cred     unavailable: ${state.unavailable}`;
  }

  const auth = state.authType === undefined ? "" : ` auth=${state.authType}`;
  const bound = state.bound === true ? " bound" : "";

  return `cred     logged_in=${state.loggedIn} layer=${state.layer} account=${state.account || "(none)"}${auth}${bound}`;
}

export type AccountCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "unknown_account" | "unavailable"; readonly detail: string };

/**
 * Whether a named account exists in the keyed family's ledger.
 *
 * `providers add/edit --account` calls this before writing: a binding to an
 * account that does not exist bricks the whole profile (every later run fails
 * far from the typo), so the typo is refused here with the ids that do exist.
 * A ledger that cannot be read is `unavailable`, not "unknown" — writing blind
 * against it would be the same brick with less honesty.
 */
export function checkAccountExists(ctx: CliContext, accountId: string): AccountCheck {
  const port = createCliCredentialPortWithReport(ctx, credentialWarningTo(ctx));
  const resolved = port.getAccount({ providerId: "openai-compatible", accountId });
  if (resolved.ok) {
    return { ok: true };
  }

  if (resolved.code === "unknown_account") {
    return { ok: false, code: "unknown_account", detail: resolved.detail };
  }

  return { ok: false, code: "unavailable", detail: `cannot read the credential ledger: ${resolved.code}: ${resolved.detail}` };
}

/**
 * An explicit `--account` names a ledger row, checked before anything is
 * written: a binding to a missing account bricks the profile (every later run
 * fails far from the typo). Only the keyed family has a ledger; other kinds
 * skip. Emits the refusal and returns its exit code, or `undefined` when the
 * binding may be written.
 */
export function refuseUnknownAccount(
  ctx: CliContext,
  kind: string,
  account: string | undefined,
): ExitCode | undefined {
  if (account === undefined || !isProviderKind(kind) || !isKeyedProviderKind(kind)) {
    return undefined;
  }

  const checked = checkAccountExists(ctx, account);
  if (checked.ok) {
    return undefined;
  }

  if (checked.code === "unknown_account") {
    ctx.stderr(`unknown account ${account}; ${checked.detail}. \`trylo auth list\` shows the stored accounts\n`);
    return EXIT_CODES.USAGE;
  }

  ctx.stderr(`${checked.detail}\n`);

  return EXIT_CODES.CONFIG;
}
