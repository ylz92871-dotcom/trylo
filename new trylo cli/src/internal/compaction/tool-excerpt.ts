/**
 * Bounded extractive evidence, not a semantic fact detector. Prefer distinctive
 * lines over repeated/indexed boilerplate so a short middle observation is not
 * always displaced by a log's first counters. Retain original line order and
 * label omissions; the journal and the original read source remain authoritative.
 */
export function toolOutputExcerpt(output: string, maxChars: number): string {
  const flat = output.replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) return flat;

  const marker = " [excerpt; re-read source]";
  if (maxChars <= marker.length) return marker.trimStart().slice(0, Math.max(0, maxChars));

  const lines = output.split(/\r?\n/).map((text, index) => ({
    text: text.replace(/\s+/g, " ").trim(), index,
  })).filter(line => line.text.length > 0);
  const frequency = new Map<string, number>();
  const signature = (text: string): string => text.replace(/\d+/g, "#");

  for (const line of lines) {
    const key = signature(line.text);
    frequency.set(key, (frequency.get(key) ?? 0) + 1);
  }

  const seen = new Set<string>();
  const candidates = lines.filter(line => {
    if (seen.has(line.text)) return false;
    seen.add(line.text);
    return true;
  }).sort((a, b) => (frequency.get(signature(a.text)) ?? 0) - (frequency.get(signature(b.text)) ?? 0) || a.index - b.index);
  const selected = candidates.slice(0, 3).sort((a, b) => a.index - b.index);
  if (selected.length === 0) return marker.trimStart().slice(0, maxChars);

  const perLine = Math.floor((maxChars - marker.length - (selected.length - 1) * 3) / selected.length);
  const excerpts = selected.map(line => `line ${line.index + 1}: ${line.text}`.slice(0, Math.max(0, perLine)));

  return excerpts.join(" | ").slice(0, maxChars - marker.length) + marker;
}
