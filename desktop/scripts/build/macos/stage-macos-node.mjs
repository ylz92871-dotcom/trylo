import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { downloadToFile } from '../../../../desktop-services/src/tooling/tool-package-manager.mjs';
import { stageNpm } from '../shared/stage-npm.mjs';
import { macosNodePin, sha256, verifyMacosNode } from './macos-node-pin.mjs';

const { version, triple, archiveSha256 } = macosNodePin;
const directory = `node-${version}-${triple}`;
const url = `https://nodejs.org/dist/${version}/${directory}.tar.gz`;

assert.equal(`${process.platform}-${process.arch}`, triple, 'Run this staging script on Apple Silicon');
assert.ok(process.argv[2], 'Usage: node stage-macos-node.mjs <resources-dir> [local-node-tarball]');
const root = path.resolve(process.argv[2], 'runtime/node');
await fs.mkdir(root, { recursive: true });
assert.equal(await fs.realpath(root), root, 'Node staging root is redirected');
const target = path.join(root, triple);
const stage = await fs.mkdtemp(path.join(root, '.node-stage-'));
try {
  const archive = path.join(stage, 'node.tar.gz');
  if (process.argv[3]) await fs.copyFile(path.resolve(process.argv[3]), archive);
  else await downloadToFile(url, archive, 70 * 1024 * 1024);
  assert.equal(sha256(await fs.readFile(archive)), archiveSha256, 'Node tarball SHA-256 differs from the pinned release');
  execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', stage, `${directory}/bin/node`, `${directory}/LICENSE`], { stdio: 'inherit' });
  const extracted = path.join(stage, directory);
  const node = path.join(extracted, 'bin/node');
  await fs.chmod(node, 0o755);
  assert.equal(execFileSync(node, ['-p', 'process.platform + "-" + process.arch + " " + process.version'], { encoding: 'utf8' }).trim(),
    `${triple} ${version}`);
  const npm = await stageNpm(extracted);
  const license = path.join(extracted, 'NODE-LICENSE.txt');
  await fs.rename(path.join(extracted, 'LICENSE'), license);
  await verifyMacosNode(extracted);
  const manifest = {
    ...macosNodePin, archiveUrl: url, npmVersion: npm.version, npmIntegrity: npm.integrity,
  };
  await fs.writeFile(path.join(extracted, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  // Do not replace an existing runtime. The caller can stage a fresh candidate.
  try {
    await fs.lstat(target);
    throw new Error(`Node staging target already exists: ${target}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.rename(extracted, target);
  await fs.access(path.join(target, 'bin/node'), constants.X_OK);
  console.log(JSON.stringify(manifest));
} finally {
  await fs.rm(stage, { recursive: true, force: true });
}
