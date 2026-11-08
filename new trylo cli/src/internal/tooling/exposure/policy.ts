import { err, ok, type Result } from "../contract/result.js";

/**
 * WP16 C49/L08 MCP exposure policy — which tools the model may see and in
 * which form.
 *
 * Reused mechanics:
 * - Codex `spec_plan apply_mcp_tool_exposure_policy`: per-server
 *   `omit_tools_from` subtraction, code-mode `direct_only` namespace
 *   subtraction, then the deferred split — when search is on and a deferred
 *   tool exists the router hides `DIRECT`, otherwise it hides `DEFERRED` —
 *   mapped onto the six states
 *   Hidden/CodeModeOnly/DirectModelOnly/Direct/DeferredModelOnly/Deferred.
 * - legacy `tools.ts filterToolsByDenyRules` + `permissions toolMatchesRule`:
 *   an `undefined` rule content denies the whole tool; `mcp__<server>` and
 *   `mcp__<server>__*` deny the whole server.
 *
 * This module collapses the six Codex states onto the four Trylo-visible
 * exposures the catalog already reasons about. Deny rules win over exposure:
 * a denied tool is hidden no matter what the policy computed.
 */

export type ToolExposure = "hidden" | "direct" | "deferred" | "code_mode_only";

export type ExposurePolicyInput = {
  readonly omitTools: ReadonlyArray<string>;
  readonly codeModeDirectOnly: ReadonlyArray<string>;
  readonly searchEnabled: boolean;
  readonly hasDeferred: boolean;
  readonly codeMode: boolean;
};

export type ExposureFailure = "tool_hidden" | "code_mode_only" | "tool_denied";

export function exposureForTool(
  toolName: string,
  namespace: string | undefined,
  policy: ExposurePolicyInput,
): ToolExposure {
  if (policy.omitTools.includes(toolName)) {
    return "hidden";
  }

  if (namespace !== undefined && policy.codeModeDirectOnly.includes(namespace)) {
    return policy.codeMode ? "direct" : "code_mode_only";
  }

  if (policy.searchEnabled && policy.hasDeferred) {
    return "deferred";
  }

  return "direct";
}

/**
 * Split `mcp__<server>[__<tool>]` exactly like legacy
 * `services/mcp/mcpStringUtils.mcpInfoFromString`: split on `__`, require the
 * `mcp` head and a non-empty server name, rejoin the remainder. A rule with
 * no tool part (`mcp__gh`) or a `*` tool part (`mcp__gh__*`) strips the whole
 * server; anything else only matches itself (via the direct comparison).
 */
function mcpInfoOf(value: string): { serverName: string; toolName: string | undefined } | undefined {
  const parts = value.split("__");
  const [mcpPart, serverName, ...toolParts] = parts;
  if (mcpPart !== "mcp" || serverName === undefined || serverName.length === 0) {
    return undefined;
  }
  return { serverName, toolName: toolParts.length > 0 ? toolParts.join("__") : undefined };
}

export function toolDeniedByRules(toolName: string, denyRules: ReadonlyArray<string>): boolean {
  for (const rule of denyRules) {
    if (rule === toolName) {
      return true;
    }

    const ruleInfo = mcpInfoOf(rule);
    const toolInfo = mcpInfoOf(toolName);
    if (
      ruleInfo !== undefined &&
      toolInfo !== undefined &&
      (ruleInfo.toolName === undefined || ruleInfo.toolName === "*") &&
      ruleInfo.serverName === toolInfo.serverName
    ) {
      return true;
    }
  }
  return false;
}

export function exposureAllowsCall(
  exposure: ToolExposure,
  input: { readonly codeMode: boolean; readonly denied: boolean },
): Result<{ readonly via: "direct" | "deferred" }, ExposureFailure> {
  if (input.denied) {
    return err("tool_denied", "tool is denied by allow/deny rules");
  }

  if (exposure === "hidden") {
    return err("tool_hidden", "tool is hidden by the exposure policy");
  }

  if (exposure === "code_mode_only" && !input.codeMode) {
    return err("code_mode_only", "tool is available in code mode only");
  }

  if (exposure === "deferred") {
    return ok({ via: "deferred" });
  }

  return ok({ via: "direct" });
}
