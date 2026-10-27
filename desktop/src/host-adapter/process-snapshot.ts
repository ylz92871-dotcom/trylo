/** Only a structurally valid registry can witness an immutable id's absence. */
export function registeredProcessIds(snapshot: unknown): ReadonlySet<string> {
  if (!Array.isArray(snapshot)) throw new Error('Native process list is not an array.');
  const ids = new Set<string>();
  for (const row of snapshot) {
    if (typeof row !== 'object' || row === null || !('id' in row) || typeof row.id !== 'string' || row.id.trim() === '') {
      throw new Error('Native process list contains an invalid id.');
    }
    ids.add(row.id);
  }
  return ids;
}
