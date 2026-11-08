import http from "node:http";
import crypto from "node:crypto";
import { URL, URLSearchParams } from "node:url";
import { computeChallenge } from "./oauth-pkce.js";

/**
 * In-process real HTTP Mock OAuth 2.0 Authorization Server.
 *
 * Runs over standard loopback HTTP (`127.0.0.1`) without mock-patching globals,
 * verifying real network round-trips for PKCE, authorization code grants, and
 * token refresh.
 */

export type StoredAuthCode = {
  readonly clientId: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
  readonly scope?: string;
};

export type StoredRefreshToken = {
  readonly clientId: string;
  readonly scope?: string;
  readonly accountId: string;
};

export type MockOAuthServerOptions = {
  readonly tokenDelayMs?: number;
  readonly rejectAuthCode?: boolean;
  readonly rejectRefreshToken?: boolean;
};

export type MockOAuthServer = {
  readonly port: number;
  readonly authorizeEndpoint: string;
  readonly tokenEndpoint: string;
  readonly getRefreshCount: () => number;
  readonly getCodeExchangeCount: () => number;
  readonly issueCode: (params: {
    readonly clientId: string;
    readonly codeChallenge: string;
    readonly redirectUri: string;
    readonly scope?: string;
  }) => string;
  readonly close: () => Promise<void>;
};

export async function startMockOAuthServer(
  options: MockOAuthServerOptions = {},
): Promise<MockOAuthServer> {
  const authCodes = new Map<string, StoredAuthCode>();
  const refreshTokens = new Map<string, StoredRefreshToken>();

  let codeExchangeCount = 0;
  let refreshCount = 0;

  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && parsedUrl.pathname === "/authorize") {
      const clientId = parsedUrl.searchParams.get("client_id");
      const redirectUri = parsedUrl.searchParams.get("redirect_uri");
      const responseType = parsedUrl.searchParams.get("response_type");
      const codeChallenge = parsedUrl.searchParams.get("code_challenge");
      const codeChallengeMethod = parsedUrl.searchParams.get("code_challenge_method");
      const state = parsedUrl.searchParams.get("state") ?? "";
      const scope = parsedUrl.searchParams.get("scope") ?? undefined;

      if (!clientId || !redirectUri || responseType !== "code" || !codeChallenge) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_request" }));
        return;
      }

      if (codeChallengeMethod !== "S256") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_request", error_description: "code_challenge_method must be S256" }));
        return;
      }

      if (options.rejectAuthCode) {
        const target = new URL(redirectUri);
        target.searchParams.set("error", "access_denied");
        target.searchParams.set("state", state);
        res.writeHead(302, { Location: target.toString() });
        res.end();
        return;
      }

      const code = `code-${crypto.randomUUID()}`;

      authCodes.set(code, {
        clientId,
        codeChallenge,
        redirectUri,
        ...(scope === undefined ? {} : { scope }),
      });

      const target = new URL(redirectUri);

      target.searchParams.set("code", code);
      target.searchParams.set("state", state);
      res.writeHead(302, { Location: target.toString() });
      res.end();

      return;
    }

    if (req.method === "POST" && parsedUrl.pathname === "/token") {
      const body = await readBody(req);
      const params = parseParams(body, req.headers["content-type"] ?? "");

      if (options.tokenDelayMs !== undefined && options.tokenDelayMs > 0) {
        await new Promise((r) => setTimeout(r, options.tokenDelayMs));
      }

      const grantType = params.get("grant_type");

      if (grantType === "authorization_code") {
        codeExchangeCount += 1;
        const code = params.get("code") ?? "";
        const verifier = params.get("code_verifier") ?? "";
        const clientId = params.get("client_id") ?? "";
        const redirectUri = params.get("redirect_uri") ?? "";

        const stored = authCodes.get(code);
        if (!stored) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant", error_description: "Unknown authorization code" }));
          return;
        }

        authCodes.delete(code); // One-time use

        if (stored.clientId !== clientId || stored.redirectUri !== redirectUri) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant", error_description: "Mismatched client_id or redirect_uri" }));
          return;
        }

        const computed = computeChallenge(verifier);
        if (computed !== stored.codeChallenge) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant", error_description: "PKCE verification failed" }));
          return;
        }

        const accessToken = `at-${crypto.randomUUID()}`;
        const refreshToken = `rt-${crypto.randomUUID()}`;

        refreshTokens.set(refreshToken, {
          clientId,
          accountId: "oauth-acct-1",
          ...(stored.scope === undefined ? {} : { scope: stored.scope }),
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: accessToken,
            refresh_token: refreshToken,
            token_type: "Bearer",
            expires_in: 3600,
            scope: stored.scope,
          }),
        );

        return;
      }

      if (grantType === "refresh_token") {
        refreshCount += 1;
        const refreshToken = params.get("refresh_token") ?? "";
        const clientId = params.get("client_id") ?? "";

        if (options.rejectRefreshToken) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant", error_description: "Refresh token revoked or expired" }));
          return;
        }

        const stored = refreshTokens.get(refreshToken);
        if (!stored) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant", error_description: "Invalid refresh token" }));
          return;
        }

        if (clientId && stored.clientId !== clientId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant", error_description: "Client id mismatch" }));
          return;
        }

        // Rotate refresh token
        refreshTokens.delete(refreshToken);
        const newAccessToken = `at-${crypto.randomUUID()}`;
        const newRefreshToken = `rt-${crypto.randomUUID()}`;

        refreshTokens.set(newRefreshToken, stored);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: newAccessToken,
            refresh_token: newRefreshToken,
            token_type: "Bearer",
            expires_in: 3600,
            scope: stored.scope,
          }),
        );

        return;
      }

      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unsupported_grant_type" }));

      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Unable to bind MockOAuthServer");
  }

  const port = address.port;

  return {
    port,
    authorizeEndpoint: `http://127.0.0.1:${port}/authorize`,
    tokenEndpoint: `http://127.0.0.1:${port}/token`,
    getRefreshCount: () => refreshCount,
    getCodeExchangeCount: () => codeExchangeCount,
    issueCode: (params) => {
      const code = `code-${crypto.randomUUID()}`;
      authCodes.set(code, params);
      return code;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
  });
}

function parseParams(body: string, contentType: string): URLSearchParams {
  if (contentType.includes("application/json")) {
    try {
      const json = JSON.parse(body) as Record<string, unknown>;
      const params = new URLSearchParams();

      for (const [key, val] of Object.entries(json)) {
        if (typeof val === "string") {
          params.set(key, val);
        }
      }

      return params;
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(body);
}
