import crypto from "node:crypto";
import { URL } from "node:url";
import { generatePkce } from "./oauth-pkce.js";
import { validateOAuthEndpoint } from "./oauth-endpoints.js";
import { startOAuthCallbackServer } from "./oauth-callback-server.js";

/**
 * OAuth 2.0 PKCE Flow Orchestrator (Wave 1).
 *
 * Implements authorization code grant with S256 PKCE and local loopback callback.
 * Defends against SSRF via endpoint allowlisting (Design Decision D3).
 */

export type OAuthFlowConfig = {
  readonly authorizeEndpoint: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly scope?: string;
  readonly extraAllowedHosts?: ReadonlySet<string>;
  readonly timeoutMs?: number;
  /**
   * Injected clock for `expiresAt`. The credentials package's contract
   * (`ports/credentials.ts`) is injected-clock timestamps: a test must be able
   * to pin expiry without waiting, exactly as `token-manager.ts` already does.
   */
  readonly now?: (() => number) | undefined;
  readonly onAuthorizeUrl?: (url: string) => Promise<void> | void;
  readonly fetchImpl?: typeof globalThis.fetch;
};

export type OAuthTokenResponse = {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
  readonly tokenType?: string;
  readonly scope?: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
};

export type OAuthFlowResult =
  | { readonly ok: true; readonly tokens: OAuthTokenResponse }
  | {
      readonly ok: false;
      readonly code:
        | "untrusted_endpoint"
        | "callback_failed"
        | "exchange_failed"
        | "token_error";
      readonly detail: string;
    };

export async function executeOAuthFlow(config: OAuthFlowConfig): Promise<OAuthFlowResult> {
  const now = config.now ?? Date.now;
  // 1. Validate endpoints against allowlist (anti-SSRF, D3)
  const authValidation = validateOAuthEndpoint(config.authorizeEndpoint, config.extraAllowedHosts);
  if (!authValidation.ok) {
    return {
      ok: false,
      code: "untrusted_endpoint",
      detail: `authorizeEndpoint refused: ${authValidation.reason} (${config.authorizeEndpoint})`,
    };
  }

  const tokenValidation = validateOAuthEndpoint(config.tokenEndpoint, config.extraAllowedHosts);
  if (!tokenValidation.ok) {
    return {
      ok: false,
      code: "untrusted_endpoint",
      detail: `tokenEndpoint refused: ${tokenValidation.reason} (${config.tokenEndpoint})`,
    };
  }

  // 2. Generate PKCE and state
  const pkce = generatePkce();
  const state = crypto.randomUUID();

  // 3. Start local callback server
  let callbackServer;

  try {
    callbackServer = await startOAuthCallbackServer({
      expectedState: state,
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    });
  } catch (err) {
    return {
      ok: false,
      code: "callback_failed",
      detail: `Failed to start loopback callback server: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 4. Construct Authorization URL
  const authUrl = new URL(config.authorizeEndpoint);

  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", config.clientId);
  authUrl.searchParams.set("redirect_uri", callbackServer.redirectUri);
  authUrl.searchParams.set("code_challenge", pkce.challenge);
  authUrl.searchParams.set("code_challenge_method", pkce.method);
  authUrl.searchParams.set("state", state);

  if (config.scope !== undefined && config.scope.length > 0) {
    authUrl.searchParams.set("scope", config.scope);
  }

  // 5. Notify authorization URL
  if (config.onAuthorizeUrl) {
    await config.onAuthorizeUrl(authUrl.toString());
  }

  // 6. Wait for user authorization and callback code
  const callbackResult = await callbackServer.waitForResult();
  if (!callbackResult.ok) {
    return {
      ok: false,
      code: "callback_failed",
      detail: callbackResult.errorDescription ?? callbackResult.error,
    };
  }

  // 7. Exchange authorization code for tokens
  const doFetch = config.fetchImpl ?? globalThis.fetch;
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    code: callbackResult.code,
    redirect_uri: callbackServer.redirectUri,
    code_verifier: pkce.verifier,
  });

  let tokenRes: Response;

  try {
    tokenRes = await doFetch(config.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: tokenBody.toString(),
    });
  } catch (err) {
    return {
      ok: false,
      code: "exchange_failed",
      detail: `Network error reaching token endpoint: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!tokenRes.ok) {
    let errorDetail = `HTTP ${tokenRes.status}`;

    try {
      const errJson = (await tokenRes.json()) as { error?: string; error_description?: string };
      if (errJson.error_description) {
        errorDetail = errJson.error_description;
      } else if (errJson.error) {
        errorDetail = errJson.error;
      }
    } catch {
      // Use fallback error detail
    }

    return {
      ok: false,
      code: "token_error",
      detail: `Token exchange failed: ${errorDetail}`,
    };
  }

  const payload = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
  };

  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
    return {
      ok: false,
      code: "token_error",
      detail: "Token response missing valid access_token",
    };
  }

  const expiresAt =
    typeof payload.expires_in === "number" && payload.expires_in > 0
      ? new Date(now() + payload.expires_in * 1000).toISOString()
      : undefined;

  return {
    ok: true,
    tokens: {
      accessToken: payload.access_token,
      ...(payload.refresh_token === undefined ? {} : { refreshToken: payload.refresh_token }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(payload.token_type === undefined ? {} : { tokenType: payload.token_type }),
      ...(payload.scope === undefined ? {} : { scope: payload.scope }),
      tokenEndpoint: config.tokenEndpoint,
      clientId: config.clientId,
    },
  };
}
