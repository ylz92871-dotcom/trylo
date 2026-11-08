import http from "node:http";
import { URL } from "node:url";

/**
 * Ephemeral local HTTP callback server for OAuth 2.0 Authorization Code flow.
 *
 * Binds to loopback `127.0.0.1:0` to get an OS-assigned ephemeral port.
 * Receives the authorization response, checks CSRF state, responds with a clean
 * status page, and immediately shuts down.
 */

export type CallbackServerOptions = {
  readonly expectedState: string;
  readonly path?: string;
  readonly timeoutMs?: number;
};

export type CallbackServerResult =
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly error: string; readonly errorDescription?: string };

export type OAuthCallbackServer = {
  readonly port: number;
  readonly redirectUri: string;
  readonly waitForResult: () => Promise<CallbackServerResult>;
  readonly close: () => Promise<void>;
};

export async function startOAuthCallbackServer(
  options: CallbackServerOptions,
): Promise<OAuthCallbackServer> {
  const expectedPath = options.path ?? "/callback";
  const timeoutMs = options.timeoutMs ?? 120_000;

  let resolveResult!: (value: CallbackServerResult) => void;
  const resultPromise = new Promise<CallbackServerResult>((resolve) => {
    resolveResult = resolve;
  });

  let timer: NodeJS.Timeout | undefined;

  const server = http.createServer((req, res) => {
    if (!req.url) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad Request");
      return;
    }

    const parsedUrl = new URL(req.url, `http://127.0.0.1`);
    if (parsedUrl.pathname !== expectedPath) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const state = parsedUrl.searchParams.get("state");
    const code = parsedUrl.searchParams.get("code");
    const error = parsedUrl.searchParams.get("error");
    const errorDescription = parsedUrl.searchParams.get("error_description") ?? undefined;

    if (error !== null) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><body><h3>Authentication failed</h3><p>You may close this window and return to Trylo.</p></body></html>");
      resolveResult({
        ok: false,
        error,
        ...(errorDescription === undefined ? {} : { errorDescription }),
      });

      return;
    }

    if (state !== options.expectedState) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><body><h3>State verification failed</h3><p>CSRF state mismatch. You may close this window.</p></body></html>");
      resolveResult({
        ok: false,
        error: "state_mismatch",
        errorDescription: "State parameter does not match expected CSRF token",
      });

      return;
    }

    if (code === null || code.trim().length === 0) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><body><h3>Missing authorization code</h3></body></html>");
      resolveResult({
        ok: false,
        error: "missing_code",
        errorDescription: "No authorization code found in callback query",
      });

      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<html><body><h3>Authentication successful!</h3><p>You may now close this window and return to Trylo.</p></body></html>");
    resolveResult({ ok: true, code });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Unable to bind OAuth callback server to an address");
  }

  const port = address.port;
  const redirectUri = `http://127.0.0.1:${port}${expectedPath}`;

  const close = (): Promise<void> => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  timer = setTimeout(() => {
    resolveResult({ ok: false, error: "timeout", errorDescription: "Callback timed out waiting for user authentication" });
    void close();
  }, timeoutMs);

  return {
    port,
    redirectUri,
    waitForResult: async () => {
      try {
        const res = await resultPromise;
        return res;
      } finally {
        await close();
      }
    },
    close,
  };
}
