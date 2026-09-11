// Trylo Desktop Services — pinned-artifact mirror builder.
//
// TRYLO-CAD-EDA-TOOL-ADAPTER §6 supply-chain insurance. The manifests pin
// upstream URLs + SHA256 digests: the digest guarantees INTEGRITY (upstream
// cannot swap bytes), but availability still depends on upstream being
// reachable (PyPI wheels are durable; a GitHub repo CAN disappear). This
// script takes a historical copy of EVERY pinned artifact into a local
// mirror directory:
//
//   node scripts/mirror-pinned-artifacts.mjs <mirror-dir>
//
// For each manifest it downloads every pinned artefact (source tarballs,
// wheel closures, host-interpreter wheels), verifies the digest against the
// manifest BEFORE accepting the file, and stores it as
//   <mirror-dir>/<package-id>/<sha256-16>-<original-filename>
// Re-runs skip already-mirrored files (idempotent). A `mirror-manifest.json`
// records package → files → { sha256, upstreamUrl, file } so the mirror can
// be re-hosted (OSS / private git releases) and the manifest URLs flipped
// to the mirror later WITHOUT touching any digest — same trust chain, your
// availability.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { artifactBasename, downloadToFile } from '../src/tooling/tool-package-manager.mjs';
import { OFFICECLI_MANIFEST } from '../src/tooling/manifests/officecli.mjs';
import { PLAYWRIGHT_MANIFEST } from '../src/tooling/manifests/playwright.mjs';
import { WINDOWS_MCP_MANIFEST } from '../src/tooling/manifests/windows-mcp.mjs';
import { CHROME_DEVTOOLS_MANIFEST } from '../src/tooling/manifests/chrome-devtools.mjs';
import { SOLIDWORKS_MCP_MANIFEST } from '../src/tooling/manifests/solidworks-mcp.mjs';
import { AUTOCAD_MCP_MANIFEST } from '../src/tooling/manifests/autocad-mcp.mjs';
import { KICAD_MCP_MANIFEST } from '../src/tooling/manifests/kicad-mcp.mjs';
import { JLCEDA_MCP_MANIFEST } from '../src/tooling/manifests/jlceda-mcp.mjs';
import { FREECAD_MCP_MANIFEST } from '../src/tooling/manifests/freecad-mcp.mjs';
import { BLENDER_MCP_MANIFEST } from '../src/tooling/manifests/blender-mcp.mjs';

const MANIFESTS = [
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
];

const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

// basename comes from tool-package-manager.artifactBasename — the transport
// derives mirror URLs with THE SAME function, so a mirror directory uploaded
// as-is is resolvable byte-for-byte (layout contract, §6.5).

function collectArtifacts(manifest) {
  const artifact = manifest.artifact ?? {};
  const out = [];
  if (artifact.downloadUrl) {
    out.push({ url: artifact.downloadUrl, sha256: artifact.archiveSha256 });
  }
  if (artifact.sourceTarballUrl) {
    out.push({ url: artifact.sourceTarballUrl, sha256: artifact.sourceTarballSha256 });
  }
  for (const wheel of artifact.wheels ?? []) {
    out.push({ url: wheel.url, sha256: wheel.sha256 });
  }
  for (const wheel of artifact.pythonWheels ?? []) {
    out.push({ url: wheel.url, sha256: wheel.sha256 });
  }
  if (artifact.installStrategy === 'pinned-npm') {
    out.push({ url: artifact.downloadUrl, sha256: artifact.archiveSha256 });
    for (const dep of artifact.npmDependencies ?? []) {
      out.push({ url: dep.tarballUrl, sha256: dep.sha256 });
    }
  }
  return out.filter((entry) => entry.url && entry.sha256);
}

async function main() {
  const mirrorDir = path.resolve(process.argv[2] ?? '');
  if (!mirrorDir) {
    console.error('usage: node scripts/mirror-pinned-artifacts.mjs <mirror-dir>');
    process.exit(1);
  }
  fs.mkdirSync(mirrorDir, { recursive: true });

  const report = { generatedAt: new Date().toISOString(), packages: {} };
  let totalFiles = 0;
  let totalBytes = 0;

  for (const manifest of MANIFESTS) {
    const artifacts = collectArtifacts(manifest);
    if (artifacts.length === 0) continue;
    const packageDir = path.join(mirrorDir, manifest.id);
    fs.mkdirSync(packageDir, { recursive: true });
    const files = [];

    for (const { url, sha256 } of artifacts) {
      const base = artifactBasename(url);
      const fileName = `${sha256.slice(0, 16)}-${base}`;
      const target = path.join(packageDir, fileName);

      let digest;
      if (fs.existsSync(target)) {
        digest = await sha256OfFile(target);
        if (digest !== sha256) {
          // A corrupted mirror entry is re-downloaded, never trusted.
          fs.rmSync(target, { force: true });
          digest = null;
        }
      }
      if (!digest) {
        console.log(`[${manifest.id}] downloading ${base}…`);
        const scratch = `${target}.downloading`;
        await downloadToFile(url, scratch, MAX_DOWNLOAD_BYTES);
        digest = await sha256OfFile(scratch);
        if (digest !== sha256) {
          fs.rmSync(scratch, { force: true });
          throw new Error(`[${manifest.id}] ${base}: upstream digest drift — expected ${sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…`);
        }
        fs.renameSync(scratch, target);
      }
      const size = fs.statSync(target).size;
      totalFiles += 1;
      totalBytes += size;
      files.push({ file: path.relative(mirrorDir, target), sha256, upstreamUrl: url, size });
    }
    report.packages[manifest.id] = {
      version: manifest.version,
      repository: manifest.source?.repository ?? null,
      files,
    };
    console.log(`[${manifest.id}] ${files.length} artifact(s) mirrored`);
  }

  report.totals = { files: totalFiles, bytes: totalBytes };
  fs.writeFileSync(
    path.join(mirrorDir, 'mirror-manifest.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  console.log(
    `mirror complete: ${totalFiles} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MiB → ${mirrorDir}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
