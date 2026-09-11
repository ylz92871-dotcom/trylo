// TS declaration for the sidecar's pinned playwright manifest.
//
// Same contract as officecli.d.mts: the renderer-side cross-package tests
// import this manifest WITHOUT turning on allowJs for the whole desktop
// build. The shape mirrors what validateManifest enforces plus the PR-3
// playwright additions (runner / npmDependencies / origin lists).

export interface NpmDependencyPin {
  readonly name: string;
  readonly tarballUrl: string;
  readonly sha256: string;
}

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
    readonly runner?: 'node';
    readonly packageName?: string;
    readonly downloadUrl?: string;
    readonly npmDependencies?: readonly NpmDependencyPin[];
  };
  readonly mcp: {
    readonly serverName: string;
    readonly transport: 'stdio';
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly expectedTools: readonly string[];
    readonly allowedOrigins?: readonly string[];
    readonly blockedOrigins?: readonly string[];
  };
  readonly runtimeDirName?: string;
  readonly activation: 'work-default' | 'explicit-computer' | 'on-demand' | 'developer';
  readonly classifierId: string;
  readonly healthCheck: string;
  readonly telemetry: 'none' | 'forced-off';
  readonly uninstall: string;
}

export declare const PLAYWRIGHT_MANIFEST: Readonly<ToolManifestShape>;
export default PLAYWRIGHT_MANIFEST;
