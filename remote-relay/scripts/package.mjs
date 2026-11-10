import { artifactPath } from '../../scripts/workspace-paths.mjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { build } from '../../desktop-services/node_modules/esbuild/lib/main.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
// An explicit output directory preserves prior release artifacts for rollback.
const output = process.argv[2] ? path.resolve(process.argv[2]) : root;
if (process.argv[2]) await fs.mkdir(output, { recursive: false });
const destination = path.join(output, 'dist');
await fs.mkdir(path.join(destination, 'licenses'), { recursive: true });
await build({ entryPoints: [path.join(root, 'src/main.mjs')], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: path.join(destination, 'server.cjs'), legalComments: 'eof' });
await build({ entryPoints: [path.join(root, 'scripts/admin-account.mjs')], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: path.join(destination, 'admin-account.cjs') });
await build({ entryPoints: [path.join(root, 'scripts/model-admin.mjs')], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: path.join(destination, 'model-admin.cjs') });
await build({ entryPoints: [path.join(root, 'scripts/security-admin.mjs')], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: path.join(destination, 'security-admin.cjs') });
await fs.cp(path.join(root, '../trylocode-site/console'), path.join(destination, 'web'), { recursive: true });
for (const name of ['Dockerfile', 'compose.yaml', 'Caddyfile', 'install.sh', '.dockerignore']) await fs.copyFile(path.join(root, 'deploy', name), path.join(destination, name));
for (const name of ['maintenance.cjs', 'runtime-lock.json']) await fs.copyFile(path.join(root, 'deploy', name), path.join(destination, name));
await fs.copyFile(path.join(root, 'node_modules/ws/LICENSE'), path.join(destination, 'licenses/ws.txt'));
await fs.copyFile(path.join(root, 'README.md'), path.join(destination, 'README.md'));
const releases = process.argv[2] ? path.join(output, 'releases') : artifactPath('remote-relay-releases');
await fs.mkdir(releases, { recursive: true });
const archive = path.join(releases, `trylo-relay-${version}.tar.gz`);
// Windows executable lookup checks the working directory before PATH. Use the
// installed OS tool directly so a local tar.exe cannot intercept the archive.
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32/tar.exe') : 'tar';
execFileSync(tar, ['-czf', archive, '-C', destination, 'server.cjs', 'admin-account.cjs', 'model-admin.cjs', 'security-admin.cjs', 'maintenance.cjs', 'runtime-lock.json', 'web', 'Dockerfile', 'compose.yaml', 'Caddyfile', 'install.sh', '.dockerignore', 'licenses', 'README.md'], { windowsHide: true });
const sha256 = crypto.createHash('sha256').update(await fs.readFile(archive)).digest('hex');
await fs.writeFile(archive + '.sha256', `${sha256}  ${path.basename(archive)}\n`);
console.log(`Packaged ${path.basename(archive)} SHA256 ${sha256}`);
