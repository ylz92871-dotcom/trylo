// TS declaration for the sidecar's pinned jlceda-mcp manifest (see officecli.d.mts).
//
// desktop (TS) never imports tooling LOGIC across the package boundary, but
// the renderer-side risk classifier must pin the same identity triple the
// manifest carries (classifierId / mcp.serverName / mcp.expectedTools,
// TRYLO-CAD-EDA-TOOL-ADAPTER §7). A `.d.mts` keeps that cross-package
// contract test typed without turning on allowJs for the desktop build.

interface CadToolManifestShape {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly adoption: 'stable' | 'trial' | 'developer';
  readonly source: { readonly repository: string; readonly license: string; readonly releaseUrl?: string };
  readonly mcp: {
    readonly serverName: string;
    readonly transport: 'stdio';
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly expectedTools: readonly string[];
  };
  readonly artifact: Record<string, unknown>;
  readonly installCondition?: Record<string, unknown>;
  readonly activation: string;
  readonly classifierId: string;
  readonly healthCheck: string;
  readonly telemetry: string;
  readonly uninstall: string;
}

export declare const JLCEDA_MCP_MANIFEST: Readonly<CadToolManifestShape>;
export default JLCEDA_MCP_MANIFEST;
