import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const enabled = process.platform === 'win32';
const run = (file, args) => execFileSync(file, args, { windowsHide: true, encoding: 'utf8', timeout: 60_000 });
let evidence, gui, child, runner;

before(() => {
  if (!enabled) return;
  const evidenceRoot = process.env.TRYLO_CONSOLE_EVIDENCE_DIR || path.join(root, 'Temp/background-console');
  mkdirSync(evidenceRoot, { recursive: true });
  evidence = mkdtempSync(path.join(evidenceRoot, 'probe-'));
  gui = path.join(evidence, 'gui.exe');
  child = path.join(evidence, 'console-child.exe');
  const fixture = path.join(root, 'desktop/scripts/fixtures/background-console-probe.rs');
  const deps = path.join(root, 'desktop/src-tauri/target/debug/deps');
  const tokio = readdirSync(deps).filter(name => /^libtokio-.*\.rlib$/.test(name))
    .map(name => path.join(deps, name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  assert.ok(tokio, 'build the Desktop Rust dependencies before running the platform probe');
  run('rustc', ['--edition=2021', '--cfg', 'console_child', fixture, '-o', child]);
  run('rustc', ['--edition=2021', fixture, '-L', `dependency=${deps}`, '--extern', `tokio=${tokio}`, '-o', gui]);

  // Compile the current Git adapter in isolation; never consume a stale dist.
  const cli = path.join(root, 'new trylo cli');
  const ts = createRequire(path.join(cli, 'package.json'))('typescript');
  const compiled = path.join(evidence, 'cli');
  for (const relative of ['internal/adapters/git/runner', 'internal/adapters/git/runner.test', 'internal/surface/cli/git-diff']) {
    const destination = path.join(compiled, `${relative}.js`);
    mkdirSync(path.dirname(destination), { recursive: true });
    const source = readFileSync(path.join(cli, 'src', `${relative}.ts`), 'utf8');
    writeFileSync(destination, ts.transpileModule(source, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022,
    } }).outputText);
  }
  writeFileSync(path.join(compiled, 'package.json'), '{"type":"module"}\n');
  runner = path.join(compiled, 'internal/adapters/git/runner.js');
  console.log(`console evidence: ${evidence}`);
});

function probe(mode, program, args = []) {
  const report = path.join(evidence, `${mode}.json`);
  run(gui, [mode, report, program, ...args]);
  const result = JSON.parse(readFileSync(report, 'utf8'));
  assert.equal(result.parentConsole, false, 'fixture must model the release GUI subsystem');
  assert.equal(result.exit, 0);
  return result.child;
}

for (const api of ['std', 'tokio']) {
  test(`GUI parent: ${api} background child has no console`, { skip: !enabled }, () => {
    if (process.env.TRYLO_CONSOLE_FIXED_ONLY !== '1') {
      const baseline = probe(`baseline-${api}`, child);
      assert.equal(baseline.console, true, 'positive control must expose the original console allocation');
    }
    const fixed = probe(`fixed-${api}`, child);
    assert.deepEqual(fixed, { console: false, visible: false });
  });
}

test('GUI parent: current CLI Git adapter has no console and retains stdout', { skip: !enabled }, () => {
  const script = path.join(evidence, 'cli-probe.mjs');
  writeFileSync(script, `import { createGitRunner } from ${JSON.stringify(pathToFileURL(runner).href)};
const result = await createGitRunner().run([process.argv[2]], process.cwd());
if (result.exit !== 0) throw new Error(result.stderr);
process.stdout.write(result.stdout);
`);
  const result = probe('cli', process.execPath, [script, child]);
  assert.deepEqual(result, { console: false, visible: false });
});
