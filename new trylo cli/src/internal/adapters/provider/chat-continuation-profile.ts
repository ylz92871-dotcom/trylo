import { createHash } from "node:crypto";
import { glmContinuationBinding } from "./glm-continuation-checkpoint.js";

const DEEPSEEK_AGENT_PLAN = {
  identity: "volcano-agent-plan-deepseek-reasoning-v1",
  endpoint: "https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions",
  model: "deepseek-v4.1-flash",
} as const;
const QIANWEN_FLASH = {
  identity: "qianwen-flash-preserved-thinking-v1",
  endpoint: "https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions",
  model: "qwen3.8-flash",
} as const;
const PROFILES = [DEEPSEEK_AGENT_PLAN, QIANWEN_FLASH] as const;

function profileFor(endpoint: string, model: string) {
  const profile = PROFILES.find(candidate => candidate.model === model);
  if (profile === undefined) return undefined;
  try { return new URL(endpoint).href === profile.endpoint ? profile : undefined; }
  catch { return undefined; /* Invalid URLs cannot select a native contract. */ }
}

/** Explicit native-reasoning contracts only. The legacy GLM profile keeps its
 * original endpoint/model rules and binding bytes. DeepSeek's Agent Plan Chat
 * profile requires the complete original assistant reasoning on later tool
 * requests, including assistant answers that did not themselves call a tool.
 * Qianwen Flash documents the same assistant field and explicit preservation
 * control; both reuse the existing adapter-owned capture and restore lifecycle.
 */
export function chatContinuationBinding(endpoint: string, model: string): string | undefined {
  const legacy = glmContinuationBinding(endpoint, model);
  if (legacy !== undefined) return legacy;

  const profile = profileFor(endpoint, model);

  // Bind the native wire contract and exact connection. Only this digest
  // enters the existing private checkpoint, never a URL secret.
  return profile === undefined ? undefined
    : createHash("sha256").update(JSON.stringify([profile.identity, profile.endpoint, model])).digest("hex");
}

/** Model-specific and general service docs disagree about this default.
 * Explicit preservation uses the documented API without changing thinking
 * effort, output allowances or models on other endpoints. */
export function chatContinuationRequestFields(endpoint: string, model: string): { readonly preserve_thinking?: true } {
  return profileFor(endpoint, model) === QIANWEN_FLASH ? { preserve_thinking: true } : {};
}
