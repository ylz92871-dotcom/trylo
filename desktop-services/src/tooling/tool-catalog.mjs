// Trylo Desktop Services — Tool Package Catalog.
//
// Spec TRYLO-CORE-AGENT-TOOL-EXTENSION-TECHNICAL-SPEC §3.
//
// A SMALL, STATIC, AUDITABLE registry — explicitly not a plugin marketplace.
// It answers one question: "what does Trylo know about tool package X?"
// It owns no process, no install and no health state; those live in
// tool-package-manager.mjs / tool-health-service.mjs.
//
// The catalog is the single place a manifest is validated, so a malformed
// manifest fails loudly at load time instead of silently producing a
// Profile that omits a tool (spec §4.4: never伪装成模型失败).

import { OFFICECLI_MANIFEST } from './manifests/officecli.mjs';
import { PLAYWRIGHT_MANIFEST } from './manifests/playwright.mjs';
import { WINDOWS_MCP_MANIFEST, WINDOWS_MCP_ALLOWED_TOOLS } from './manifests/windows-mcp.mjs';
import { CHROME_DEVTOOLS_MANIFEST } from './manifests/chrome-devtools.mjs';
import { SOLIDWORKS_MCP_MANIFEST } from './manifests/solidworks-mcp.mjs';
import { AUTOCAD_MCP_MANIFEST } from './manifests/autocad-mcp.mjs';
import { KICAD_MCP_MANIFEST } from './manifests/kicad-mcp.mjs';
import { JLCEDA_MCP_MANIFEST } from './manifests/jlceda-mcp.mjs';
import { FREECAD_MCP_MANIFEST } from './manifests/freecad-mcp.mjs';
import { BLENDER_MCP_MANIFEST } from './manifests/blender-mcp.mjs';

export const CATALOG_SCHEMA_VERSION = 1;

/** Every manifest Trylo ships. Adding a package = adding one frozen object. */
const MANIFESTS = Object.freeze([
  OFFICECLI_MANIFEST,
  PLAYWRIGHT_MANIFEST,
  WINDOWS_MCP_MANIFEST,
  CHROME_DEVTOOLS_MANIFEST,
  SOLIDWORKS_MCP_MANIFEST,
  AUTOCAD_MCP_MANIFEST,
  KICAD_MCP_MANIFEST,
  JLCEDA_MCP_MANIFEST,
  FREECAD_MCP_MANIFEST,
  BLENDER_MCP_MANIFEST,
]);

/** Windows-MCP's tool allowlist is argv-enforced; export it for reuse. */
export { WINDOWS_MCP_ALLOWED_TOOLS };

