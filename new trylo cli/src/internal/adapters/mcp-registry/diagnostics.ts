import type { McpRegistryDiagnostic, McpRegistryFailure, McpRegistryOk } from "../../ports/mcp-registry.js";

/** Keep the original failure internally; paths and parser detail never enter warnings. */
export function retainRuntimeView<T>(runtime: McpRegistryOk<T>, failure: McpRegistryFailure): McpRegistryOk<T> {
  return { ...runtime, diagnostics: [...(runtime.diagnostics ?? []), {
    source: "base", coverage: "runtime_only", code: failure.code, detail: failure.detail,
  }] };
}

export function registryDiagnosticWarning(diagnostic: McpRegistryDiagnostic): string {
  return `mcp_registry_partial:${diagnostic.source}:${diagnostic.code}:${diagnostic.coverage}`;
}

export function publicRegistryDiagnostic({ source, coverage, code }: McpRegistryDiagnostic): Omit<McpRegistryDiagnostic, "detail"> {
  return { source, coverage, code };
}
