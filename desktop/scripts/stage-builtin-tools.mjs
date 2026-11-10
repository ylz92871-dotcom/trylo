// Build-time only. End users never install the core Office/browser/input tools.
import fs from 'node:fs/promises';
import { existsSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { artifactPath, workspacePath } from '../../scripts/workspace-paths.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const toolsRoot = path.join(repo, 'desktop-services/toolchain');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const omit = new Set(['.git', 'node_modules', '__pycache__', '.pytest_cache', '.ruff_cache', 'tests', 'test', 'coverage']);

export async function buildBuiltinOffice(source) {
  const build = artifactPath('local-release', 'builtin-office-' + crypto.randomUUID());
  const scratch = workspacePath('cache', 'builtin-office', crypto.randomUUID());
  await fs.mkdir(build, { recursive: true });
  await fs.mkdir(scratch, { recursive: true });
  const log = path.join(build, 'build.log');
  const logFd = openSync(log, 'w');
  try { execFileSync('dotnet', ['publish', path.join(source, 'src/officecli/officecli.csproj'), '--no-restore', '--disable-build-servers',
    '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-p:PublishSingleFile=true',
    '-p:DefineConstants=TRYLO_BUNDLED', '-p:UseSharedCompilation=false', '-maxcpucount:1', `-p:IntermediateOutputPath=${scratch}${path.sep}`, '-o', build],
  { windowsHide: true, env: { ...process.env, TEMP: scratch, TMP: scratch, DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: '1', DOTNET_GCConserveMemory: '9', DOTNET_gcServer: '0' }, stdio: ['ignore', logFd, logFd] });
  } catch (error) { throw new Error(`OfficeCLI source build failed; see ${log}`, { cause: error }); }
  finally { closeSync(logFd); }
  return path.join(build, 'officecli.exe');
}

async function copy(source, target) {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) throw new Error(`Build input must not be a link: ${source}`);
  if (stat.isDirectory()) {
    await fs.mkdir(target, { recursive: true });
    for (const name of await fs.readdir(source)) {
      if (omit.has(name) || name.endsWith('.pyc') || name.endsWith('.js.map')) continue;
      await copy(path.join(source, name), path.join(target, name));
    }
  } else if (stat.isFile()) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  }
}

async function npmPackage(source, target, files = null, ancestors = new Map()) {
  const pkg = await json(path.join(source, 'package.json'));
  const parents = new Map(ancestors).set(pkg.name, source);
  if (files) {
    for (const file of files) if (existsSync(path.join(source, file))) await copy(path.join(source, file), path.join(target, file));
  } else await copy(source, target);
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
    let dir = source;
    let dependency;
    while (true) {
      const candidate = path.join(dir, 'node_modules', name);
      if (existsSync(path.join(candidate, 'package.json'))) { dependency = candidate; break; }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!dependency) {
      if (pkg.optionalDependencies?.[name]) continue;
      throw new Error(`Missing locked build dependency: ${pkg.name} -> ${name}`);
    }
    if (parents.get(name) !== dependency) await npmPackage(dependency, path.join(target, 'node_modules', name), null, parents);
  }
  return pkg;
}

export async function inventoryTree(root) {
  const files = {};
  async function visit(dir) {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isSymbolicLink()) throw new Error(`Bundle contains a link: ${file}`);
      if (item.isDirectory()) await visit(file);
      else if (item.name !== 'inventory.json') files[path.relative(root, file).replaceAll('\\', '/')] = sha(await fs.readFile(file));
    }
  }
  await visit(root);
  return files;
}

export function prepareBuiltinPython(root) {
  const python = path.join(root, 'computer/python');
  const executable = path.join(python, 'python.exe');
  const env = { ...process.env, PYTHONPATH: '', PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '', ANONYMIZED_TELEMETRY: 'false' };
  // The interpreter is shipped at an exact version. Compile on the build
  // machine so first use does not parse thousands of dependency source files.
  execFileSync(executable, ['-c', 'import windows_mcp.__main__'],
    { windowsHide: true, env, timeout: 120000, stdio: 'pipe' });
}

