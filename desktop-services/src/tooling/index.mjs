// Trylo Desktop Services — tooling domain composition root.
//
// Spec TRYLO-CORE-AGENT-TOOL-EXTENSION-TECHNICAL-SPEC §12.1.
//
// Lifecycle wiring only: it builds the catalog, the package manager, the
// health service and the profile service, and exposes one handler per
// `tooling.*` method. No manifest policy, no allowlist and no profile
// composition rule lives here — that would recreate the
// `mcp-args-service.mjs` everything-bag the spec warns about (§3.1).
//
// Failure policy: read-only queries degrade to `{ ok:false, ... }`. Nothing
// here may block a Code or Work run — a broken tool package removes a
// capability, never the conversation (§4.4).

import { configureHermesEnv } from '../learning/hermes-env.mjs';
import { createMcpArgsService } from '../learning/mcp-args-service.mjs';
import { createArtifactPromoter } from './artifact-promoter.mjs';
import { createOfficeValidator, runBounded } from './office-validator.mjs';
import { createToolResultCache } from './tool-result-cache.mjs';
import { createToolCatalog } from './tool-catalog.mjs';
import { createToolPackageManager } from './tool-package-manager.mjs';
import { createToolHealthService } from './tool-health-service.mjs';
import { createToolProfileService } from './tool-profile-service.mjs';
import { createViewportBridge } from './viewport-bridge.mjs';

/**
 * @param {{ appDataDir?: string, sidecarsDir?: string,
 *            log?: (m: string) => void, seam?: object }} [options]
 *   `seam` is a test-only injection point (`{ manifests, hermesManager,
 *   installRoot, overrides }`) so the method surface can be exercised
 *   without touching the real install root or spawning Python.
 */
