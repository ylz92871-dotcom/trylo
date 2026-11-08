import { createCredentialPort } from "../../adapters/credentials/compose.js";
import { createCredentialPortPreferringKeyring } from "../../adapters/credentials/keyring-compose.js";
import type { TokenManagerLike } from "../../adapters/provider/openai-compatible.js";
import { OAuthTokenManager } from "../../credentials/token-manager.js";
import type { OsKeyringDriver } from "../../credentials/keyring-driver.js";
import type {
  CredentialFailureCode,
  CredentialGetAccountInput,
  CredentialLayer,
  CredentialPort,
  CredentialProviderId,
  CredentialResolved,
} from "../../ports/credentials.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import { createProjection } from "./render.js";
import { tryloHome } from "./session-paths.js";

/**
 * The CLI's one binding to the credential ledger.
 *
 * Everything that knows *how* a credential is resolved — which environment
 * variables count, which files hold which scope — lives behind `CredentialPort`.
 * This module only decides what the composition root hands the port (the
 * profile root, the current workspace as the project scope, an injected
 * environment snapshot) and what a port failure means for the process exit
 * code. No other
 * CLI file may read a declared credential variable, which is what retires the
 * old `TRYLO_API_KEY` side-reads in the config loader and the doctor.
 *
 * Two bindings live here, not one. `createCliCredentialPort` is the documented
 * default and is unchanged: the file ledger, and nothing else. Its companion
 * `createCliCredentialPortWithReport` adds the *opt-in* selection of an OS
 * keyring in front of it (WP `2026-09-16-WP-传统CLI-交付面收尾波` D4/D5) — off
 * unless `TRYLO_PREFER_KEYRING` is exactly `"1"`, and reported through an
 * injected warning channel when the keyring turns out to be unavailable, so the
 * ledger binding keeps its `CredentialPort`/`Result` shape rather than growing a
 * second one.
 */

/** The slice of the CLI context the ledger binding needs. */
export type CredentialWiringContext = {
  readonly homeDir: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => number;
};

export function createCliCredentialPort(ctx: CredentialWiringContext): CredentialPort {
  return createCredentialPort({
    // The profile root, not the OS home. Sessions already live under
    // `tryloHome()`, and a key on a different volume than the transcript it
    // belongs to is a bug the user cannot see. `tryloHome` is reused rather
    // than restated so there is exactly one definition of where the profile is.
    homeDir: tryloHome(ctx.homeDir, ctx.env),
    // The workspace is the project scope: `--project` writes into it, never
    // above it. The port refuses `..` escapes on its own.
    projectDir: ctx.cwd,
    env: ctx.env,
    now: () => new Date(ctx.now()).toISOString(),
  });
}

/**
 * The environment variable that asks for the prefer-keyring path.
 *
 * A closed set of one: only the exact string `"1"` turns it on. `"true"`,
 * `"on"`, `"yes"`, a `" 1"` with a space — all of them are *off*, deliberately,
 * because a switch that accepts a family of spellings is a switch whose default
 * nobody can state. Absent and off are the same thing, and both are byte for
 * byte the path this module had before the keyring existed.
 */
export const KEYRING_PREFERENCE_ENV = "TRYLO_PREFER_KEYRING";

function prefersKeyring(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[KEYRING_PREFERENCE_ENV] === "1";
}

/**
 * Where a *selection* problem is reported: the backend that was asked for is not
 * the backend in use. Never carries a secret — the report is about the machine,
 * not about a key.
 */
export type CredentialWarning = (warning: {
  readonly code: string;
  readonly message: string;
}) => void;

export type CredentialWiringDeps = {
  /**
   * Injected for tests: the platform keyring driver. Production passes nothing
   * and gets the real one, which is what makes "no driver was probed on the
   * default path" a testable claim instead of a reading of the source.
   */
  readonly driver?: OsKeyringDriver | undefined;
};

/**
 * The ledger binding with the opt-in keyring selection in front of it.
 *
 * Three properties, in the order they matter:
 *
 *  - **off by default, and off is not a code path — it is the *same* call.**
 *    With the switch off this returns `createCliCredentialPort(ctx)`, so the
 *    default path is not "the prefer path that happens to fall back": no driver
 *    exists, none is probed, and there is nothing to fall back from.
 *  - **degradation is a selection-time fact, reported once.** When the keyring
 *    is unavailable the file ledger is used and exactly one warning is emitted,
 *    because the factory returns one report. A read or write that fails *after*
 *    selection stays a failure (`keyring-store.ts` fails closed) — a secret is
 *    never quietly moved to a file the user did not choose.
 *  - **the port's shape does not change.** The caller still gets a
 *    `CredentialPort`; the extra fact travels beside it, through `emit`.
 */
export function createCliCredentialPortWithReport(
  ctx: CredentialWiringContext,
  emit: CredentialWarning,
  deps: CredentialWiringDeps = {},
): CredentialPort {
  if (!prefersKeyring(ctx.env)) {
    return createCliCredentialPort(ctx);
  }

  const selected = createCredentialPortPreferringKeyring({
    homeDir: tryloHome(ctx.homeDir, ctx.env),
    projectDir: ctx.cwd,
    env: ctx.env,
    now: () => new Date(ctx.now()).toISOString(),
    driver: deps.driver,
  });
  if (selected.report.backend === "file") {
    emit({ code: "keyring_unavailable_fallback", message: selected.report.reason });
  }

  return selected.port;
}

