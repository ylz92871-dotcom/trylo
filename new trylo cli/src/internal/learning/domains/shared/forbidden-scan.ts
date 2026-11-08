export const FORBIDDEN_PAYLOAD_TOKENS = [
  "permission",
  "skip_approval",
  "allow_network",
  "tool_switch",
  "tool_install",
  "workflow_topology",
  "download",
] as const;

const BODY_TOKENS = [
  "skip_approval",
  "allow_network",
  "tool_switch",
  "tool_install",
  "workflow_topology",
  "download",
] as const;

export function scanForbiddenText(texts: readonly string[]): readonly string[] {
  return scanTokens(texts, FORBIDDEN_PAYLOAD_TOKENS);
}

export function scanForbiddenBody(texts: readonly string[]): readonly string[] {
  return scanTokens(texts, BODY_TOKENS);
}

function scanTokens(
  texts: readonly string[],
  tokens: readonly string[],
): readonly string[] {
  const hits: string[] = [];

  for (const text of texts) {
    const lowered = text.toLowerCase();

    for (const claim of tokens) {
      if (lowered.includes(claim)) {
        hits.push(claim);
      }
    }

    if (lowered.includes("curl http") || lowered.includes("npm i ")) {
      hits.push("download");
    }
  }

  return [...new Set(hits)];
}