export function createToolingServices(options = {}) {
  const env = configureHermesEnv({
    appDataDir: options.appDataDir,
    sidecarsDir: options.sidecarsDir,
  });
  const log = options.log ?? null;
  const storageRoot = env.storageRoot;
  const seam = options.seam ?? {};

  const catalog = createToolCatalog(seam.manifests ? { manifests: seam.manifests } : {});

  const rejected = catalog.rejected();
  if (rejected.length > 0 && log) {
    // A malformed manifest is a build defect, not a runtime condition. It is
    // logged once at construction and the package simply never resolves.
    log(`tooling: ${rejected.length} manifest(s) rejected: ${JSON.stringify(rejected)}`);
  }

  const packages = createToolPackageManager({
    storageRoot,
    catalog,
    ...(seam.installRoot ? { installRoot: seam.installRoot } : {}),
    ...(seam.overrides ? { overrides: seam.overrides } : {}),
    // Test seam: replaces the PR-2 release download transport so install
    // can be exercised without touching the network.
    ...(seam.download ? { download: seam.download } : {}),
    // Test seam: replaces the browser-body install child process (§3.3-7).
    ...(seam.runCommand ? { runCommand: seam.runCommand } : {}),
  });

  const health = createToolHealthService({
    packages,
    catalog,
    // Test seam: replaces the `--version` child-process probe so health can
    // be exercised without a real binary.
    ...(seam.probe ? { probe: seam.probe } : {}),
    // Test seam: replaces the venv-metadata probe (PR-6 pinned-python-env).
    ...(seam.probePythonMetadata ? { probePythonMetadata: seam.probePythonMetadata } : {}),
    // Test seam: replaces the browser-body condition probe (§3.3-7).
    ...(seam.probeCondition ? { probeCondition: seam.probeCondition } : {}),
    // Test seam: replaces the host-application condition probe (CAD/EDA).
    ...(seam.probeAppCondition ? { probeApp: seam.probeAppCondition } : {}),
  });

  // The Hermes Adapter stays the Hermes Adapter. The profile service asks it
  // for server definitions; it does not reinterpret them (§3.1).
  const hermes = seam.hermes ?? createMcpArgsService({
    storageRoot,
    manager: seam.hermesManager ?? null,
  });

  const profiles = createToolProfileService({
    catalog,
    packages,
    health,
    hermes,
    storageRoot,
    ...(seam.profilesRoot ? { profilesRoot: seam.profilesRoot } : {}),
  });

  // PR-3 (§6.5/§7.3): the ONLY path from a package's runtime temp area
  // (downloads, screenshots) into the .trylo/out deliverable root.
  const promoter = createArtifactPromoter();

  // The IDE-style embedded browser panel (fork of vscode-browser-preview's
  // CDP-screencast architecture). Owns ONE panel browser; MCP servers keep
  // owning theirs. Frames flow to the renderer as `viewportFrame` events.
  const viewport = createViewportBridge({
    log,
    emit: typeof options.emit === 'function' ? options.emit : null,
    storageRoot,
  });

  // PR-4 (§7.1): 24 h TTL sweeper for the BinaryRef tool cache the
  // renderer writes (`<appDataDir>/tool-cache`). FS truth lives here —
  // the renderer has no delete-capable command. Started at construction;
  // stopped in dispose.
  const toolResultCache = createToolResultCache({
    appDataDir: options.appDataDir,
    ...(seam.toolCacheTtlMs ? { ttlMs: seam.toolCacheTtlMs } : {}),
    ...(seam.toolCacheNow ? { now: seam.toolCacheNow } : {}),
  });
  toolResultCache.start();

  // PR-5 (§11): the Office delivery validation pipeline — a deterministic
  // host pipeline, NOT an MCP tool (§11: 「验证工具不必都暴露成 MCP」).
  //
  // The OfficeCLI executable is resolved through the pinned package (§10.1)
  // and then PROBED: a pinned release that reports a different version is a
  // drift and is reported as unavailable with a reason, never silently
  // accepted as a capability (§3: a tools/list or version drift is degraded,
  // never a compatibility shim). LibreOffice is a system dependency (§2.3);
  // the validator probes it itself and skips its checks when absent.
  async function resolveOfficeCliForValidation() {
    const manifest = catalog.get('officecli');
    if (!manifest) {
      return { available: false, executable: null, version: null, reasonCode: 'manifest_missing' };
    }
    let resolved = null;
    try {
      resolved = await packages.resolve(manifest);
    } catch {
      resolved = null;
    }
    if (!resolved || !resolved.executable) {
      return {
        available: false,
        executable: null,
        version: null,
        reasonCode: resolved?.state ?? 'not_installed',
      };
    }
    const outcome = await runBounded(resolved.executable, ['--version'], 8000);
    if (outcome.timedOut) {
      return { available: false, executable: null, version: null, reasonCode: 'probe_timeout' };
    }
    if (outcome.code !== 0) {
      return { available: false, executable: null, version: null, reasonCode: 'probe_failed' };
    }
    const version = `${outcome.stdout}${outcome.stderr}`.trim().split('\n')[0] || null;
    if (version && manifest.version && !version.includes(manifest.version)) {
      // A binary that answers `--version` with something the manifest did
      // not pin is NOT the pinned package: refuse it (§3 / §15.2 hash drift).
      return { available: false, executable: null, version, reasonCode: 'version_mismatch' };
    }
    return { available: true, executable: resolved.executable, version, reasonCode: null };
  }

  const officeValidator = createOfficeValidator({
    resolveOfficeCli: resolveOfficeCliForValidation,
    ...(seam.officeValidator ?? {}),
  });

  /** The runtime dir name a package's manifest declared (§8.2), falling
   *  back to the package id. */
  function runtimeDirNameFor(catalogRef, packageId) {
    const manifest = catalogRef.get(String(packageId ?? ''));
    return manifest?.runtimeDirName ?? null;
  }

  return {
    catalog,

    /** `tooling.resolveProfile` — compose a Profile for one run. */
    resolveProfile(params = {}) {
      return profiles.resolve(params);
    },

    /** `tooling.health` — per-package health for Diagnostics / Settings. */
    async health(params = {}) {
      const id = params.id ? String(params.id) : null;
      const records = id ? [await health.forId(id)].filter(Boolean) : await health.listAll();
      return {
        ok: true,
        installRoot: packages.installRoot,
        profilesRoot: profiles.profilesRoot,
        rejected: catalog.rejected(),
        packages: records,
      };
    },

    /** `tooling.install` — download (or verify a local) pinned artefact,
     *  hash-check it, and place it with autoUpdate off (PR-2/PR-3). The
     *  health cache is dropped: a 5-minute stale `not-installed` after a
     *  successful install would wrongly degrade every Profile resolve. */
    async install(params = {}) {
      const result = await packages.install(params);
      if (result.ok) health.clearCache();
      return result;
    },

    /** `tooling.uninstall` — remove ONE pinned version directory (§3). */
    async uninstall(params = {}) {
      const result = await packages.uninstall(params);
      if (result.ok) health.clearCache();
      return result;
    },

    /** `tooling.installBrowser` — §3.3-7: materialise the browser body a
     *  package's browserCondition needs (playwright → pinned chromium).
     *  Health cache is dropped either way so the next health answers from
     *  the real condition, not the 5-minute stale cache. */
    async installBrowser(params = {}) {
      const result = await packages.installBrowser(params);
      health.clearCache();
      return result;
    },

    /** `tooling.listRuntimeArtifacts` — what the browser (or another
     *  package) left in THIS conversation's runtime temp dir (PR-3). The
     *  runtime dir name comes from the manifest's `runtimeDirName`
     *  (playwright → `browser`, §8.2 outputDir contract). */
    listRuntimeArtifacts(params = {}) {
      return promoter.list({
        ...params,
        dirName: runtimeDirNameFor(catalog, params.packageId),
      });
    },

    /** `tooling.promoteArtifact` — copy one runtime temp artifact into
     *  .trylo/out, the only deliverable root (PR-3 §6.5/§7.3). */
    promoteArtifact(params = {}) {
      return promoter.promote({
        ...params,
        dirName: runtimeDirNameFor(catalog, params.packageId),
      });
    },

    /** `tooling.sweepToolCache` — run the BinaryRef tool-cache TTL sweep
     *  on demand (PR-4 §7.1; also runs hourly in the background). */
    sweepToolCache() {
      return toolResultCache.sweep();
    },

    /** `tooling.officeValidationCapabilities` — §4.4 capability contract for
     *  the Office validation pipeline. Reports `available` + `version` +
     *  `reasonCode` per engine so the UI can state WHY a deliverable is only
     *  partially verified instead of implying a pass (PR-5 §11). */
    officeValidationCapabilities(params = {}) {
      return officeValidator.capabilities(params);
    },

    /** `tooling.validateOfficeArtifacts` — §11 deterministic validation of
     *  one run's `.trylo/out` Office deliverables. Bounded (artifact count,
     *  total budget, per-step timeout) and never throws: a broken validator
     *  removes a verification signal, never a run. */
    validateOfficeArtifacts(params = {}) {
      return officeValidator.validate(params);
    },

    /** `tooling.viewportStart` — spawn (or attach to) the panel browser and
     *  begin streaming screencast frames as `viewportFrame` events. */
    viewportStart(params = {}) {
      return viewport.start(params);
    },

    /** `tooling.viewportNavigate` — the panel's URL bar. */
    viewportNavigate(params = {}) {
      return viewport.navigate(params);
    },

    /** `tooling.viewportInput` — the USER's pointer/keys on the panel. */
    viewportInput(params = {}) {
      return viewport.input(params);
    },

    /** `tooling.viewportStop` — exit the panel browser process tree. */
    viewportStop() {
      return viewport.stop();
    },

    /** Diagnostics-only: the Profiles this build knows (§4.1). */
    listProfiles() {
      return {
        ok: true,
        profiles: Object.values(profiles.profiles).map((p) => ({
          id: p.id,
          revision: p.revision,
          surface: p.surface,
          packageIds: [...p.packageIds],
          strictMcpConfig: p.strictMcpConfig,
        })),
      };
    },

    /** Bounded flush on host exit. Nothing here holds a process. */
    dispose() {
      toolResultCache.stop();
      health.clearCache();
      void viewport.stop();
    },
  };
}

export default createToolingServices;
