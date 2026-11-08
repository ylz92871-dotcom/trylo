/**
 * Provider OAuth endpoint allowlist and SSRF prevention (WP Design Decision D3).
 *
 * Provider endpoints are configurable, but default to a pinned allowlist of
 * known safe platforms and local loopback for testing. Untrusted/unknown
 * endpoints are rejected to prevent phishing and SSRF attacks.
 */

export const DEFAULT_ALLOWED_OAUTH_HOSTS: ReadonlySet<string> = new Set([
  "auth.openai.com",
  "api.openai.com",
  "github.com",
  "accounts.google.com",
  "oauth2.googleapis.com",
  "console.anthropic.com",
  "api.anthropic.com",
  "127.0.0.1",
  "localhost",
]);

export type EndpointValidationResult =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly reason: "invalid_url" | "disallowed_protocol" | "untrusted_host" };

/**
 * Validates an OAuth endpoint URL against protocol and host allowlists.
 */
export function validateOAuthEndpoint(
  endpointUrl: string,
  extraAllowedHosts?: ReadonlySet<string>,
): EndpointValidationResult {
  let parsed: URL;

  try {
    parsed = new URL(endpointUrl);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  const isLoopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";

  // Enforce HTTPS for external endpoints; loopback may use HTTP for tests and local servers
  if (parsed.protocol !== "https:" && !(isLoopback && parsed.protocol === "http:")) {
    return { ok: false, reason: "disallowed_protocol" };
  }

  const allowed =
    DEFAULT_ALLOWED_OAUTH_HOSTS.has(parsed.hostname) ||
    (extraAllowedHosts !== undefined && extraAllowedHosts.has(parsed.hostname));

  if (!allowed) {
    return { ok: false, reason: "untrusted_host" };
  }

  return { ok: true, url: parsed };
}

export function isAllowedOAuthEndpoint(
  endpointUrl: string,
  extraAllowedHosts?: ReadonlySet<string>,
): boolean {
  return validateOAuthEndpoint(endpointUrl, extraAllowedHosts).ok;
}
