import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSkillRuntimeClosure, SKILL_RUNTIME_REL } from '../../new trylo cli/scripts/skill-learning/copy-hermes-runtime.mjs';

const flags = ['--context-window', '--model-context-window'];
const toolCommands = ['status', 'production-list', 'production-show', 'production-verify', 'production-activate'];
const defaultCliRoot = fileURLToPath(new URL('../../new trylo cli/', import.meta.url));
// TS test/dependency inputs are outside freshness checks. Non-TS eligibility
// belongs entirely to the CLI skill runtime reader, shared with its copier.
const typescriptTestDirectories = new Set(['test', 'tests', '__tests__']);

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Development CLI source link requires review');
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name.toLowerCase() !== 'node_modules'
      && !typescriptTestDirectories.has(entry.name.toLowerCase())) files.push(...sourceFiles(file));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}

/** Resolve helper output paths from the existing release inventory, then
 * verify bytes against the original owners' provenance. No staging path policy
 * is copied here and no executable is run merely to inspect readiness. */
function nativeHelpersReady(cliRoot, dist) {
  const inventory = JSON.parse(readFileSync(path.join(dist, 'sbom.json'), 'utf8'));
  if (!Array.isArray(inventory.components)) return false;
  for (const provenancePath of ['src/internal/adapters/sandbox/vendor/sandbox-runtime/PROVENANCE.json', 'vendor-bin/pty/PROVENANCE.json']) {
    const provenance = JSON.parse(readFileSync(path.join(cliRoot, provenancePath), 'utf8'));
    const entries = Object.entries(provenance.artifacts ?? {});
    if (entries.length === 0) return false;
    for (const [name, metadata] of entries) {
      if (typeof metadata.sha256 !== 'string' || !Number.isSafeInteger(metadata.bytes)) return false;
      const components = inventory.components.filter(row => row?.type === 'file' && row.name === name);
      if (components.length !== 1) return false;
      const component = components[0];
      const relative = component.properties?.find(row => row.name === 'trylo:artifact-path')?.value;
      if (typeof relative !== 'string' || !component.hashes?.some(row => row.alg === 'SHA-256' && row.content === metadata.sha256)) return false;
      const output = path.resolve(dist, relative);
      if (!output.startsWith(dist + path.sep)) return false;
      const bytes = readFileSync(output);
      if (bytes.length !== metadata.bytes || createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) return false;
    }
  }
  return true;
}

/** Read-only build readiness, including child/dynamic entries not loaded by --help.
 * Never imports runtime modules, opens a user's home or starts a model/worker. */
export function developmentCliClosureReady(cliRoot = defaultCliRoot) {
  const source = path.join(cliRoot, 'src'), dist = path.join(cliRoot, 'dist');
  try {
    for (const input of sourceFiles(source)) {
      if (!input.endsWith('.ts') || /\.(?:test|spec|d)\.ts$/i.test(input)) continue;
      const output = path.join(dist, path.relative(source, input).replace(/\.ts$/, '.js'));
      const emitted = statSync(output);
      if (!emitted.isFile() || emitted.mtimeMs < statSync(input).mtimeMs) return false;
    }
    // Non-TS Hermes hosts and native assets are copied after tsc. Presence of
    // the child alone cannot prove its worker process and capability closure.
    const closure = readSkillRuntimeClosure({ sourceRoot: path.join(source, SKILL_RUNTIME_REL) });
    for (const file of closure.files) {
      if (!file.bytes.equals(readFileSync(path.join(dist, SKILL_RUNTIME_REL, file.path)))) return false;
    }
    return nativeHelpersReady(cliRoot, dist);
  } catch {
    // Missing/unreadable output is an explicit request to rebuild. If the
    // build cannot repair it, ensureDevelopmentCli below blocks Desktop.
    return false;
  }
}

/** Avoid launching a fresh renderer against an older checkout dist. Never
 * rewrites an operator-supplied CLI or changes provider/account selection. */
export function ensureDevelopmentCli({ nodeProgram = process.execPath, run = spawnSync, log = console.log,
  cliRoot = defaultCliRoot, closureReady = () => developmentCliClosureReady(cliRoot) } = {}) {
  const entry = path.join(cliRoot, 'dist/cmd/trylo/main.js');
  const probe = () => {
    if (!closureReady()) return false;
    const result = run(nodeProgram, [entry, '--help'], { cwd: cliRoot, encoding: 'utf8', timeout: 30000, windowsHide: true });
    const advertised = [...String(result.stdout || '').matchAll(/^\s{2,}(--[\w-]+)/gm)].map(match => match[1]);
    if (result.status !== 0 || !flags.every(flag => advertised.includes(flag))) return false;
    // Read-only help avoids opening the person's learning store during startup.
    const tools = run(nodeProgram, [entry, 'tools', '--help'], { cwd: cliRoot, encoding: 'utf8', timeout: 30000, windowsHide: true });
    const commands = [...String(tools.stdout || '').matchAll(/^trylo tools ([\w-]+)/gm)].map(match => match[1]);
    if (tools.status !== 0 || !toolCommands.every(command => commands.includes(command))) return false;
    const learning = run(nodeProgram, [entry, 'learn', '--help'], { cwd: cliRoot, encoding: 'utf8', timeout: 30000, windowsHide: true });
    if (learning.status !== 0 || !/^\s*trylo learn inspect method\|workflow\|collaboration(?:\s|$)/m.test(String(learning.stdout || ''))) return false;
    const libraries = run(nodeProgram, [entry, 'library', '--help'], { cwd: cliRoot, encoding: 'utf8', timeout: 30000, windowsHide: true });
    return libraries.status === 0 && /^\s*trylo library tool\|expert(?:\s|$)/m.test(String(libraries.stdout || ''));
  };
  if (probe()) return;
  log('Refreshing the development CLI and its learning runtime closure…');
  const compiler = path.join(cliRoot, 'node_modules/typescript/bin/tsc');
  const steps = [
    { name: 'TypeScript compilation', args: [compiler, '-p', 'tsconfig.json'] },
    { name: 'sandbox and learning runtime copy', args: ['scripts/copy-vendor.mjs'] },
    { name: 'PTY helper copy', args: ['scripts/pty/copy-pty-vendor.mjs'] },
    { name: 'release inventory', args: ['scripts/release-inventory.mjs'] },
  ];
  for (const { name, args } of steps) {
    log(`Development CLI: ${name}…`);
    // Compilation duration depends on the checkout and host load. The caller
    // owns cancellation; a startup timer must not kill a healthy build.
    const result = run(nodeProgram, args, { cwd: cliRoot, stdio: 'inherit', windowsHide: true });
    if (result.error || result.status !== 0) {
      const reason = result.error
        ? `${result.error.code ? `${result.error.code}: ` : ''}${result.error.message}`
        : result.signal ? `signal ${result.signal}` : `exit code ${result.status ?? 'unknown'}`;
      throw new Error(`Development CLI build failed at ${name} (${reason}); Desktop was not started. Inspect the build output above.`,
        result.error ? { cause: result.error } : undefined);
    }
  }
  if (!probe()) throw Error('Development CLI still lacks a current runtime closure, model context options, tool management or learning/library commands after rebuilding.');
}
