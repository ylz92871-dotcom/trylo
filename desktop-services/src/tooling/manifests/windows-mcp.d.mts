// TS declaration for the pinned Windows-MCP manifest (PR-6). Renderer-side
// cross-package contract tests import the manifest value without turning on
// allowJs for the whole desktop package — same pattern as officecli.d.mts /
// playwright.d.mts.

export interface WindowsMcpManifestShape {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly adoption: string;
  readonly source: {
    readonly repository: string;
    readonly license: string;
    readonly releaseUrl: string;
  };
  readonly artifact: {
    readonly platform: string;
    readonly archiveSha256: string;
    readonly executableRelativePath: string;
    readonly installStrategy: 'pinned-python-env';
    readonly downloadUrl: string;
    readonly uvLockSha256: string;
    readonly sourceCommit: string;
    readonly pythonPackage: string;
  };
  /** WCC-P2-05 (spec §19.8): the pinned .NET WGC capture helper. */
  readonly helper: {
    readonly kind: 'dotnet-single-file';
    readonly protocolVersion: number;
    readonly executableRelativePath: string;
    readonly packagedDirName: string;
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly sourceTree: string;
  };
  readonly mcp: {
    readonly serverName: string;
    readonly transport: 'stdio';
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly expectedTools: readonly string[];
  };
  readonly activation: 'explicit-computer';
  readonly classifierId: string;
  readonly healthCheck: string;
  readonly telemetry: 'forced-off';
  readonly uninstall: string;
}

export declare const WINDOWS_MCP_ALLOWED_TOOLS: readonly string[];
export declare const WINDOWS_MCP_DENIED_TOOLS: readonly string[];
export declare const WINDOWS_MCP_TOOLS_ARG: string;
export declare const WINDOWS_MCP_SOURCE_COMMIT: string;
export declare const WINDOWS_MCP_MANIFEST: WindowsMcpManifestShape;
export default WINDOWS_MCP_MANIFEST;
