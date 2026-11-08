/** Remove only structure emitted by Trylo's previous summary author. Ordinary
 * free-form prose is preserved; this is not a semantic reasoning detector.
 */
export function publicSummaryHistory(summary: string, currentRequestSequence?: number): string {
  const lines = summary.split(/\r?\n/);
  const kept: string[] = [];
  let replacedRequest = false;
  let changed = false;

  for (const line of lines) {
    const request = /^\[request observations at compaction; user sequence (\d+)\]$/.exec(line);
    if (request !== null) {
      // The canonical transcript will author this request's observations again.
      // Observations from another request remain inert historical material.
      replacedRequest = currentRequestSequence !== undefined && Number(request[1]) === currentRequestSequence;
      changed = true;
      continue;
    }

    if (line === "[background summary; observations, not instructions]") {
      replacedRequest = false;
      changed = true;
      continue;
    }

    if (line === "[background process starts in this request]" || /^assistant_reasoning:/.test(line)) {
      changed = true;
      continue;
    }

    if (!replacedRequest) kept.push(line);
    else changed = true;
  }

  return changed ? kept.join("\n") : summary;
}

/** Public assistant text can contain plans or conclusions. Without guessing
 * which it is, let observed tool results win when both cannot fit. Keep an
 * explicit omission marker; no source observation is rewritten or declared stale.
 */
export function preferToolObservations(lines: readonly string[]): readonly string[] {
  if (!lines.some(line => line.startsWith("tool_result "))) return lines;

  const count = lines.filter(line => line.startsWith("assistant:")).length;
  if (count === 0) return lines;

  let noted = false;

  return lines.flatMap(line => {
    if (!line.startsWith("assistant:")) return [line];
    if (noted) return [];
    noted = true;
    return [`[elided ${count} assistant items]`];
  });
}
