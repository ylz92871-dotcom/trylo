import type { CredentialPort, CredentialProviderId, CredentialScope } from "../ports/credentials.js";

/**
 * OAuth Token Lifecycle and Single-Flight Refresh Manager (WP Wave 2, Design Decision D1).
 *
 * Implements:
 *  - Access / refresh token separation;
 *  - Single-flight refresh concurrency control: concurrent 401s or expiry checks
 *    queue behind a single in-flight network refresh;
 *  - Automatic renewal before expiry (30s buffer);
 *  - Failure degradation: if refresh fails, fails closed with a clear hint and
 *    never serves a stale expired token;
 *  - Automatic persistence to the credential ledger on refresh.
 */

export type TokenManagerState = {
  readonly providerId: CredentialProviderId;
  readonly accountId: string;
  readonly scope: CredentialScope;
  accessToken: string;
  refreshToken?: string | undefined;
  expiresAtMs?: number | undefined;
  tokenEndpoint?: string | undefined;
  clientId?: string | undefined;
  tokenType?: string | undefined;
};

export type TokenManagerOptions = {
  readonly state: TokenManagerState;
  readonly port?: CredentialPort | undefined;
  readonly fetchImpl?: typeof globalThis.fetch | undefined;
  readonly now?: (() => number) | undefined;
  readonly onTokenUpdated?: ((tokens: {
    readonly accessToken: string;
    readonly refreshToken?: string | undefined;
    readonly expiresAt?: string | undefined;
    readonly tokenType?: string | undefined;
  }) => Promise<void> | void) | undefined;
};

export type AuthErrorResolution =
  | { readonly refreshed: true; readonly token: string }
  | { readonly refreshed: false; readonly reason: string; readonly hint: string };

export class OAuthTokenManager {
  private readonly state: TokenManagerState;
  private readonly port: CredentialPort | undefined;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly onTokenUpdated: TokenManagerOptions["onTokenUpdated"];
  private inFlightRefresh: Promise<string> | null = null;

  constructor(options: TokenManagerOptions) {
    this.state = options.state;
    this.port = options.port;
    this.doFetch = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? (() => Date.now());
    this.onTokenUpdated = options.onTokenUpdated;
  }

  get providerId(): CredentialProviderId {
    return this.state.providerId;
  }

  get accountId(): string {
    return this.state.accountId;
  }

  get currentAccessToken(): string {
    return this.state.accessToken;
  }

  get currentRefreshToken(): string | undefined {
    return this.state.refreshToken;
  }

  get currentExpiresAtMs(): number | undefined {
    return this.state.expiresAtMs;
  }

  /**
   * Returns a valid access token. If token is near expiration (within 30s),
   * automatically refreshes it first using single-flight concurrency.
   */
  async getValidAccessToken(): Promise<string> {
    const expiresAt = this.state.expiresAtMs;
    const isNearExpiry = expiresAt !== undefined && this.now() >= expiresAt - 30_000;

    if (isNearExpiry && this.state.refreshToken && this.state.tokenEndpoint) {
      return this.refreshToken();
    }

    return this.state.accessToken;
  }

  /**
   * Single-flight token refresh.
   * Concurrent callers share the exact same network request Promise.
   */
  async refreshToken(): Promise<string> {
    if (this.inFlightRefresh !== null) {
      return this.inFlightRefresh;
    }

    this.inFlightRefresh = (async () => {
      try {
        const refreshToken = this.state.refreshToken;
        const tokenEndpoint = this.state.tokenEndpoint;

        if (!refreshToken || !tokenEndpoint) {
          throw new Error("Cannot refresh token: missing refresh token or token endpoint");
        }

        const bodyParams = new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        });

        if (this.state.clientId) {
          bodyParams.set("client_id", this.state.clientId);
        }

        const response = await this.doFetch(tokenEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: bodyParams.toString(),
        });

        if (!response.ok) {
          let errorDetail = `HTTP ${response.status}`;

          try {
            const errJson = (await response.json()) as { error?: string; error_description?: string };
            errorDetail = errJson.error_description ?? errJson.error ?? errorDetail;
          } catch {
            // ignore non-json error
          }

          throw new Error(`Token refresh rejected by authorization server: ${errorDetail}`);
        }

        const payload = (await response.json()) as {
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
          token_type?: string;
        };

        if (!payload.access_token || typeof payload.access_token !== "string") {
          throw new Error("Token refresh response missing access_token");
        }

        const newAccessToken = payload.access_token;
        const newRefreshToken = payload.refresh_token ?? this.state.refreshToken;
        const newExpiresAt =
          typeof payload.expires_in === "number" && payload.expires_in > 0
            ? new Date(this.now() + payload.expires_in * 1000).toISOString()
            : undefined;
        const newTokenType = payload.token_type ?? this.state.tokenType;

        // Update in-memory state
        this.state.accessToken = newAccessToken;
        this.state.refreshToken = newRefreshToken;
        this.state.expiresAtMs =
          newExpiresAt !== undefined ? new Date(newExpiresAt).getTime() : undefined;
        this.state.tokenType = newTokenType;

        // Persist updated token to ledger
        if (this.port) {
          this.port.updateToken({
            providerId: this.state.providerId,
            accountId: this.state.accountId,
            accessToken: newAccessToken,
            ...(newRefreshToken !== undefined ? { refreshToken: newRefreshToken } : {}),
            ...(newExpiresAt !== undefined ? { expiresAt: newExpiresAt } : {}),
            ...(newTokenType !== undefined ? { tokenType: newTokenType } : {}),
            scope: this.state.scope,
          });
        }

        if (this.onTokenUpdated) {
          await this.onTokenUpdated({
            accessToken: newAccessToken,
            ...(newRefreshToken !== undefined ? { refreshToken: newRefreshToken } : {}),
            ...(newExpiresAt !== undefined ? { expiresAt: newExpiresAt } : {}),
            ...(newTokenType !== undefined ? { tokenType: newTokenType } : {}),
          });
        }

        return newAccessToken;
      } finally {
        // A failed refresh must not pin later callers to its rejected promise.
        this.inFlightRefresh = null;
      }
    })();

    return this.inFlightRefresh;
  }

  /**
   * Handles HTTP error status. If 401, attempts single-flight token refresh.
   */
  async handleAuthError(status: number): Promise<AuthErrorResolution> {
    if (status !== 401) {
      return {
        refreshed: false,
        reason: `HTTP ${status}`,
        hint: "Status is not an authentication error (401)",
      };
    }

    if (!this.state.refreshToken || !this.state.tokenEndpoint) {
      return {
        refreshed: false,
        reason: "No refresh token available for 401 renewal",
        hint: `Run \`trylo login --provider ${this.state.providerId}\` to re-authenticate`,
      };
    }

    try {
      const newToken = await this.refreshToken();
      return { refreshed: true, token: newToken };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        refreshed: false,
        reason,
        hint: `OAuth token refresh failed: ${reason}. Please re-authenticate via \`trylo login --provider ${this.state.providerId}\``,
      };
    }
  }
}
