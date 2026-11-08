import type { JsonObject } from "../../../../protocol/envelope.js";
import { contentHashOf } from "../../../control/hash.js";

export type HermesSkillRead = { readonly name: string; readonly contentHash: string;
  /** Normal native renderer's complete body before directory substitution. Older
   * native replies omit it and cannot establish an exact approved-version load. */
  readonly rawContentHash?: string };

export const MAX_HERMES_SKILL_READ_FACTS = 32;
const NATIVE_VIEW_NAMES = new Set(["skill_view", "mcp__trylo-hermes-capabilities__skill_view",
  "mcp__trylo-hermes-learning__skill_view", "mcp__trylo-hermes-skills__skill_view"]);

/** A native instruction load is a reuse observation, never evidence of task success. */
export function hermesSkillRead(call: { readonly name: string; readonly arguments: JsonObject }, output: string,
  trustedServerName?: string): HermesSkillRead | undefined {
  const file = call.arguments.file_path;
  // History has no live profile authority: another library's same-shaped reply
  // is not a Hermes read. Only the mounted observer lends its actual profile name.
  const owned = NATIVE_VIEW_NAMES.has(call.name) || trustedServerName !== undefined && call.name === `mcp__${trustedServerName}__skill_view`;
  if (!owned || file != null && file !== "" && file !== "SKILL.md") return undefined;

  let body: unknown;

  try { body = JSON.parse(output); }
  catch { return undefined; /* A malformed or truncated native reply cannot prove an instruction load. */ }

  if (typeof body !== "object" || body === null || Array.isArray(body) || !("success" in body) || body.success !== true
    || !("content" in body) || typeof body.content !== "string" || !("name" in body)) return undefined;

  // The native response resolves aliases/frontmatter names; recording the
  // request's identifier would split usage and later feedback attribution.
  const name = body.name;
  const raw = "tryloRawInstructionHash" in body && typeof body.tryloRawInstructionHash === "string"
    && /^[a-f0-9]{64}$/.test(body.tryloRawInstructionHash) ? body.tryloRawInstructionHash : undefined;

  return typeof name === "string" && name.trim() && name.length <= 512 ? { name, contentHash: contentHashOf(body.content),
    ...(raw === undefined ? {} : { rawContentHash: raw }) } : undefined;
}

/** Compatibility for consumers that need only the native identity. */
export function hermesSkillReadName(call: { readonly name: string; readonly arguments: JsonObject }, output: string,
  trustedServerName?: string): string | undefined {
  return hermesSkillRead(call, output, trustedServerName)?.name;
}
