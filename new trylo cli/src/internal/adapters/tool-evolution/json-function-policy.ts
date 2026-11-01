import { Script } from "node:vm";
import { TOOL_EVOLUTION_MAX_SOURCE_BYTES } from "../../learning/domains/tool/evolution/contracts.js";

export type JsonFunctionSourceCheck = { readonly ok: true; readonly program: string }
  | { readonly ok: false; readonly code: "invalid_script_source" | "script_host_api_forbidden" | "script_syntax_error" };

/** Conservative profile admission, not a malware detector or an OS security boundary. */
export function checkJsonFunctionSource(source: string): JsonFunctionSourceCheck {
  if (Buffer.byteLength(source, "utf8") > TOOL_EVOLUTION_MAX_SOURCE_BYTES || source.includes("\0")) return { ok: false, code: "invalid_script_source" };
  const exportAssignment = /^\s*module\s*\.\s*exports\s*=\s*/.exec(source);
  if (exportAssignment === null) return { ok: false, code: "invalid_script_source" };
  const body = source.slice(exportAssignment[0].length);
  // Reject escapes and host vocabulary even in comments/strings; false negatives are preferable to hidden IO.
  if (/\\u|\b(?:module|exports|require|import|process|global|globalThis|this|eval|Function|WebAssembly|Buffer|console|__filename|__dirname)\b/.test(body)) {
    return { ok: false, code: "script_host_api_forbidden" };
  }
  const program = `"use strict";\n${source}`;
  try { new Script(program, { filename: "candidate.cjs" }); }
  catch { return { ok: false, code: "script_syntax_error" }; }
  return { ok: true, program };
}
