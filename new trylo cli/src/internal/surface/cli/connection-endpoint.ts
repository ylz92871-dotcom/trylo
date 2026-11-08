export type EndpointResult =
  | { readonly ok: true; readonly endpoint: string }
  | { readonly ok: false; readonly code: "invalid_endpoint"; readonly detail: string };

/** Form-only normalization. Existing persisted endpoints are never silently rewritten. */
export function normalizeChatEndpoint(address: string, kind: "base-url" | "endpoint" = "base-url"): EndpointResult {
  let url: URL;

  try {
    url = new URL(address.trim());
  } catch {
    return { ok: false, code: "invalid_endpoint", detail: "Enter an absolute http/https service address." };
  }

  if (!["http:", "https:"].includes(url.protocol) || url.username !== "" || url.password !== "") {
    return { ok: false, code: "invalid_endpoint", detail: "Use http/https without credentials in the address; enter the key separately." };
  }

  url.hash = "";

  if (kind === "base-url") {
    const base = url.pathname.replace(/\/+$/, "");
    url.pathname = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
  }

  return { ok: true, endpoint: url.toString() };
}
