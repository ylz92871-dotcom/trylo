// One eligibility policy for filesystem evidence, event artifacts and recovery.
// This classifies deliverables; it grants no filesystem or execution authority.

/** Prune dependencies, not build/output folders or Git-ignored deliverables. */
export const OUTPUT_EXCLUDED_DIRECTORIES = [
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.cache', 'target',
];

const BROWSER_PROFILE_CONTENT_DIRECTORIES = new Set([
  'default', 'system profile', 'shadercache', 'grshadercache', 'gpupersistentcache',
  'component_crx_cache', 'crashpad', 'edgeoptimizationguidemodelsmanifest',
  'safe browsing', 'smartscreen',
]);
const NAMED_PROBE_PROFILE = /^(?:edge|browser)-profile$/;
const BROWSER_PROFILE_ROOT_FILES = new Set([
  'local state', 'last version', 'variations', 'variationsruntimeseedv2',
  'variationssafeseedv2', 'variationsseedv2', 'firstlaunchafterinstallation',
  'crashpadmetrics-active.pma', 'devtoolsactiveport',
]);

/** Recognize owned browser storage by its producer's path structure, never by
 * generic filenames such as LOCK/LOG or user directories named browser/Default. */
function isBrowserProfileDirectory(directories: readonly string[]): boolean {
  return directories.some((name, index) => {
    // Our deliverable and Three-runtime probes launch persistent contexts in
    // edge-profile/browser-profile. Match Chromium subtrees, not user exports
    // such as edge-profile/report.pdf or an ordinary browser/Default folder.
    if (NAMED_PROBE_PROFILE.test(name)) {
      const child = directories[index + 1] ?? '';
      if (BROWSER_PROFILE_CONTENT_DIRECTORIES.has(child) || /^profile \d+$/.test(child)) return true;
    }
    // desktop-services/tooling/viewport-bridge.mjs owns this per-session name.
    if (/^viewport-profile-\d+-\d+$/.test(name)) return true;
    // native_browser.rs owns a SHA256-scoped profile below native-browser.
    if (name === 'native-browser' && /^[a-f0-9]{64}$/.test(directories[index + 1] ?? '')) return true;
    // preview/web/view.rs allocates a fresh profile for every artifact view.
    if (name === 'preview' && directories[index + 1] === 'web'
      && /^browser-artifact-preview-\d+-\d+$/.test(directories[index + 2] ?? '')) return true;
    // The engine-owned EBWebView subtree distinguishes storage from a user's
    // ordinary .WebView2 directory, which may contain intentional deliverables.
    return name.endsWith('.webview2') && directories[index + 1] === 'ebwebview';
  });
}

export function isOutputArtifactPath(relativePath: string): boolean {
  const path = relativePath.replace(/\\/g, '/');
  // eslint-disable-next-line no-control-regex -- Deliberately reject all C0 control characters in paths and labels.
  if (!path || path.startsWith('/') || /^[a-z]:/i.test(path) || /[\u0000-\u001f]/.test(path)) return false;
  const parts = path.toLowerCase().split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return false;
  const directories = parts.slice(0, -1);
  if (directories.some(part => OUTPUT_EXCLUDED_DIRECTORIES.includes(part))) return false;
  if (parts[0] === '.trylo' && parts[1] !== 'out') return false;
  if (parts.at(-1)?.startsWith('loop-trylo-')) return false;
  // Verified root sentinels from the same persistent-context probes. An exact
  // profile parent plus an exact engine filename keeps sibling exports intact.
  if (NAMED_PROBE_PROFILE.test(parts.at(-2) ?? '')
    && BROWSER_PROFILE_ROOT_FILES.has(parts.at(-1) ?? '')) return false;
  return !isBrowserProfileDirectory(directories);
}
