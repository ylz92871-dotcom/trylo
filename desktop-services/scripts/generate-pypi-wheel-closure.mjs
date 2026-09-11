// Trylo Desktop Services — pinned-pypi-env wheel-closure generator.
//
// TRYLO-CAD-EDA-TOOL-ADAPTER §6.2 supply-chain tooling. For one package
// group this script:
//   1. resolves the group's dependency specs with uv into a throwaway venv
//      (the ONLY resolution step — everything below freezes what it chose);
//   2. `uv pip freeze`s the exact resolved set;
//   3. maps every pinned {name, version} to the ONE wheel Trylo will ship —
//      exact-abi win_amd64 → abi3 win_amd64 → py3-none-any — pulling the
//      canonical files.pythonhosted.org URL + sha256 from the PyPI JSON API;
//   4. writes a frozen data module consumed by the package manifests, plus
//      the wheel-set state digest that resolve() vouches installs by.
//
// Re-run when bumping a pinned upstream version, then update the manifest's
// version/archiveSha256 accordingly. The output is REVIEWED ARTIFACT: the
// digests are the trust boundary, so diff the generated file carefully.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'tooling', 'manifests', 'wheels');

/**
 * Package groups. `python` is the interpreter the transport pins for the
 * venv; `winTag` selects the platform wheel family. Marker-conditional
 * specs (pywin32 on win32) are expressed as uv-compatible requirement
 * strings so the resolution matches the transport's platform.
 */
const GROUPS = {
  // PyPI-published MCP servers — wheels mode (the server IS a wheel).
  'blender-mcp': {
    python: '3.12',
    specs: ['blender-mcp==1.9.1'],
  },
  'freecad-mcp': {
    python: '3.12',
    specs: ['freecad-mcp==0.1.22'],
  },
  'autocad-mcp': {
    python: '3.12',
    // com extra → pywin32 (live COM) + Pillow; pdf extra → matplotlib
    // (drawing_export_pdf). Without them the server degrades to ezdxf-only.
    specs: ['autocad-mcp-pro[com,pdf]==1.5.1'],
  },
  // GitHub-source servers — source mode (deps only; the server runs from
  // the pinned source tarball). Specs mirror the upstream pyproject.
  'solidworks-mcp': {
    python: '3.12',
    specs: [
      'mcp>=1.27,<2',
      'pydantic>=2.0',
      'ezdxf>=1.3,<2',
      'matplotlib>=3.8,<4',
      'PyMuPDF>=1.24,<2',
      'jsonschema>=4.20,<5',
      'pywin32>=305; sys_platform=="win32"',
      'comtypes>=1.2.0; sys_platform=="win32"',
    ],
  },
  // KiCAD-MCP-Server's Python side — installed into KiCad's BUNDLED
  // interpreter (pcbnew lives nowhere else), so the wheel family must match
  // KiCad 9's CPython (3.11), NOT the venv python.
  'kicad-mcp': {
    python: '3.11',
    specs: [
      'kicad-python>=0.5.0',
      'sexpdata',
      'kicad-skip>=0.1.0',
      'Pillow>=9',
      'pymupdf>=1.24',
      'cairosvg>=2.7.0',
      'colorlog',
      'pydantic>=2.5',
      'requests>=2.32.5',
      'python-dotenv',
    ],
  },
};