/**
 * The warning channel for a command that has no sink of its own.
 *
 * It goes through the one text projection every other CLI warning goes through,
 * so a fallback reads `warning keyring_unavailable_fallback: <reason>` exactly
 * like the warnings a run emits — one formatter, not two. `--json` callers keep
 * their payload on stdout untouched; the warning is on stderr, where every
 * human-facing byte of this CLI already lives.
 */
export function credentialWarningTo(ctx: {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}): CredentialWarning {
  const projection = createProjection("text", { stdout: ctx.stdout, stderr: ctx.stderr });
  return (warning) => {
    projection.onEvent({ type: "warning", code: warning.code, message: warning.message });
  };
}

/**
 * Failure code -> exit code, exhaustive over the port's closed failure set.
 *
 * Two buckets only (WP §2): a mistake in *how the command was invoked* is a
 * usage error; a ledger that cannot be proven safe or intact is an
 * authentication failure, because in either state the run cannot authenticate.
 * The `Record` type makes adding a code to the port a compile error here rather
 * than a silently mis-filed exit code.
 */
const CREDENTIAL_EXIT_CODES: Readonly<Record<CredentialFailureCode, ExitCode>> = {
  unknown_provider: EXIT_CODES.USAGE,
  invalid_account_id: EXIT_CODES.USAGE,
  missing_secret: EXIT_CODES.USAGE,
  unknown_account: EXIT_CODES.USAGE,
  duplicate_account: EXIT_CODES.USAGE,
  not_logged_in: EXIT_CODES.USAGE,
  current_account_protected: EXIT_CODES.USAGE,
  confirm_required: EXIT_CODES.USAGE,
  env_shadowed: EXIT_CODES.AUTH,
  credentials_corrupt: EXIT_CODES.AUTH,
  credentials_insecure: EXIT_CODES.AUTH,
  keyring_unavailable: EXIT_CODES.AUTH,
  lock_conflict: EXIT_CODES.AUTH,
  path_escape: EXIT_CODES.AUTH,
  directory_unavailable: EXIT_CODES.AUTH,
  read_failed: EXIT_CODES.AUTH,
  write_failed: EXIT_CODES.AUTH,
};

export function credentialExitCode(code: CredentialFailureCode): ExitCode {
  return CREDENTIAL_EXIT_CODES[code];
}

/** What a resolved provider credential looks like to the composition root. */
export type ResolvedProviderCredential =
  | {
      readonly ok: true;
      /** Present only when a layer actually resolved; a miss is not an error. */
      readonly apiKey: string | undefined;
      readonly layer: CredentialLayer;
      readonly accountId: string;
      readonly tokenManager?: TokenManagerLike | undefined;
    }
  | { readonly ok: false; readonly code: CredentialFailureCode; readonly detail: string };

/**
 * The key a provider run uses, read from the ledger port.
 *
 * `layer: "none"` is a miss, not a failure: the caller turns it into the same
 * auth refusal a missing environment key always produced.
 */
export function resolveProviderCredential(
  port: CredentialPort,
  providerId: CredentialProviderId,
): ResolvedProviderCredential {
  const resolved = port.get(providerId);
  if (!resolved.ok) {
    return { ok: false, code: resolved.code, detail: resolved.detail };
  }
  return resolvedCredentialValue(port, providerId, resolved.value);
}

/**
 * The same, for a *named* account.
 *
 * This is the path a provider declaration with an `accountId` takes. It never
 * calls `switch`: moving the family's current pointer to satisfy one endpoint is
 * how a second host ends up authenticating with the first host's key. A miss is
 * `unknown_account` carrying the ids that do exist, so the typo is fixable from
 * the message alone.
 */
export function resolveNamedProviderCredential(
  port: CredentialPort,
  input: CredentialGetAccountInput,
): ResolvedProviderCredential {
  const resolved = port.getAccount(input);
  if (!resolved.ok) {
    return { ok: false, code: resolved.code, detail: resolved.detail };
  }
  return resolvedCredentialValue(port, input.providerId, resolved.value);
}

function resolvedCredentialValue(
  port: CredentialPort,
  providerId: CredentialProviderId,
  value: CredentialResolved,
): ResolvedProviderCredential {
  const tokenManager =
    value.refreshToken !== undefined && value.tokenEndpoint !== undefined
      ? new OAuthTokenManager({
          state: {
            providerId,
            accountId: value.accountId,
            scope: value.layer === "project" ? "project" : "user",
            accessToken: value.secret ?? "",
            refreshToken: value.refreshToken,
            expiresAtMs: value.expiresAt !== undefined ? new Date(value.expiresAt).getTime() : undefined,
            tokenEndpoint: value.tokenEndpoint,
            clientId: value.clientId,
            tokenType: value.tokenType,
          },
          port,
        })
      : undefined;

  return {
    ok: true,
    apiKey: value.secret,
    layer: value.layer,
    accountId: value.accountId,
    ...(tokenManager !== undefined ? { tokenManager } : {}),
  };
}
