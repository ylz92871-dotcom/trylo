import { fields, list, text } from "../../../validation/json-shape.js";

export interface ContentAdvisoryRef { readonly ref: string; readonly version: string }

export function isContentAdvisoryIdentity(value: unknown): value is string {
  return text(value, 512) && !/[\u0000-\u001f]/.test(value);
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return fields(value, keys) && Reflect.ownKeys(value).length === keys.length;
}

export function isContentAdvisoryRef(value: unknown): value is ContentAdvisoryRef {
  return exact(value, ["ref", "version"]) && isContentAdvisoryIdentity(value.ref) && isContentAdvisoryIdentity(value.version);
}

export function isContentAdvisoryRefs(value: unknown): value is readonly ContentAdvisoryRef[] {
  if (!list(value, 0, 32) || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index) || !isContentAdvisoryRef(value[index])) return false;
  }
  return value.every(isContentAdvisoryRef) && new Set(value.map(item => JSON.stringify([item.ref, item.version]))).size === value.length;
}

export const isAdvisoryReportText = (value: unknown): value is string => text(value, 2000);

/** An explicit PA declaration about its own use. It is neither execution proof
 * nor evidence that the advisory improved a task or answered its source purpose. */
export interface AdvisoryUseReport {
  readonly schemaVersion: 1;
  readonly kind: "advisory_use_report";
  readonly turnId: string;
  readonly toolCallId: string;
  readonly advisory: ContentAdvisoryRef;
  readonly deliveryRef: string;
  readonly change: string;
  readonly reason: string;
}

export function isAdvisoryUseReport(value: unknown): value is AdvisoryUseReport {
  return exact(value, ["schemaVersion", "kind", "turnId", "toolCallId", "advisory", "deliveryRef", "change", "reason"])
    && value.schemaVersion === 1 && value.kind === "advisory_use_report" && isContentAdvisoryIdentity(value.turnId)
    && isContentAdvisoryIdentity(value.toolCallId) && isContentAdvisoryRef(value.advisory)
    && isContentAdvisoryIdentity(value.deliveryRef) && isAdvisoryReportText(value.change) && isAdvisoryReportText(value.reason);
}
