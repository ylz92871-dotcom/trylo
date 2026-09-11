// TS declaration for the sidecar's pinned chrome-devtools manifest.
//
// Same contract as playwright.d.mts: the renderer-side cross-package tests
// import this manifest WITHOUT turning on allowJs for the whole desktop
// build. The shape mirrors what validateManifest enforces; note the
// BUNDLED closure — `npmDependencies` is an empty array because the
// 1.8.0 tarball rolls its whole runtime into build/src.

export declare const CHROME_DEVTOOLS_MANIFEST: Readonly<{
  readonly schemaVersion: 1;
  readonly id: 'chrome-devtools';
  readonly displayName: string;
  readonly version: '1.8.0';
  readonly adoption: 'trial';
  readonly source: { readonly repository: string; readonly license: string; readonly releaseUrl: string };
  readonly artifact: {
    readonly platform: string;
    readonly archiveSha256: string;
    readonly executableRelativePath: string;
    readonly installStrategy: 'pinned-npm';
    readonly runner: 'node';
    readonly packageName: 'chrome-devtools-mcp';
    readonly downloadUrl: string;
    readonly npmDependencies: readonly [];
  };
  readonly mcp: {
    readonly serverName: 'trylo-chrome';
    readonly transport: 'stdio';
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly expectedTools: readonly string[];
  };
  readonly activation: 'on-demand';
  readonly classifierId: 'chrome-devtools';
  readonly healthCheck: 'version-handshake';
  readonly telemetry: 'forced-off';
  readonly uninstall: 'remove-version-directory';
}>;

export { CHROME_DEVTOOLS_MANIFEST as default };
