import type {
  CredentialFailure,
  CredentialPublicEntry,
  CredentialStatusRow,
} from "../../ports/credentials.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type {
  AuthDeleteOptions,
  AuthSwitchOptions,
  LoginCommandOptions,
  LogoutCommandOptions,
} from "./args.js";
import type { CliContext } from "./context.js";
import {
  createCliCredentialPortWithReport,
  credentialExitCode,
  credentialWarningTo,
} from "./credentials-wiring.js";
import { aligned, shortenId } from "./humanize.js";
import { reportFailure } from "./run-failure.js";
import { resolveLoginSecret } from "./secret-prompt.js";
import { executeOAuthFlow } from "../../credentials/oauth-flow.js";
import { executeDeviceFlow } from "../../credentials/device-flow.js";
import { storeCredential } from "./credential-login.js";

/**
 * Handlers for the credential commands: `login`, `logout`, `status`,
 * `auth list`, `auth switch`.
 *
 * Every verb is a thin translation of argv into one `CredentialPort` call: the
 * ledger owns the semantics, the scope files, the environment table and the
 * redaction, `secret-prompt.ts` owns where the secret comes from, and this file
 * owns the rendering of the port's secret-free public shapes.
 *
 * `exportSecrets` is deliberately absent: the port has the verb, the CLI must
 * never expose it, and the scan in `credentials-wiring.test.ts` fails if one
 * appears here.
 */

function scopeOf(options: { readonly project?: boolean }): "user" | "project" {
  return options.project === true ? "project" : "user";
}

/**
 * A status row, as cells to be aligned with its neighbours.
 *
 * The account id is shortened here and nowhere else: this row answers "which
 * account am I on", and eight characters answer that, where thirty-two make
 * every row wide enough that nothing lines up. `auth list` keeps ids whole
 * because those are the ones a person copies into `auth switch`.
 */
function statusCells(row: CredentialStatusRow): ReadonlyArray<string> {
  const cells = [
    row.providerId,
    `layer=${row.layer}`,
    `account=${shortenId(row.accountId || "-")}`,
    `logged_in=${row.loggedIn}`,
  ];

  if (row.authType !== undefined) {
    cells.push(`auth=${row.authType}`);
  }

  if (row.label !== undefined) {
    cells.push(`label=${row.label}`);
  }

  return cells;
}

function entryCells(entry: CredentialPublicEntry): ReadonlyArray<string> {
  const cells = [
    entry.providerId,
    // Whole, unlike `status`: this is the id `auth switch` wants.
    `account=${entry.accountId}`,
    `scope=${entry.scope}`,
    `current=${entry.isCurrent}`,
  ];

  if (entry.authType !== undefined) {
    cells.push(`auth=${entry.authType}`);
  }

  if (entry.label !== undefined) {
    cells.push(`label=${entry.label}`);
  }

  return cells;
}

/** The next action for a refusal, keyed by what the user can actually do. */
function hintFor(code: CredentialFailure["code"]): string {
  switch (code) {
    case "missing_secret":
      return "pass --secret-file <path>, or run from a terminal to type the secret";
    case "env_shadowed":
      return "the declared environment variable already supplies this credential; unset it to log in to the ledger";
    case "unknown_account":
      return "run `trylo auth list` to see the stored account ids";
    case "current_account_protected":
      return "switch to another account with `trylo auth switch`, or clear the pointer with `trylo logout`, then delete";
    case "duplicate_account":
      return "pick another --account id, or switch to the existing one with `trylo auth switch`";
    case "invalid_account_id":
      return "account ids are lowercase letters, digits, dash and underscore, at most 64 characters";
    case "credentials_corrupt":
      return "inspect the ledger file; a ledger that cannot be proven intact is never rewritten";
    case "credentials_insecure":
      return "restrict the ledger file so group and others cannot read it, then retry";
    case "lock_conflict":
      return "another trylo process may hold the ledger lock; retry once it exits";
    case "keyring_unavailable":
      return "this build has no keyring backend attached; the file ledger is the default";
    default:
      return "run `trylo --help` for the credential commands";
  }
}

function credentialFailure(ctx: CliContext, command: string, failure: CredentialFailure): ExitCode {
  return reportFailure(ctx, {
    exitCode: credentialExitCode(failure.code),
    message: `${command} failed: ${failure.code}: ${failure.detail}`,
    hint: hintFor(failure.code),
  });
}

