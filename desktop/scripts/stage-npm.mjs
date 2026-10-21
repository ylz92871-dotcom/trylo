// The packaged Node must be able to build pinned managed CAD/EDA adapters.
// npm's published tarball includes its complete runtime dependency closure.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { downloadToFile, extractPackageTarball } from '../../desktop-services/src/tooling/tool-package-manager.mjs';

export const NPM_VERSION = '11.11.0';
export const NPM_URL = `https://registry.npmjs.org/npm/-/npm-${NPM_VERSION}.tgz`;
export const NPM_INTEGRITY = 'sha512-82gRxKrh/eY5UnNorkTFcdBQAGpgjWehkfGVqAGlJjejEtJZGGJUqjo3mbBTNbc5BTnPKGVtGPBZGhElujX5cw==';

export function verifyNpmArchive(bytes) {
  const actual = `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`;
  if (actual !== NPM_INTEGRITY) throw new Error('Pinned npm archive integrity mismatch');
}

export async function stageNpm(nodeDir, archivePath = process.env.TRYLO_NPM_ARCHIVE) {
  const node = path.join(nodeDir, process.platform === 'win32' ? 'node.exe' : 'node');
  const stage = path.join(nodeDir, `.npm-stage-${crypto.randomUUID()}`);
  const target = path.join(nodeDir, 'node_modules', 'npm');
  await fs.mkdir(stage, { recursive: true });
  try {
    const archive = path.join(stage, 'npm.tgz');
    if (archivePath) await fs.copyFile(archivePath, archive);
    else await downloadToFile(NPM_URL, archive, 32 * 1024 * 1024);
    verifyNpmArchive(await fs.readFile(archive));
    const extracted = path.join(stage, 'package');
    await fs.mkdir(extracted);
    await extractPackageTarball(archive, extracted);
    const info = JSON.parse(await fs.readFile(path.join(extracted, 'package.json'), 'utf8'));
    if (info.name !== 'npm' || info.version !== NPM_VERSION) throw new Error('Unexpected npm package identity');
    const version = execFileSync(node, [path.join(extracted, 'bin/npm-cli.js'), '--version'], {
      encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
    }).trim();
    if (version !== NPM_VERSION) throw new Error('Staged npm runtime probe failed');
    // This is a build-staging directory, never a developer/global npm install.
    // Refuse redirected destinations before replacing a previous staged copy.
    const modules = path.dirname(target);
    await fs.mkdir(modules, { recursive: true });
    for (const dir of [nodeDir, modules, target]) {
      const stat = await fs.lstat(dir).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (stat?.isSymbolicLink()) throw new Error('Redirected npm staging destination');
    }
    await fs.rm(target, { recursive: true, force: true });
    await fs.rename(extracted, target);
    return { version, target, integrity: NPM_INTEGRITY };
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node stage-npm.mjs <staged-node-directory>');
  console.log(JSON.stringify(await stageNpm(path.resolve(process.argv[2]))));
}