function parseAbiBaseline(filename) {
  const match = /-cp(\d+)-abi3-/.exec(filename);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

/** Pick the ONE wheel Trylo ships for {name, version} on this platform. */
function pickWheel(urls, pythonTag) {
  const cpTag = `cp${pythonTag.replace('.', '')}`;
  const wheels = (urls ?? []).filter((url) => url.packagetype === 'bdist_wheel');
  return (
    wheels.find((wheel) => wheel.filename.includes(`${cpTag}-${cpTag}-win_amd64`)) ??
    wheels.find((wheel) => wheel.filename.includes(`${cpTag}-abi3-win_amd64`)) ??
    wheels.find(
      (wheel) =>
        wheel.filename.endsWith('-abi3-win_amd64.whl') && parseAbiBaseline(wheel.filename) <= Number(cpTag.slice(2)),
    ) ??
    wheels.find((wheel) => wheel.filename.endsWith('-py3-none-any.whl')) ??
    wheels.find((wheel) => wheel.filename.endsWith('-py2.py3-none-any.whl')) ??
    null
  );
}

async function main() {
  const groupId = process.argv[2];
  const group = GROUPS[groupId];
  if (!group) {
    console.error(`unknown group '${groupId}'. Known: ${Object.keys(GROUPS).join(', ')}`);
    process.exit(1);
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `trylo-wheels-${groupId}-`));
  const venv = path.join(scratch, 'venv');
  const venvPython = path.join(
    venv,
    process.platform === 'win32' ? path.join('Scripts', 'python.exe') : path.join('bin', 'python'),
  );
  try {
    console.log(`[${groupId}] uv venv (python ${group.python})…`);
    execFileSync('uv', ['venv', venv, '--python', group.python], { stdio: 'inherit' });
    console.log(`[${groupId}] uv pip install ${group.specs.length} spec(s)…`);
    execFileSync('uv', ['pip', 'install', '--python', venvPython, ...group.specs], { stdio: 'inherit' });
    const freeze = execFileSync('uv', ['pip', 'freeze', '--python', venvPython], { encoding: 'utf8' });

    const pins = freeze
      .split(/\r?\n/)
      .filter((line) => line.includes('==') && !line.startsWith('#'))
      .map((line) => {
        const [name, version] = line.split('==');
        return { name: name.trim().toLowerCase(), version: version.trim().split(' ')[0] };
      });
    console.log(`[${groupId}] resolved ${pins.length} distributions; mapping wheels…`);

    const wheels = [];
    for (const pin of pins) {
      const response = await fetch(`https://pypi.org/pypi/${pin.name}/${pin.version}/json`);
      if (!response.ok) throw new Error(`PyPI ${pin.name} ${pin.version}: HTTP ${response.status}`);
      const data = await response.json();
      const wheel = pickWheel(data.urls, group.python);
      if (!wheel) {
        const names = (data.urls ?? []).map((url) => url.filename).join(', ');
        throw new Error(`no compatible wheel for ${pin.name} ${pin.version}; has: ${names}`);
      }
      wheels.push({
        name: pin.name,
        version: pin.version,
        url: wheel.url,
        sha256: wheel.digests.sha256,
        filename: wheel.filename,
      });
    }
    wheels.sort((a, b) => a.name.localeCompare(b.name));

    const stateDigest = crypto
      .createHash('sha256')
      .update(wheels.map((wheel) => `${wheel.name}-${wheel.version}-${wheel.sha256}`).sort().join('\n'))
      .digest('hex');

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const outFile = path.join(OUT_DIR, `${groupId}.wheels.mjs`);
    const banner =
      `// GENERATED by scripts/generate-pypi-wheel-closure.mjs (${groupId}) — DO NOT EDIT BY HAND.\n` +
      `// Resolved ${wheels.length} wheels for python ${group.python} on ${new Date().toISOString()}.\n` +
      `// Wheel-set state digest (archiveSha256 for wheels-mode installs): ${stateDigest}\n\n`;
    const body = `${banner}export const ${groupId.toUpperCase().replace(/-/g, '_')}_WHEELS = Object.freeze([\n${wheels
      .map(
        (wheel) =>
          `  Object.freeze({ name: ${JSON.stringify(wheel.name)}, version: ${JSON.stringify(wheel.version)}, url: ${JSON.stringify(wheel.url)}, sha256: ${JSON.stringify(wheel.sha256)} }), // ${wheel.filename}`,
      )
      .join('\n')}\n]);\n\nexport const ${groupId.toUpperCase().replace(/-/g, '_')}_STATE_DIGEST = ${JSON.stringify(stateDigest)};\n\nexport default ${groupId.toUpperCase().replace(/-/g, '_')}_WHEELS;\n`;
    fs.writeFileSync(outFile, body, 'utf8');
    console.log(`[${groupId}] wrote ${outFile} (${wheels.length} wheels, state digest ${stateDigest.slice(0, 12)}…)`);

    // A copy of the raw freeze for the audit trail.
    fs.writeFileSync(path.join(OUT_DIR, `${groupId}.freeze.txt`), freeze, 'utf8');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