export async function handleLogin(ctx: CliContext, options: LoginCommandOptions): Promise<ExitCode> {
  const scope = scopeOf(options);

  if (options.oauth === true) {
    const authorizeEndpoint =
      ctx.env["TRYLO_OAUTH_AUTHORIZE_URL"] ?? "https://auth.openai.com/oauth/authorize";
    const tokenEndpoint =
      ctx.env["TRYLO_OAUTH_TOKEN_URL"] ?? "https://auth.openai.com/oauth/token";
    const clientId = ctx.env["TRYLO_OAUTH_CLIENT_ID"] ?? "trylo-cli";

    const oauthResult = await executeOAuthFlow({
      authorizeEndpoint,
      tokenEndpoint,
      clientId,
      onAuthorizeUrl: (url) => {
        ctx.stdout(`Complete authorization in your browser:\n${url}\n`);
      },
    });

    if (!oauthResult.ok) {
      return reportFailure(ctx, {
        exitCode: EXIT_CODES.AUTH,
        message: `OAuth login failed: ${oauthResult.code}: ${oauthResult.detail}`,
        hint: "check your network connection or verify that the authorization server is reachable",
      });
    }

    const result = storeCredential(ctx, {
      providerId: options.provider,
      scope,
      authType: "oauth",
      secret: oauthResult.tokens.accessToken,
      accessToken: oauthResult.tokens.accessToken,
      ...(oauthResult.tokens.refreshToken !== undefined
        ? { refreshToken: oauthResult.tokens.refreshToken }
        : {}),
      ...(oauthResult.tokens.expiresAt !== undefined
        ? { expiresAt: oauthResult.tokens.expiresAt }
        : {}),
      ...(oauthResult.tokens.tokenType !== undefined
        ? { tokenType: oauthResult.tokens.tokenType }
        : {}),
      ...(oauthResult.tokens.tokenEndpoint !== undefined
        ? { tokenEndpoint: oauthResult.tokens.tokenEndpoint }
        : {}),
      ...(oauthResult.tokens.clientId !== undefined
        ? { clientId: oauthResult.tokens.clientId }
        : {}),
      ...(options.account === undefined ? {} : { accountId: options.account }),
      ...(options.label === undefined ? {} : { label: options.label }),
    });
    if (!result.ok) {
      return credentialFailure(ctx, "login", result);
    }

    ctx.stdout(
      `logged in ${options.provider} account ${result.value.accountId} via oauth (scope ${scope})\n`,
    );

    return EXIT_CODES.OK;
  }

  if (options.device === true) {
    return handleDeviceLogin(ctx, options, scope);
  }

  const secret = await resolveLoginSecret(ctx, {
    provider: options.provider,
    ...(options.secretFile === undefined ? {} : { secretFile: options.secretFile }),
  });
  if ("exitCode" in secret) {
    return reportFailure(ctx, secret);
  }

  const result = storeCredential(ctx, {
    providerId: options.provider,
    scope,
    authType: "api_key",
    ...(options.account === undefined ? {} : { accountId: options.account }),
    ...(options.label === undefined ? {} : { label: options.label }),
    ...(secret.secret === undefined ? {} : { secret: secret.secret }),
  });
  if (!result.ok) {
    return credentialFailure(ctx, "login", result);
  }

  ctx.stdout(
    `logged in ${options.provider} account ${result.value.accountId} (scope ${scope})\n`,
  );

  return EXIT_CODES.OK;
}

/**
 * RFC 8628 device login (WP18.1: C69/L69 device path).
 *
 * The endpoints come from the environment and default to the same issuer the
 * loopback flow uses; there is no default *device* endpoint, so without
 * `TRYLO_OAUTH_DEVICE_URL` the command refuses rather than inventing a
 * subscription backend Trylo cannot prove. A granted code is stored exactly
 * like a loopback OAuth login — same ledger, same `oauth` auth type — and a
 * denied or expired grant is terminal, never retried into success.
 */
