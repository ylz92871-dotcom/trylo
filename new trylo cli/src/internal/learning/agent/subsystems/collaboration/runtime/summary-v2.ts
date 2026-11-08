/** Bounded task/hand-off excerpts are learning evidence, never a copy of full conversation history. */
export function collaborationExcerptV2(value: unknown, max = 900): string {
  if (typeof value !== "string") return "unavailable";
  return value.replace(/\bsk-[a-zA-Z0-9_-]{16,}\b/g, "[credential-redacted]")
    .replace(/\b(api[_-]?key|authorization|password|access[_-]?token)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, max);
}
