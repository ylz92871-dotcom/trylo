import { isSkillIssueReference } from "./command-input.js";
import type { HermesSkillAllowance } from "../contracts.js";

export type SkillExplicitInput = { readonly workspaceRoot: string; readonly sessionId: string; readonly turnId?: string;
  readonly learnRequest: string; readonly allowance: HermesSkillAllowance };

export function isSkillExplicitInput(value: unknown): value is SkillExplicitInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;

  const input = value as Record<string, unknown>, allowance = input.allowance;

  return Object.keys(input).every(key => ["workspaceRoot", "sessionId", "turnId", "learnRequest", "allowance"].includes(key))
    && typeof input.workspaceRoot === "string" && input.workspaceRoot.trim().length > 0 && input.workspaceRoot.length <= 4096 && !/[\u0000-\u001f]/u.test(input.workspaceRoot)
    && isSkillIssueReference(input.sessionId) && (input.turnId === undefined || isSkillIssueReference(input.turnId))
    && typeof input.learnRequest === "string" && !!input.learnRequest.trim() && input.learnRequest.length <= 2000
    && allowance !== null && typeof allowance === "object" && !Array.isArray(allowance)
    && Object.keys(allowance).every(key => key === "maxCalls" || key === "maxOutputTokens")
    && "maxCalls" in allowance && Number.isSafeInteger(allowance.maxCalls) && Number(allowance.maxCalls) >= 0
    && "maxOutputTokens" in allowance && Number.isSafeInteger(allowance.maxOutputTokens) && Number(allowance.maxOutputTokens) >= 0;
}
