import { validateOAuthEndpoint } from "./oauth-endpoints.js";

/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) for login (WP18.1: C69/L69).
 *
 * Reuse: Codex login/device account wiring
 * (`cli/src/main.rs:1588 login`; `model-provider/src/auth.rs:211` scoped
 * auth) and the existing PKCE orchestrator's shape (`oauth-flow.ts`):
 * endpoint allowlisting, injected fetch/clock, terminal failure vocabulary.
 * The device flow differs in exactly one way — the authorization happens on
 * another device, so this process polls instead of serving a loopback
 * callback — and that difference is the only new code here.
 *
 * Failure honesty: without a device authorization endpoint there is no flow.
 * `executeDeviceFlow` refuses with `untrusted_endpoint`/`device_unavailable`
 * rather than synthesising a subscription login Trylo cannot prove, and a
 * denied or expired grant is terminal, never retried into success.
 */

export type DeviceFlowConfig = {
  readonly deviceEndpoint: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly scope?: string;
  readonly extraAllowedHosts?: ReadonlySet<string>;
  /** Maximum poll rounds before giving up (each round waits `interval`). */
  readonly maxPolls?: number;
  readonly now?: (() => number) | undefined;
  readonly onUserCode?: (display: DeviceDisplay) => Promise<void> | void;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly sleep?: (ms: number) => Promise<void>;
};

export type DeviceDisplay = {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly expiresIn: number;
};

export type DeviceTokens = {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
  readonly tokenType?: string;
  readonly scope?: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
};

export type DeviceFlowResult =
  | { readonly ok: true; readonly tokens: DeviceTokens }
  | {
      readonly ok: false;
      readonly code:
        | "untrusted_endpoint"
        | "device_unavailable"
        | "authorization_denied"
        | "grant_expired"
        | "poll_exhausted"
        | "token_error";
      readonly detail: string;
    };

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_MAX_POLLS = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export async function executeDeviceFlow(config: DeviceFlowConfig): Promise<DeviceFlowResult> {
  const now = config.now ?? Date.now;
  const doFetch = config.fetchImpl ?? globalThis.fetch;
  const sleep = config.sleep ?? defaultSleep;
  const deviceValidation = validateOAuthEndpoint(config.deviceEndpoint, config.extraAllowedHosts);
  if (!deviceValidation.ok) {
    return {
      ok: false,
      code: "untrusted_endpoint",
      detail: `deviceEndpoint refused: ${deviceValidation.reason} (${config.deviceEndpoint})`,
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

  // 1. Ask for the device/user codes.
  let deviceRes: Response;

  try {
    const body = new URLSearchParams({ client_id: config.clientId });

    if (config.scope !== undefined && config.scope.length > 0) {
      body.set("scope", config.scope);
    }

    deviceRes = await doFetch(config.deviceEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
    });
  } catch (error) {
    return {
      ok: false,
      code: "device_unavailable",
      detail: `device endpoint unreachable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!deviceRes.ok) {
    return {
      ok: false,
      code: "device_unavailable",
      detail: `device authorization refused: HTTP ${deviceRes.status}`,
    };
  }

  const devicePayload: unknown = await deviceRes.json();
  if (!isRecord(devicePayload)) {
    return { ok: false, code: "device_unavailable", detail: "device endpoint returned no document" };
  }

  const deviceCode = asString(devicePayload["device_code"]);
  const userCode = asString(devicePayload["user_code"]);
  const verificationUri = asString(devicePayload["verification_uri"]);
  if (deviceCode === undefined || userCode === undefined || verificationUri === undefined) {
    return { ok: false, code: "device_unavailable", detail: "device endpoint omitted device_code, user_code or verification_uri" };
  }

  const expiresIn = asNumber(devicePayload["expires_in"]) ?? 600;
  let interval = asNumber(devicePayload["interval"]) ?? 5;
  if (!(interval > 0)) {
    interval = 5;
  }

  const startedAt = now();

  await config.onUserCode?.({
    userCode,
    verificationUri,
    ...(asString(devicePayload["verification_uri_complete"]) === undefined
      ? {}
      : { verificationUriComplete: asString(devicePayload["verification_uri_complete"]) as string }),
    expiresIn,
  });

  // 2. Poll until the grant resolves, slows down, is denied, or expires.
  const maxPolls = config.maxPolls ?? DEFAULT_MAX_POLLS;

  for (let poll = 0; poll < maxPolls; poll += 1) {
    if (now() - startedAt >= expiresIn * 1000) {
      return { ok: false, code: "grant_expired", detail: "device grant expired before authorization" };
    }

    await sleep(interval * 1000);
    let tokenRes: Response;

    try {
      tokenRes = await doFetch(config.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          grant_type: DEVICE_GRANT,
          device_code: deviceCode,
          client_id: config.clientId,
        }).toString(),
      });
    } catch (error) {
      return {
        ok: false,
        code: "token_error",
        detail: `network error polling token endpoint: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (tokenRes.ok) {
      const payload: unknown = await tokenRes.json();
      if (!isRecord(payload)) {
        return { ok: false, code: "token_error", detail: "token endpoint returned no document" };
      }

      const accessToken = asString(payload["access_token"]);
      if (accessToken === undefined || accessToken.length === 0) {
        return { ok: false, code: "token_error", detail: "token response missing valid access_token" };
      }

      const expiresInSecs = asNumber(payload["expires_in"]);

      return {
        ok: true,
        tokens: {
          accessToken,
          ...(asString(payload["refresh_token"]) === undefined
            ? {}
            : { refreshToken: asString(payload["refresh_token"]) as string }),
          ...(expiresInSecs === undefined || !(expiresInSecs > 0)
            ? {}
            : { expiresAt: new Date(now() + expiresInSecs * 1000).toISOString() }),
          ...(asString(payload["token_type"]) === undefined
            ? {}
            : { tokenType: asString(payload["token_type"]) as string }),
          ...(asString(payload["scope"]) === undefined
            ? {}
            : { scope: asString(payload["scope"]) as string }),
          tokenEndpoint: config.tokenEndpoint,
          clientId: config.clientId,
        },
      };
    }

    let errorCode = "";

    try {
      const errorPayload = (await tokenRes.json()) as { error?: string; error_description?: string };

      errorCode = errorPayload.error ?? "";

      if (errorCode === "authorization_pending") {
        continue;
      }

      if (errorCode === "slow_down") {
        interval += 5;
        continue;
      }

      if (errorCode === "access_denied") {
        return { ok: false, code: "authorization_denied", detail: "authorization was denied on the device" };
      }

      if (errorCode === "expired_token") {
        return { ok: false, code: "grant_expired", detail: "device_code expired before authorization" };
      }

      return {
        ok: false,
        code: "token_error",
        detail: `token poll failed: ${errorPayload.error_description ?? errorCode !== "" ? errorCode : `HTTP ${tokenRes.status}`}`,
      };
    } catch {
      return { ok: false, code: "token_error", detail: `token poll failed: HTTP ${tokenRes.status}` };
    }
  }

  return { ok: false, code: "poll_exhausted", detail: "device grant was not authorized in time" };
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
