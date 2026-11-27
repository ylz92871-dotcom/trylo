// Offline build from verified sources; never replaces product resources automatically.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.TRYLO_MEDIA_BUILD_ROOT || !process.env.TRYLO_MEDIA_COMPILER) throw new Error('Set TRYLO_MEDIA_BUILD_ROOT and TRYLO_MEDIA_COMPILER; see README.md');
const root = path.resolve(process.env.TRYLO_MEDIA_BUILD_ROOT);
if (/\s/.test(root)) throw new Error('The Windows GNU Make build workspace must not contain whitespace');
const prefix = path.join(root, 'prefix'); const build = path.join(root, 'build'); await mkdir(build, { recursive: true }); await mkdir(prefix, { recursive: true });
const compiler = path.resolve(process.env.TRYLO_MEDIA_COMPILER);
const ninja = path.join(root, 'python-tools/ninja-1.13.2.data/scripts/ninja.exe');
const nasm = path.join(root, 'nasm/nasm-3.02');
const env = { ...process.env, PATH: [compiler, nasm, path.dirname(ninja), path.join(prefix, 'bin'), process.env.PATH].join(path.delimiter), PYTHONPATH: path.join(root, 'python-tools'), CC: 'gcc', CXX: 'g++', AR: 'ar', NINJA: ninja, GIT_CEILING_DIRECTORIES: path.join(root, 'src'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '' };
async function run(executable, args, cwd = root) {
  console.log(JSON.stringify({ step: path.basename(executable), args }));
  const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (part) => process.stdout.write(part)); child.stderr.on('data', (part) => process.stderr.write(part));
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  if (code !== 0) throw new Error(`Isolated build step failed: ${path.basename(executable)} ${args[0]} (${code})`);
}
async function meson(args) { await run('python', ['-m', 'mesonbuild.mesonmain', ...args]); }
await run(path.join(compiler, 'gcc.exe'), ['--version']); await run(ninja, ['--version']); await run(path.join(nasm, 'nasm.exe'), ['-v']);
await meson(['setup', path.join(build, 'pkgconf'), path.join(root, 'src/pkgconf'), '--buildtype=release', '--default-library=static', '--prefix', prefix, '--libdir=lib', '--wrap-mode=nodownload']);
await run(ninja, ['-C', path.join(build, 'pkgconf')]); await meson(['install', '-C', path.join(build, 'pkgconf'), '--no-rebuild']);
const pkgconf = path.join(prefix, 'bin/pkgconf.exe');
await run('icacls.exe', [pkgconf, '/setintegritylevel', 'M']); await run(pkgconf, ['--version']);
env.PKG_CONFIG = pkgconf; env.PKG_CONFIG_PATH = path.join(prefix, 'lib/pkgconfig');
await meson(['setup', path.join(build, 'dav1d'), path.join(root, 'src/dav1d'), '--buildtype=release', '--default-library=static', '--prefix', prefix, '--libdir=lib', '--wrap-mode=nodownload', '-Denable_tools=false', '-Denable_tests=false', '-Denable_examples=false', '-Denable_docs=false']);
await run(ninja, ['-C', path.join(build, 'dav1d'), '-j8']); await meson(['install', '-C', path.join(build, 'dav1d'), '--no-rebuild']);
await run('C:/Program Files/Git/bin/bash.exe', [path.join(here, 'windows.sh')], root);
await writeFile(path.join(root, 'build-complete.json'), JSON.stringify({ complete: true, scope: 'Isolated unselected candidate; requires full fixture and source-supply acceptance', tools: JSON.parse(await readFile(path.join(root, 'build-tools.lock.json'), 'utf8')), provider: path.join(root, 'engine') }, null, 2) + '\n');
console.log('Isolated minimal media candidate compiled; bundled provider has not changed.');