async function handleDeviceLogin(
  ctx: CliContext,
  options: LoginCommandOptions,
  scope: "user" | "project",
): Promise<ExitCode> {
  const deviceEndpoint = ctx.env["TRYLO_OAUTH_DEVICE_URL"];
  if (deviceEndpoint === undefined || deviceEndpoint.length === 0) {
    return reportFailure(ctx, {
      exitCode: EXIT_CODES.AUTH,
      message: "device login needs TRYLO_OAUTH_DEVICE_URL pointing at the issuer's device authorization endpoint",
      hint: "use `trylo login --oauth` on a machine with a browser, or configure the device endpoint first",
    });
  }

  const tokenEndpoint =
    ctx.env["TRYLO_OAUTH_TOKEN_URL"] ?? "https://auth.openai.com/oauth/token";
  const clientId = ctx.env["TRYLO_OAUTH_CLIENT_ID"] ?? "trylo-cli";

  const deviceResult = await executeDeviceFlow({
    deviceEndpoint,
    tokenEndpoint,
    clientId,
    onUserCode: (display) => {
      ctx.stdout(`Authorize this device:\n  code: ${display.userCode}\n  visit: ${display.verificationUri}\n`);
    },
  });
  if (!deviceResult.ok) {
    return reportFailure(ctx, {
      exitCode: EXIT_CODES.AUTH,
      message: `device login failed: ${deviceResult.code}: ${deviceResult.detail}`,
      hint: "enter the code shown above on the verification page, then retry once it is approved",
    });
  }

  const result = storeCredential(ctx, {
    providerId: options.provider,
    scope,
    authType: "oauth",
    secret: deviceResult.tokens.accessToken,
    accessToken: deviceResult.tokens.accessToken,
    ...(deviceResult.tokens.refreshToken !== undefined
      ? { refreshToken: deviceResult.tokens.refreshToken }
      : {}),
    ...(deviceResult.tokens.expiresAt !== undefined ? { expiresAt: deviceResult.tokens.expiresAt } : {}),
    ...(deviceResult.tokens.tokenType !== undefined ? { tokenType: deviceResult.tokens.tokenType } : {}),
    ...(options.account === undefined ? {} : { accountId: options.account }),
    ...(options.label === undefined ? {} : { label: options.label }),
  });
  if (!result.ok) {
    return credentialFailure(ctx, "login", result);
  }

  ctx.stdout(
    `logged in ${options.provider} account ${result.value.accountId} via device (scope ${scope})\n`,
  );

  return EXIT_CODES.OK;
}

export function handleLogout(ctx: CliContext, options: LogoutCommandOptions): ExitCode {
  const scope = scopeOf(options);
  const result = createCliCredentialPortWithReport(ctx, credentialWarningTo(ctx)).logout({
    providerId: options.provider,
    scope,
  });
  if (!result.ok) {
    return credentialFailure(ctx, "logout", result);
  }

  ctx.stdout(`logged out ${options.provider} (scope ${scope})\n`);

  return EXIT_CODES.OK;
}

export function handleAuthStatus(ctx: CliContext, json: boolean): ExitCode {
  const result = createCliCredentialPortWithReport(ctx, credentialWarningTo(ctx)).status();
  if (!result.ok) {
    return credentialFailure(ctx, "status", result);
  }

  if (json) {
    ctx.stdout(`${JSON.stringify({ providers: result.value })}\n`);
    return EXIT_CODES.OK;
  }

  for (const line of aligned(result.value.map(statusCells))) {
    ctx.stdout(`${line}\n`);
  }

  return EXIT_CODES.OK;
}

export function handleAuthList(ctx: CliContext, json: boolean, project: boolean): ExitCode {
  const result = createCliCredentialPortWithReport(ctx, credentialWarningTo(ctx)).list(project ? "project" : "user");
  if (!result.ok) {
    return credentialFailure(ctx, "auth list", result);
  }

  if (json) {
    ctx.stdout(`${JSON.stringify({ entries: result.value })}\n`);
    return EXIT_CODES.OK;
  }

  if (result.value.length === 0) {
    ctx.stdout(`no stored accounts in scope ${project ? "project" : "user"}\n`);
    return EXIT_CODES.OK;
  }

  for (const line of aligned(result.value.map(entryCells))) {
    ctx.stdout(`${line}\n`);
  }

  return EXIT_CODES.OK;
}

export function handleAuthSwitch(ctx: CliContext, options: AuthSwitchOptions): ExitCode {
  const scope = scopeOf(options);
  const result = createCliCredentialPortWithReport(ctx, credentialWarningTo(ctx)).switch({
    providerId: options.provider,
    accountId: options.account,
    scope,
  });
  if (!result.ok) {
    return credentialFailure(ctx, "auth switch", result);
  }

  ctx.stdout(`switched ${options.provider} to account ${options.account} (scope ${scope})\n`);

  return EXIT_CODES.OK;
}

/**
 * Delete a stored secret outright (#14). `logout` only clears the current
 * pointer — the record stays on disk and stays usable — so a machine that
 * must forget a key needs this verb. Deleting the current pointer is refused
 * by the ledger; switch or logout first, as the refusal says.
 */
export function handleAuthDelete(ctx: CliContext, options: AuthDeleteOptions): ExitCode {
  const scope = scopeOf(options);
  const result = createCliCredentialPortWithReport(ctx, credentialWarningTo(ctx)).delete({
    providerId: options.provider,
    accountId: options.account,
    scope,
  });
  if (!result.ok) {
    return credentialFailure(ctx, "auth delete", result);
  }

  ctx.stdout(`deleted ${options.provider} account ${options.account} (scope ${scope})\n`);

  return EXIT_CODES.OK;
}