const ACTIVATIONS = Object.freeze(['work-default', 'explicit-computer', 'on-demand', 'developer']);
const ADOPTIONS = Object.freeze(['stable', 'trial', 'developer']);
const STRATEGIES = Object.freeze(['release-archive', 'pinned-npm', 'pinned-python-env', 'pinned-pypi-env']);
const INSTALL_CONDITION_KINDS = Object.freeze(['executable-glob', 'com-progid', 'app-bridge']);
const BUILD_KINDS = Object.freeze(['npm-ci-build']);
const PYPI_WHEEL_TARGETS = Object.freeze(['kicad-bundled']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** One pinned wheel: { name, version, url, sha256 }. The URL must be the
 *  exact pinned artifact (files.pythonhosted.org or equivalent) — the
 *  transport downloads THAT url and verifies THAT digest, so the wheel list
 *  is the entire dependency trust chain (mirrors the pinned-npm closure
 *  rule, §8.2 固定 npm 包版本与完整性 hash). */
function validatePinnedWheels(wheels, field, problems) {
  if (!Array.isArray(wheels) || wheels.length === 0) {
    problems.push(`${field} must pin the wheel closure (non-empty array)`);
    return;
  }
  const seen = new Set();
  for (const wheel of wheels) {
    if (!isNonEmptyString(wheel?.name)) problems.push(`${field}[].name is required`);
    else if (seen.has(wheel.name)) problems.push(`${field} duplicates wheel '${wheel.name}'`);
    else seen.add(wheel.name);
    if (!isNonEmptyString(wheel?.version) || wheel.version === 'latest') {
      problems.push(`${field}[${wheel?.name ?? '?'}].version must be pinned (never "latest")`);
    }
    if (!isNonEmptyString(wheel?.url) || !wheel.url.startsWith('https://')) {
      problems.push(`${field}[${wheel?.name ?? '?'}].url must be an https:// URL`);
    }
    if (!/^[0-9a-f]{64}$/.test(wheel?.sha256 ?? '')) {
      problems.push(`${field}[${wheel?.name ?? '?'}].sha256 must be a full hex digest`);
    }
  }
}

function isStringArray(value) {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

/**
 * Validate one manifest. Returns a list of human-readable problems; an empty
 * list means the manifest satisfies the §3 contract.
 *
 * @param {object} manifest
 * @returns {string[]}
 */
export function validateManifest(manifest) {
  const problems = [];
  if (!manifest || typeof manifest !== 'object') return ['manifest is not an object'];

  if (manifest.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${CATALOG_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(manifest.id)) problems.push('id is required');
  if (!isNonEmptyString(manifest.displayName)) problems.push('displayName is required');

  // `latest` is forbidden outright (spec §16.4).
  if (!isNonEmptyString(manifest.version) || manifest.version === 'latest') {
    problems.push('version must be pinned (never "latest")');
  }
  if (!ADOPTIONS.includes(manifest.adoption)) {
    problems.push(`adoption must be one of ${ADOPTIONS.join('|')}`);
  }
  if (!ACTIVATIONS.includes(manifest.activation)) {
    problems.push(`activation must be one of ${ACTIVATIONS.join('|')}`);
  }
  if (!isNonEmptyString(manifest.classifierId)) problems.push('classifierId is required');

  const source = manifest.source;
  if (!source || !isNonEmptyString(source.repository) || !isNonEmptyString(source.license)) {
    problems.push('source.repository and source.license are required');
  }

  const artifact = manifest.artifact;
  if (!artifact || !STRATEGIES.includes(artifact.installStrategy)) {
    problems.push(`artifact.installStrategy must be one of ${STRATEGIES.join('|')}`);
  } else {
    if (!isNonEmptyString(artifact.platform)) problems.push('artifact.platform is required');
    if (!isNonEmptyString(artifact.executableRelativePath)) {
      problems.push('artifact.executableRelativePath is required');
    }
    // PR-3: a pinned-npm package must declare how its entry is executed.
    // Today the only supported runner is the Node runtime the sidecar
    // already uses (§8.2: never `npx ...@latest`).
    if (artifact.installStrategy === 'pinned-npm') {
      if (artifact.runner !== 'node') {
        problems.push("artifact.runner must be 'node' for pinned-npm packages");
      }
      if (!isNonEmptyString(artifact.packageName)) {
        problems.push('artifact.packageName is required for pinned-npm packages');
      }
      // The whole runtime closure is pinned (§8.2 固定 npm 包版本与完整性
      // hash): every dependency must carry a registry tarball + digest.
      // An EMPTY array is valid when the published tarball bundles its whole
      // closure (chrome-devtools-mcp 1.8.0 ships a rollup bundle with zero
      // dependencies) — the single tarball digest is then the entire trust
      // chain and there is nothing left to float.
      if (!Array.isArray(artifact.npmDependencies)) {
        problems.push('artifact.npmDependencies must pin the runtime closure (empty array = bundled package)');
      } else {
        for (const dep of artifact.npmDependencies) {
          if (!isNonEmptyString(dep?.name)) problems.push('npmDependencies[].name is required');
          if (!isNonEmptyString(dep?.tarballUrl) || !dep.tarballUrl.startsWith('https://')) {
            problems.push(`npmDependencies[${dep?.name ?? '?'}].tarballUrl must be an https:// registry URL`);
          }
          if (/\blatest\b/i.test(dep?.tarballUrl ?? '')) {
            problems.push(`npmDependencies[${dep?.name ?? '?'}].tarballUrl must be pinned, never "latest"`);
          }
          if (!/^[0-9a-f]{64}$/.test(dep?.sha256 ?? '')) {
            problems.push(`npmDependencies[${dep?.name ?? '?'}].sha256 must be a full hex digest`);
          }
        }
      }
    }
    // PR-2: an optional pinned download URL for the release-archive
    // transport. https only — an http:// URL would let a network observer
    // swap the bytes the digest is about to vouch for.
    if (artifact.downloadUrl !== undefined) {
      if (!isNonEmptyString(artifact.downloadUrl) || !artifact.downloadUrl.startsWith('https://')) {
        problems.push('artifact.downloadUrl must be an https:// URL');
      }
      if (/\blatest\b/i.test(artifact.downloadUrl)) {
        problems.push('artifact.downloadUrl must be pinned, never "latest"');
      }
    }
    // PR-6: a pinned-python-env package materialises a uv-managed .venv from
    // a pinned source tarball + its uv.lock. Both digests are the trust
    // boundary; a missing lock would let the dependency set float (§8.2:
    // 锁定 Python runtime + wheel/lock).
    if (artifact.installStrategy === 'pinned-python-env') {
      if (!/^[0-9a-f]{64}$/.test(artifact.archiveSha256 ?? '')) {
        problems.push('pinned-python-env requires a full source-tarball archiveSha256');
      }
      if (!/^[0-9a-f]{64}$/.test(artifact.uvLockSha256 ?? '')) {
        problems.push('pinned-python-env requires a full uv.lock uvLockSha256');
      }
      if (!isNonEmptyString(artifact.sourceCommit)) {
        problems.push('pinned-python-env requires the pinned sourceCommit');
      }
      if (!isNonEmptyString(artifact.downloadUrl) || !artifact.downloadUrl.startsWith('https://')) {
        problems.push('pinned-python-env requires an https:// source-tarball downloadUrl');
      }
    }
    // CAD/EDA (TRYLO-CAD-EDA-TOOL-ADAPTER §6): pinned-pypi-env materialises a
    // uv venv from an EXPLICIT wheel closure — every dependency is one pinned
    // {name, version, url, sha256} wheel; no resolution runs at install time.
    // Two modes: wheels-only (the server itself is one of the wheels, PyPI
    // published) and source-run (a pinned GitHub source tarball + dep wheels,
    // entry = a script path inside the extracted tree via {installDir}).
    if (artifact.installStrategy === 'pinned-pypi-env') {
      validatePinnedWheels(artifact.wheels, 'artifact.wheels', problems);
      if (!/^\d+\.\d+$/.test(artifact.pythonVersion ?? '')) {
        problems.push('pinned-pypi-env requires artifact.pythonVersion (e.g. "3.12")');
      }
      const sourceMode = artifact.sourceTarballUrl !== undefined || artifact.sourceEntry !== undefined;
      if (sourceMode) {
        if (!isNonEmptyString(artifact.sourceTarballUrl) || !artifact.sourceTarballUrl.startsWith('https://')) {
          problems.push('pinned-pypi-env source mode requires an https:// sourceTarballUrl');
        }
        if (!/^[0-9a-f]{64}$/.test(artifact.sourceTarballSha256 ?? '')) {
          problems.push('pinned-pypi-env source mode requires a full sourceTarballSha256');
        }
        if (!isNonEmptyString(artifact.sourceEntry)) {
          problems.push('pinned-pypi-env source mode requires sourceEntry (script path relative to the install dir)');
        }
        if (artifact.sourceEntry !== undefined && /[\\]|\.\./.test(artifact.sourceEntry.replace(/\//g, '\\'))) {
          // split on separators below; reject any upward traversal segment.
          const segments = String(artifact.sourceEntry).split(/[\\/]/);
          if (segments.some((segment) => segment === '..')) {
            problems.push('pinned-pypi-env sourceEntry must not traverse upward');
          }
        }
      } else if (!isNonEmptyString(artifact.pythonPackage)) {
        problems.push('pinned-pypi-env wheels mode requires pythonPackage (the health-probe dist name)');
      }
    }
    // CAD/EDA: a release-archive package may declare a POST-EXTRACT BUILD —
    // today only npm-ci-build (npm ci --ignore-scripts from the committed
    // lockfile + npm run build), for source-only TypeScript MCP servers that
    // are not published to npm (jlcmcp, KiCAD-MCP-Server). The archive digest
    // plus the repo's own package-lock.json integrity hashes are the chain.
    if (artifact.build !== undefined) {
      if (!artifact.build || typeof artifact.build !== 'object' || !BUILD_KINDS.includes(artifact.build.kind)) {
        problems.push(`artifact.build.kind must be one of ${BUILD_KINDS.join('|')}`);
      }
    }
    // CAD/EDA: pinned Python wheels installed into the HOST application's own
    // interpreter (KiCad's bundled Python for pcbnew/kipy) — never resolved,
    // each wheel digest-pinned. The target names the detection rule.
    if (artifact.pythonWheels !== undefined) {
      validatePinnedWheels(artifact.pythonWheels, 'artifact.pythonWheels', problems);
      if (!PYPI_WHEEL_TARGETS.includes(artifact.pythonWheelsTarget)) {
        problems.push(`artifact.pythonWheelsTarget must be one of ${PYPI_WHEEL_TARGETS.join('|')}`);
      }
    }
  }

  const mcp = manifest.mcp;
  if (!mcp || !isNonEmptyString(mcp.serverName)) {
    problems.push('mcp.serverName is required (it becomes mcp__server__tool)');
  } else {
    if (mcp.transport !== 'stdio') {
      problems.push('mcp.transport must be "stdio" (P0 allows local stdio only)');
    }
    if (!isStringArray(mcp.args)) problems.push('mcp.args must be an array of strings');
    if (mcp.env && typeof mcp.env !== 'object') problems.push('mcp.env must be an object');
    if (!isStringArray(mcp.expectedTools)) {
      problems.push('mcp.expectedTools must be an array of strings ([] = do not assert)');
    }
    // PR-3 (§8.2 origin configuration): optional origin lists. Entries are
    // literal origins (scheme://host[:port]) — the classifier compares
    // them verbatim, and the profile service forwards them as the server's
    // --allowed-origins / --blocked-origins flags.
    for (const field of ['allowedOrigins', 'blockedOrigins']) {
      if (mcp[field] === undefined) continue;
      if (!isStringArray(mcp[field])) {
        problems.push(`mcp.${field} must be an array of origin strings`);
        continue;
      }
      for (const origin of mcp[field]) {
        if (!/^https?:\/\//.test(origin)) {
          problems.push(`mcp.${field} entries must be http(s) origins`);
        }
      }
    }
  }

  // PR-3 (§8.2 outputDir contract): a manifest may rename the per-run
  // runtime dir (playwright uses `browser` per the spec's documented
  // layout). Any non-empty string is acceptable — the profile service
  // joins it under .trylo/runtime/.
  if (manifest.runtimeDirName !== undefined && !isNonEmptyString(manifest.runtimeDirName)) {
    problems.push('runtimeDirName must be a non-empty string when set');
  }

  // A env entry carrying a secret-looking key is a contract violation:
  // runtime secrets are injected separately (spec §3).
  if (mcp && mcp.env) {
    for (const key of Object.keys(mcp.env)) {
      if (/key|token|secret|password/i.test(key)) {
        problems.push(`mcp.env.${key} looks like a secret; secrets are injected at runtime`);
      }
    }
  }

  // §3.3-7 extension (CAD/EDA): a manifest may declare a HOST-APPLICATION
  // condition — the package automates SolidWorks/KiCad/嘉立创EDA/…, and the
  // application being absent (or its bridge not running) is an honest
  // `condition-missing`, not a pass. Strictly validated per kind so a typo
  // cannot silently turn a probe into a no-op.
  if (manifest.installCondition !== undefined) {
    const cond = manifest.installCondition;
    if (!cond || typeof cond !== 'object' || !INSTALL_CONDITION_KINDS.includes(cond.kind)) {
      problems.push(`installCondition.kind must be one of ${INSTALL_CONDITION_KINDS.join('|')}`);
    } else {
      if (cond.roots !== undefined && !isStringArray(cond.roots)) {
        problems.push('installCondition.roots must be an array of strings');
      }
      if (cond.markers !== undefined && !isStringArray(cond.markers)) {
        problems.push('installCondition.markers must be an array of strings');
      }
      if (cond.kind === 'executable-glob') {
        if (!Array.isArray(cond.roots) || cond.roots.length === 0) {
          problems.push("installCondition.kind 'executable-glob' requires non-empty roots");
        }
        if (!Array.isArray(cond.markers) || cond.markers.length === 0) {
          problems.push("installCondition.kind 'executable-glob' requires non-empty markers");
        }
      }
      if (cond.kind === 'com-progid' && !isNonEmptyString(cond.progid)) {
        problems.push("installCondition.kind 'com-progid' requires a progid");
      }
      if (cond.kind === 'app-bridge') {
        if (!Array.isArray(cond.markers) || cond.markers.length === 0) {
          problems.push("installCondition.kind 'app-bridge' requires non-empty markers");
        }
        if (cond.allowBridgeOnly !== undefined && typeof cond.allowBridgeOnly !== 'boolean') {
          problems.push('installCondition.allowBridgeOnly must be a boolean when set');
        }
        const bridge = cond.bridge;
        if (
          !bridge ||
          typeof bridge !== 'object' ||
          !Number.isInteger(bridge.from) ||
          !Number.isInteger(bridge.to) ||
          bridge.from < 1 ||
          bridge.to > 65535 ||
          bridge.from > bridge.to ||
          bridge.to - bridge.from > 64
        ) {
          problems.push("installCondition.kind 'app-bridge' requires bridge {from,to} (≤64 ports, 1-65535)");
        } else if (bridge.host !== undefined && !isNonEmptyString(bridge.host)) {
          problems.push('installCondition.bridge.host must be a non-empty string when set');
        }
      }
      if (cond.remediation !== undefined && !isNonEmptyString(cond.remediation)) {
        problems.push('installCondition.remediation must be a non-empty string when set');
      }
    }
  }

  return problems;
}

export function createToolCatalog({ manifests = MANIFESTS } = {}) {
  const byId = new Map();
  const invalid = [];

  for (const manifest of manifests) {
    const problems = validateManifest(manifest);
    if (problems.length > 0) {
      invalid.push({ id: manifest?.id ?? '<unknown>', problems });
      continue;
    }
    if (byId.has(manifest.id)) {
      invalid.push({ id: manifest.id, problems: ['duplicate manifest id'] });
      continue;
    }
    if (byId.size > 0) {
      const clash = [...byId.values()].find((m) => m.mcp.serverName === manifest.mcp.serverName);
      if (clash) {
        invalid.push({
          id: manifest.id,
          problems: [`mcp.serverName '${manifest.mcp.serverName}' already used by '${clash.id}'`],
        });
        continue;
      }
    }
    byId.set(manifest.id, manifest);
  }

  return {
    /** Every VALID manifest. */
    list() {
      return [...byId.values()];
    },

    /**
     * @param {string} id
     * @returns {object|null}
     */
    get(id) {
      return byId.get(id) ?? null;
    },

    /** Manifests by activation class. */
    byActivation(activation) {
      return [...byId.values()].filter((m) => m.activation === activation);
    },

    /** `mcp__<server>__<tool>` prefix for a package (spec §6.1 rule seeds). */
    mcpPrefix(id) {
      const manifest = byId.get(id);
      return manifest ? `mcp__${manifest.mcp.serverName}` : null;
    },

    /** Manifests rejected at load time. Empty in a healthy build. */
    rejected() {
      return invalid.map((entry) => ({ ...entry, problems: [...entry.problems] }));
    },
  };
}

export default createToolCatalog;