export async function stageBuiltinTools({ target, sourceRoot = toolsRoot, pythonRoot, officeArtifact } = {}) {
  if (!target) throw new Error('An explicit bundle target is required');
  if (existsSync(target)) throw new Error(`Refuse to merge with an existing built-in bundle: ${target}`);
  await fs.mkdir(target, { recursive: true });
  const tools = {};
  const register = async (id, entry, version, args = []) => {
    tools[id] = { policy: 'bundled', entry, version, args, sha256: sha(await fs.readFile(path.join(target, entry))) };
  };
  const office = path.join(sourceRoot, 'office/OfficeCLI');
  // An explicit unchanged build input may be reused by scoped runtime work.
  // The caller binds it to a recorded digest; default release builds publish
  // Office from source exactly as before.
  let officeExecutable;
  if (officeArtifact) {
    const bytes = await fs.readFile(officeArtifact.path);
    if (sha(bytes) !== officeArtifact.sha256) throw new Error('Office build input digest mismatch');
    officeExecutable = officeArtifact.path;
  } else officeExecutable = await buildBuiltinOffice(office);
  await copy(officeExecutable, path.join(target, 'office/officecli.exe'));
  for (const name of ['LICENSE', 'NOTICE']) if (existsSync(path.join(office, name))) await copy(path.join(office, name), path.join(target, 'office', name));
  const officeVersion = execFileSync(path.join(target, 'office/officecli.exe'), ['--version'], { windowsHide: true, encoding: 'utf8', timeout: 15000 }).trim();
  await register('officecli', 'office/officecli.exe', officeVersion);

  const playwright = await npmPackage(path.join(sourceRoot, 'browser/playwright-mcp'), path.join(target, 'browser/playwright'), ['cli.js', 'index.js', 'package.json', 'LICENSE', 'NOTICE']);
  await register('playwright', 'browser/playwright/cli.js', playwright.version);
  // Chrome DevTools' build/src includes its rollup dependency closure/licenses.
  const devtools = await npmPackage(path.join(sourceRoot, 'browser/chrome-devtools-mcp'), path.join(target, 'browser/devtools'), ['build/src', 'package.json', 'LICENSE', 'NOTICE', 'third_party']);
  await register('chrome-devtools', 'browser/devtools/build/src/bin/chrome-devtools-mcp.js', devtools.version);

  const windows = path.join(sourceRoot, 'computer-control/Windows-MCP');
  const venv = path.join(windows, '.venv');
  const config = await fs.readFile(path.join(venv, 'pyvenv.cfg'), 'utf8');
  const pythonHome = pythonRoot ?? process.env.TRYLO_BUILTIN_PYTHON_ROOT ?? config.match(/^home\s*=\s*(.+)$/m)?.[1].trim();
  if (!pythonHome) throw new Error('The pinned Python build runtime is missing');
  const python = path.join(target, 'computer/python');
  await copy(pythonHome, python);
  const site = path.join(python, 'Lib/site-packages');
  // No venv launchers, editable .pth or absolute developer source paths ship.
  for (const name of await fs.readdir(path.join(venv, 'Lib/site-packages'))) {
    if (name.startsWith('__editable__') || name.startsWith('_virtualenv') || omit.has(name)) continue;
    await copy(path.join(venv, 'Lib/site-packages', name), path.join(site, name));
  }
  await copy(path.join(windows, 'src/windows_mcp'), path.join(site, 'windows_mcp'));
  await copy(path.join(windows, 'LICENSE.md'), path.join(python, 'WINDOWS-MCP-LICENSE.md'));
  for (const name of await fs.readdir(site)) {
    if (!name.endsWith('.pth')) continue;
    const contents = await fs.readFile(path.join(site, name), 'utf8');
    if (/^[A-Za-z]:[\\/]|^\//m.test(contents)) throw new Error(`Nonportable Python search path: ${name}`);
  }
  const version = execFileSync(path.join(python, 'python.exe'), ['-B', '-c', 'import importlib.metadata as m; print(m.version("windows-mcp"))'], { windowsHide: true, encoding: 'utf8', timeout: 15000 }).trim();
  await register('windows-mcp', 'computer/python/python.exe', version, ['-B', '-m', 'windows_mcp']);
  prepareBuiltinPython(target);
  await copy(path.join(sourceRoot, 'software-workspace'), path.join(target, 'software-workspace'));
  await fs.writeFile(path.join(target, 'tool-sources.json'), JSON.stringify({ schemaVersion: 1, tools }, null, 2) + '\n');
  const inventory = await inventoryTree(target);
  await fs.writeFile(path.join(target, 'inventory.json'), JSON.stringify({ schemaVersion: 1, files: inventory }, null, 2) + '\n');
  return { tools, files: Object.keys(inventory).length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) throw new Error('Usage: node stage-builtin-tools.mjs <new-output-directory>');
  console.log(JSON.stringify(await stageBuiltinTools({ target: path.resolve(target) })));
}
