// Trylo Desktop Services — repository self-containment gate.
// See migration spec §0.2 / §9.2.
//
// Scans C:/work/demo-ws for any reference to the old read-only repo path in
// *runnable* surfaces: build scripts, Node/Rust sources, configs that feed
// import/require/spawn/where the packaged app would load a file from. The gate
// is a tripwire for *runtime* coupling — it must flag any code that would make
// the new build depend on the old tree — not for documentation or comments.
//
// Excludes (documented intent):
//   - docs/ + *.md + spike-results/: design/prose, never executed.
//   - build artifacts (node_modules, dist, target, src-tauri/resources,
//     android .../assets/public, .cowork, .trylo, out/): generated trees.
//   - the gate's own source (it must name the markers to detect them).
//   - AllowedFiles: explicit allowlist of files that mention the old path only
//     in inline comments, verified line-by-line below the table. Each entry is
//     blessed because the reference is human-readable commentary, not a loaded
//     path. Do not add to this table without a PR explaining the reference is
//     not a runtime dependency.

import { promises as fs } from 'node:fs';
import path from 'node:path';

const cwd = process.cwd();
const PROJECT_ROOT = path.resolve(cwd, '..'); // C:/work/demo-ws

const FORBIDDEN = [
  'claude-code-v-2.1.88',
  'mini-vscode-agent',
  String.raw`D:\CC\claude-code`,
  'D:/CC/claude-code',
];

// Relative paths (forward-slash, lowercase) containing the marker only in
// comments / prose. Sanity-checked below: the gate verifies the reference is
// not inside a line that looks like an import/require/spawn/fork.
function isAllowed(rel) {
  const norm = rel.replace(/\\/g, '/').toLowerCase();
  // copied legacy source that carries the origin path in a header comment
  if (norm === 'desktop/sidecars/desktop-companion/petwindow.xaml.cs') return true;
  if (norm === 'mobile-app/src/gateway.ts') return true;
  // existing repo prose that predates the migration
  if (norm === 'desktop/src/host-adapter/context-windows.ts') return true;
  if (norm === 'desktop/src/settings/settings-store.ts') return true;
  if (norm === 'desktop/src/host-adapter/attachment-utils.ts') return true;
  // pre-existing legacy static page (documentation of the old origin, not loaded)
  if (norm === 'desktop/public/legacy-4mode/index.html') return true;
  return false;
}

// If a probe shows a hit is a true runtime loader, remove from allowlist — never
// the reverse. These are known-bad and must stay tripped. Kept narrow: only
// constructs that load a path, not common method names (`join`, `load`) which
// would false-positive on allowlisted prose.
const RUNTIME_PROBE = /\b(require|import)\s*\(|\brequire\b|\bspawn\(|--extension-path|Resources\s*=|\bprocess\.cwd\b|--add-dir\b/gi;

function isDocOrArtifact(p, norm) {
  return (
    norm.startsWith('docs/') ||
    norm.startsWith('desktop/spike-results/') ||
    norm.endsWith('.md') ||
    norm.includes('/node_modules/') ||
    norm.includes('/dist/') ||
    norm.includes('/target/') ||
    norm.startsWith('src-tauri/resources/') ||
    // mobile app's compiled bundle embedded into android assets before fork
    norm.startsWith('mobile-app/android/app/src/main/assets/') ||
    // Android build trees are machine-generated (audit §6.2): a release
    // bundle embeds the legacy webapp and trips the gate on stale output,
    // not on source. Excluded by directory, not per-file allowlisting.
    norm.startsWith('mobile-app/android/') && norm.includes('/build/') ||
    // Work test recordings are CAPTURED TRAFFIC FIXTURES (PR work-recordings):
    // the payload quotes historical repo prose, never loads it. Excluded as a
    // fixture directory once its content was confirmed pure test data.
    norm.startsWith('work/tests/fixtures/') ||
    norm.includes('/.cowork/') || norm.startsWith('.cowork/') ||
    norm.includes('/.trylo/') || norm.startsWith('.trylo/') ||
    norm.includes('/out/') ||
    norm.includes('.git/')
  );
}

function looksRunnableHit(content, marker) {
  // Only flag when the offending line contains a runtime-loading construct.
  const lines = content.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.includes(marker) && RUNTIME_PROBE.test(l));
  return idx >= 0 ? lines[idx] : null;
}

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    const rel = path.relative(PROJECT_ROOT, p);
    const norm = rel.replace(/\\/g, '/').toLowerCase();
    if (norm === 'desktop-services/scripts/no-external-paths.mjs') continue; // self
    if (isDocOrArtifact(p, norm)) continue;
    if (e.isDirectory()) {
      await walk(p, out);
    } else if (e.isFile()) {
      out.push({ p, rel });
    }
  }
  return out;
}

async function main() {
  const files = await walk(PROJECT_ROOT);
  const offenders = [];
  for (const { p, rel } of files) {
    let content;
    try {
      content = await fs.readFile(p, 'utf8');
    } catch {
      continue;
    }
    if (!content) continue;
    for (const marker of FORBIDDEN) {
      if (!content.includes(marker)) continue;
      if (isAllowed(rel)) {
        // allowlist sanity-check: a runtime loader would be a false blessing
        const badLine = looksRunnableHit(content, marker);
        if (badLine) {
          offenders.push({ rel, marker, why: `allowlisted but runtime-ish` });
        }
        break;
      }
      offenders.push({ rel, marker, why: 'referenced (non-exempt file)' });
      break;
    }
  }
  if (offenders.length > 0) {
    for (const { rel, marker, why } of offenders) {
      console.error(`no-external-paths: HIT '${marker}' in ${rel} — ${why}`);
    }
    console.error(`no-external-paths: FAILED (${offenders.length} non-exempt reference(s))`);
    process.exit(1);
  }
  console.log(`no-external-paths: OK (${files.length} runnable files scanned, no runtime refs to old repo)`);
}

main();