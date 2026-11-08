import { createRequire } from "node:module";

// The pinned manager remains authoritative for legacy namespaces/tool names.
// This boundary reads its exports; it never starts or rewrites that service.
const manager: unknown = createRequire(import.meta.url)("../vendor/legacy/hermes-capability-manager.js");
if (typeof manager !== "object" || manager === null || !("SERVER_NAME" in manager) || typeof manager.SERVER_NAME !== "string"
  || !("LEARNING_SERVER_NAME" in manager) || typeof manager.LEARNING_SERVER_NAME !== "string"
  || !("LEARNING_ALLOWED_TOOLS" in manager) || !Array.isArray(manager.LEARNING_ALLOWED_TOOLS)
  || !manager.LEARNING_ALLOWED_TOOLS.every((name: unknown) => typeof name === "string"
    && name.startsWith(`mcp__${manager.LEARNING_SERVER_NAME}__`))) throw new Error("hermes_legacy_profile_invalid");

export const HERMES_LEGACY_SERVER_NAME = manager.SERVER_NAME;
const prefix = `mcp__${manager.LEARNING_SERVER_NAME}__`;
const skillTools: ReadonlySet<string> = new Set(manager.LEARNING_ALLOWED_TOOLS.map((name: string) =>
  `mcp__${HERMES_LEGACY_SERVER_NAME}__${name.slice(prefix.length)}`));
export const isLegacyHermesSkillTool = (qualifiedName: string): boolean => skillTools.has(qualifiedName);
