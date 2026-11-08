export const MAX_MCP_DESCRIPTION_LENGTH = 2048;

const INJECTION_MARKERS = [
  "ignore previous instructions",
  "ignore all previous",
  "system:",
  "<system>",
  "you are now",
  "do not follow",
];

export type DescriptionGuardResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: "prompt_injection" | "empty_description"; readonly text: string };

export function sanitizeToolDescription(raw: string): DescriptionGuardResult {
  const stripped = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
  if (stripped.length === 0) {
    return { ok: false, code: "empty_description", text: "" };
  }

  const lower = stripped.toLowerCase();

  for (const marker of INJECTION_MARKERS) {
    if (lower.includes(marker)) {
      return { ok: false, code: "prompt_injection", text: stripped.slice(0, MAX_MCP_DESCRIPTION_LENGTH) };
    }
  }

  if (stripped.length > MAX_MCP_DESCRIPTION_LENGTH) {
    return { ok: true, text: stripped.slice(0, MAX_MCP_DESCRIPTION_LENGTH) };
  }

  return { ok: true, text: stripped };
}
