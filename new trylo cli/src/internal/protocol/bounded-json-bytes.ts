/** Exact serialized byte count for bounded plain JSON; no full JSON string is allocated. */
export function boundedJsonBytes(value: unknown, limit: number): number | undefined {
  if (value === undefined || !Number.isSafeInteger(limit) || limit < 0) return undefined;

  let remaining = limit, nodes = 0;
  const seen = new Set<object>();
  const charge = (bytes: number) => (remaining -= bytes) >= 0;

  function text(value: string): boolean {
    if (value.length > remaining || !charge(2)) return false;

    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      let bytes = code < 0x80 ? 1 : code < 0x800 ? 2 : 3;

      if (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code)) bytes = 2;
      else if (code < 32) bytes = 6;
      else if (code >= 0xd800 && code <= 0xdfff) {
        const next = value.charCodeAt(index + 1);
        if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
          bytes = 4;
          index++;
        }
        else bytes = 6;
      }

      if (!charge(bytes)) return false;
    }

    return true;
  }

  function visit(item: unknown, depth: number): boolean {
    if (++nodes > 4096 || depth > 32) return false;

    if (typeof item === "string") return text(item);

    if (item === null || item === undefined) return charge(4);

    if (typeof item === "boolean") return charge(item ? 4 : 5);

    if (typeof item === "number") return Number.isFinite(item) && charge(String(item).length);

    if (typeof item !== "object" || seen.has(item)) return false;

    seen.add(item);

    try {
      if (!charge(2)) return false;

      if (Array.isArray(item)) {
        if (item.length > remaining) return false;
        for (let index = 0; index < item.length; index++) {
          if (index > 0 && !charge(1) || !visit(item[index], depth + 1)) return false;
        }
        return true;
      }

      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false;

      let first = true;

      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        if (++nodes > 4096) return false;
        const child = (item as Record<string, unknown>)[key];
        if (child === undefined) continue;
        if (!first && !charge(1) || !text(key) || !charge(1) || !visit(child, depth + 1)) return false;
        first = false;
      }

      return true;
    } finally { seen.delete(item); }
  }

  return visit(value, 0) ? limit - remaining : undefined;
}
