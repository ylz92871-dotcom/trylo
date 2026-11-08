/** JSON data primitives; callers bound text before parsing and validate domain-specific relations. */
export function fields(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum
    && hasOnlyUnicodeScalars(value);
}

/** Unicode-mode matching rejects lone surrogates while accepting complete pairs.
 * Validation scans native string storage without allocating a code-point array. */
export function hasOnlyUnicodeScalars(value: string): boolean {
  return !/[\uD800-\uDFFF]/u.test(value);
}

export function identity(value: unknown): value is string {
  return text(value, 256) && !/[\u0000-\u001f]/.test(value);
}

export function sequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function list(value: unknown, minimum: number, maximum: number): value is unknown[] {
  return Array.isArray(value) && value.length >= minimum && value.length <= maximum;
}
