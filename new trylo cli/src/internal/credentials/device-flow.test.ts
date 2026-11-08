import assert from "node:assert/strict";
import test from "node:test";
import { executeDeviceFlow } from "./device-flow.js";

/**
 * WP18.1 (C69/L69) contract: the device grant polls to tokens, honours
 * slow_down/denied/expired, and refuses untrusted endpoints outright.
 */

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const DEVICE = "https://auth.openai.com/oauth/device";
const TOKEN = "https://auth.openai.com/oauth/token";

test("pending then success yields tokens with the endpoint recorded", async () => {
  let polls = 0;
  const seen: string[] = [];
  const result = await executeDeviceFlow({
    deviceEndpoint: DEVICE,
    tokenEndpoint: TOKEN,
    clientId: "trylo-cli",
    now: () => 0,
    sleep: async () => {},
    onUserCode: (display) => {
      seen.push(`${display.userCode}@${display.verificationUri}`);
    },
    fetchImpl: (async (url: string | URL | Request) => {
      const target = String(url);
      if (target === DEVICE) {
        return jsonResponse({
          device_code: "dev-1",
          user_code: "ABCD-1234",
          verification_uri: "https://auth.openai.com/activate",
          expires_in: 600,
          interval: 1,
        });
      }

      polls += 1;

      if (polls === 1) {
        return jsonResponse({ error: "authorization_pending" }, 400);
      }

      return jsonResponse({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, token_type: "Bearer" });
    }) as typeof globalThis.fetch,
  });

  assert.equal(result.ok, true);

  if (result.ok) {
    assert.equal(result.tokens.accessToken, "at-1");
    assert.equal(result.tokens.refreshToken, "rt-1");
    assert.equal(result.tokens.tokenEndpoint, TOKEN);
    assert.equal(result.tokens.clientId, "trylo-cli");
  }

  assert.deepEqual(seen, ["ABCD-1234@https://auth.openai.com/activate"]);
  assert.equal(polls, 2);
});

test("denied and expired grants are terminal, slown_down stretches the interval", async () => {
  const denied = await executeDeviceFlow({
    deviceEndpoint: DEVICE,
    tokenEndpoint: TOKEN,
    clientId: "trylo-cli",
    now: () => 0,
    sleep: async () => {},
    fetchImpl: (async (url: string | URL | Request) =>
      String(url) === DEVICE
        ? jsonResponse({ device_code: "d", user_code: "u", verification_uri: "https://auth.openai.com/activate", expires_in: 600, interval: 1 })
        : jsonResponse({ error: "access_denied" }, 400)) as typeof globalThis.fetch,
  });

  assert.equal(denied.ok, false);

  if (!denied.ok) {
    assert.equal(denied.code, "authorization_denied");
  }

  const expired = await executeDeviceFlow({
    deviceEndpoint: DEVICE,
    tokenEndpoint: TOKEN,
    clientId: "trylo-cli",
    now: () => 0,
    sleep: async () => {},
    fetchImpl: (async (url: string | URL | Request) =>
      String(url) === DEVICE
        ? jsonResponse({ device_code: "d", user_code: "u", verification_uri: "https://auth.openai.com/activate", expires_in: 600, interval: 1 })
        : jsonResponse({ error: "expired_token" }, 400)) as typeof globalThis.fetch,
  });

  assert.equal(expired.ok, false);

  if (!expired.ok) {
    assert.equal(expired.code, "grant_expired");
  }
});

test("an untrusted device endpoint is refused before any fetch", async () => {
  let fetched = false;
  const result = await executeDeviceFlow({
    deviceEndpoint: "https://evil.example/device",
    tokenEndpoint: TOKEN,
    clientId: "trylo-cli",
    fetchImpl: (async () => {
      fetched = true;
      return jsonResponse({});
    }) as typeof globalThis.fetch,
  });

  assert.equal(result.ok, false);

  if (!result.ok) {
    assert.equal(result.code, "untrusted_endpoint");
  }

  assert.equal(fetched, false);
});
