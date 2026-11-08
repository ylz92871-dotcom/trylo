import type { JsonValue } from "../../protocol/envelope.js";

/** Plain finite JSON at runtime boundaries. The caller owns its depth policy. */
export function isJsonData(value: unknown, maxDepth: number): value is JsonValue {
  return visitJson(value, 0, new Set<object>(), maxDepth);
}

export function recordOf(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

export function keysAre(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => allowed.has(key));
}

export function textOf(value: unknown, maxChars?: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && (maxChars === undefined || value.length <= maxChars);
}

export function isDigest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }

function visitJson(value: unknown, depth: number, seen: Set<object>, maxDepth: number): value is JsonValue {
  if (depth > maxDepth) return false;

  if (value === null || typeof value === "string" || typeof value === "boolean") return true;

  if (typeof value === "number") return Number.isFinite(value);

  if (typeof value !== "object" || seen.has(value)) return false;

  const children = jsonChildren(value);
  if (children === undefined) return false;

  seen.add(value);
  const valid = children.every(child => visitJson(child, depth + 1, seen, maxDepth));

  seen.delete(value);

  return valid;
}

function jsonChildren(value: object): readonly unknown[] | undefined {
  if (Object.getOwnPropertySymbols(value).length > 0) return undefined;

  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
    });
  }

  if (!recordOf(value)) return undefined;

  const descriptors = Object.values(Object.getOwnPropertyDescriptors(value));
  if (descriptors.some(descriptor => !descriptor.enumerable || !Object.hasOwn(descriptor, "value"))) return undefined;

  return descriptors.map(descriptor => descriptor.value);
}

export function utf8Bytes(text: string): number { return new TextEncoder().encode(text).length; }

export function jsonBytes(value: unknown): number { return utf8Bytes(JSON.stringify(value)); }
