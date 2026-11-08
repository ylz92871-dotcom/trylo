import type { JsonObject } from "../../../../../protocol/envelope.js";
import { checkPayload } from "../../../../../protocol/payload-contract.js";

type DetailName = "toolCallId" | "path" | "status" | "component" | "ignored" | "terminalReason" | "reason" | "cause" | "errorClass" | "finishReason";

export type ObjectiveEventDetails = Partial<Readonly<Record<DetailName, string>>> & {
  readonly late?: boolean; readonly omittedFields?: readonly string[];
};

/** Project only the canonical metadata contract. Raw observations, messages and tool values never enter this view. */
export function objectiveEventDetails(kind: "file_write" | "observation" | "terminal", payload: JsonObject): ObjectiveEventDetails | undefined {
  if (!checkPayload(kind, payload).ok) return undefined;

  const fields: readonly DetailName[] = kind === "file_write" ? ["toolCallId", "path", "status"]
    : kind === "observation" ? ["component", "ignored", "terminalReason"] : ["reason", "cause", "errorClass", "finishReason"];
  const details: Partial<Record<DetailName, string>> = {}, omittedFields: string[] = [];

  for (const field of fields) {
    const value = payload[field];
    if (typeof value !== "string") continue;
    if (value.length <= 512) details[field] = value;
    else omittedFields.push(field);
  }

  return { ...details, ...(kind === "observation" && typeof payload.late === "boolean" ? { late: payload.late } : {}),
    ...(omittedFields.length === 0 ? {} : { omittedFields }) };
}
