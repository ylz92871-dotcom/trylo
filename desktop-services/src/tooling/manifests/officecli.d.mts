// TS declaration for the sidecar's pinned officecli manifest.
//
// desktop (TS) never imports tooling LOGIC across the package boundary, but
// the renderer-side risk classifier must pin the same identity triple the
// manifest carries (classifierId / mcp.serverName / mcp.expectedTools, spec
// §3). A `.d.mts` keeps that one cross-package contract test typed without
// turning on allowJs for the whole desktop build.

export interface ToolManifestShape {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly adoption: 'stable' | 'trial' | 'developer';
  readonly source: { readonly repository: string; readonly license: string; readonly releaseUrl: string };
  readonly artifact: {
    readonly platform: string;
    readonly archiveSha256: string;
    readonly executableRelativePath: string;
    readonly installStrategy: 'release-archive' | 'pinned-npm' | 'pinned-python-env';
    readonly downloadUrl?: string;
  };
  readonly mcp: {
    readonly serverName: string;
    readonly transport: 'stdio';
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly expectedTools: readonly string[];
  };
  readonly activation: 'work-default' | 'explicit-computer' | 'on-demand' | 'developer';
  readonly classifierId: string;
  readonly healthCheck: string;
  readonly telemetry: 'none' | 'forced-off';
  readonly uninstall: string;
}

export declare const OFFICECLI_MANIFEST: Readonly<ToolManifestShape>;
export default OFFICECLI_MANIFEST;
