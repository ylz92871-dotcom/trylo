import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageBuiltinTools } from './stage-builtin-tools.mjs';
import { stageMacosComputerUse } from './stage-macos-computer-use.mjs';

assert.equal(`${process.platform}-${process.arch}`, 'darwin-arm64', 'Use an Apple Silicon builder');
assert.ok(process.argv[2], 'Usage: node prepare-macos-sidecars.mjs <new resources directory> [--preview]');
const preview = process.argv.includes('--preview');
const mediaSource = process.env.TRYLO_MACOS_MEDIA_ENGINE_DIR;
assert.ok(!preview || mediaSource, 'Set TRYLO_MACOS_MEDIA_ENGINE_DIR to the verified Apple Silicon FFmpeg build output');
const desktop = fileURLToPath(new URL('../../../', import.meta.url));
const cli = path.resolve(desktop, '../new trylo cli');
const services = path.resolve(desktop, '../desktop-services');
const output = path.resolve(process.argv[2]);
const parent = path.dirname(output);
const node = process.execPath;
const run = (cwd, program, args, env = process.env) => execFileSync(program, args, { cwd, env, stdio: 'inherit' });
const script = name => path.join(desktop, 'scripts/build', name.startsWith('stage-macos-') ? 'macos' : 'shared', name);

await fs.mkdir(parent, { recursive: true });
assert.equal(await fs.realpath(parent), parent, 'Resources staging parent is redirected');
try {
  await fs.lstat(output);
  throw new Error(`Resources staging output already exists: ${output}`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const candidate = await fs.mkdtemp(path.join(parent, '.trylo-sidecars-'));
try {
  run(desktop, node, [script('stage-macos-node.mjs'), candidate]);
  const pinned = path.join(candidate, 'runtime/node/darwin-arm64');
  const pinnedNode = path.join(pinned, 'bin/node');
  const npm = path.join(pinned, 'lib/node_modules/npm/bin/npm-cli.js');
  run(cli, pinnedNode, [npm, 'run', 'build'], { ...process.env, PATH: `${path.dirname(pinnedNode)}${path.delimiter}${process.env.PATH ?? ''}` });
  run(desktop, node, [script('stage-cli.mjs'), '--skip-build', '--prepared-closure', `--cli-dist=${path.join(cli, 'dist')}`,
    `--node=${pinnedNode}`, `--output=${path.join(candidate, 'cli')}`]);

  run(services, node, [path.join(services, 'node_modules/esbuild/bin/esbuild'), 'src/host.mjs',
    '--bundle', '--platform=node', '--format=esm', '--target=node22', '--outfile=dist/host.bundle.mjs',
    "--banner:js=import { createRequire as createNodeRequire } from 'node:module'; const require = createNodeRequire(import.meta.url);"]);

  const copy = async (source, relative, filter) => {
    const target = path.join(candidate, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(source, target, { recursive: true, filter });
  };
  await Promise.all([
    copy(path.join(desktop, 'distribution.json'), 'distribution.json'),
    copy(path.join(desktop, 'licenses/CoWork-OS-MIT.txt'), 'runtime/licenses/CoWork-OS-MIT.txt'),
    copy(path.join(desktop, 'sidecars/hermes-capabilities'), 'sidecars/hermes-capabilities',
      file => !['__pycache__', '.venv'].includes(path.basename(file)) && !file.endsWith('.pyc')),
    copy(path.join(services, 'dist/host.bundle.mjs'), 'desktop-services/dist/host.bundle.mjs'),
    copy(path.join(services, 'vendor'), 'desktop-services/vendor'),
    copy(path.join(services, 'node_modules/ws'), 'desktop-services/node_modules/ws'),
  ]);
  await fs.writeFile(path.join(candidate, 'desktop-services/package.json'), '{"private":true,"type":"commonjs"}\n');
  await stageBuiltinTools({ target: path.join(candidate, 'desktop-services/builtin-tools') });
  stageMacosComputerUse(candidate);
  const resourceEnv = { ...process.env, TRYLO_RESOURCE_DIR: candidate };
  if (preview) {
    const officeDmg = process.env.TRYLO_MACOS_OFFICE_DMG;
    run(desktop, node, [script('preview/supply-office-engine.mjs'), path.join(candidate, 'preview/office'),
      ...(officeDmg ? [path.resolve(officeDmg)] : [])]);
    run(desktop, node, [script('preview/stage-media-engine.mjs'), '--from', path.resolve(mediaSource)], resourceEnv);
    run(desktop, node, [script('preview/stage-codecs.mjs')], resourceEnv);
    run(desktop, node, [script('preview/verify-release.mjs')], resourceEnv);
  }
  run(services, node, [path.join(services, 'scripts/release-inventory.mjs')], resourceEnv);
  run(services, node, [path.join(services, 'scripts/verify-remote-runtime.mjs'), candidate, parent]);
  await fs.rename(candidate, output);
  console.log(`macOS sidecars staged and verified at ${output}`);
} finally {
  await fs.rm(candidate, { recursive: true, force: true });
}
