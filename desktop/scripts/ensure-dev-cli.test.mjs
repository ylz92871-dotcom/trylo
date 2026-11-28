import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureDevelopmentCli } from './ensure-dev-cli.mjs';
import { ptyArtifactDirectory, ptyStagedPath } from '../../new trylo cli/scripts/pty/copy-pty-vendor.mjs';

const windows = process.platform === 'win32';
const ptyName = `trylo-pty-${ptyArtifactDirectory(process.platform, process.arch)}`;
const ptyOutput = ptyStagedPath(process.platform, process.arch);
const sandboxOutput = 'internal/adapters/sandbox/vendor/sandbox-runtime/srt-win/x64/srt-win.exe';

const current = 'trylo - learning agent CLI\n  --context-window <tokens>\n  --model-context-window <tokens>\n';
const tools = ['status', 'production-list', 'production-show', 'production-verify', 'production-activate']
  .map(command => `trylo tools ${command}`).join('\n');
const learning = 'trylo learn inspect method|workflow|collaboration [version-id]\n';
const libraries = 'trylo library tool|expert [--workspace ROOT] -\n';
const help = args => args.includes('tools') ? tools : args.includes('learn') ? learning : args.includes('library') ? libraries : current;

test('a current CLI is checked without rebuilding', () => {
  const calls = [];
  ensureDevelopmentCli({ closureReady: () => true, log: () => {}, run: (program, args) => {
    calls.push(args);
    return { status: 0, stdout: help(args) };
  } });
  assert.equal(calls.length, 4);
  assert.ok(calls.every(args => args.at(-1) === '--help'));
});

test('an older checkout dist is rebuilt once and rechecked before Desktop starts', () => {
  let mainProbes = 0;
  const builds = [];
  ensureDevelopmentCli({ closureReady: () => true, log: () => {}, run: (program, args) => {
    if (args.at(-1) === '--help') return { status: 0, stdout:
      args[1] === '--help' && ++mainProbes === 1 ? 'old help' : help(args) };
    builds.push(args);
    return { status: 0 };
  } });
  assert.equal(mainProbes, 2);
  assert.equal(builds.length, 4);
  assert.match(builds[0][0], /typescript[/\\]bin[/\\]tsc$/);
});

test('a failed build prevents launch instead of hiding unsupported commands', () => {
  assert.throws(() => ensureDevelopmentCli({ closureReady: () => true, log: () => {}, run: (program, args) =>
    args.at(-1) === '--help' ? { status: 0, stdout: 'old help' } : { status: 1 },
  }), /build failed/);
});

test('a healthy long CLI build is not cancelled by an implicit startup deadline', () => {
  let built = false;
  const steps = [];
  ensureDevelopmentCli({ closureReady: () => true, log: () => {}, run: (_program, args, options) => {
    if (args.at(-1) === '--help') return { status: 0, stdout: built ? help(args) : 'old help' };
    steps.push(args);
    if (options.timeout !== undefined) {
      return { status: null, signal: 'SIGTERM', error: Object.assign(new Error('build still running'), { code: 'ETIMEDOUT' }) };
    }
    built = true;
    return { status: 0 };
  } });
  assert.equal(steps.length, 4);
});

for (const [index, name] of ['TypeScript compilation', 'sandbox and learning runtime copy', 'PTY helper copy', 'release inventory'].entries()) {
  test(`a ${name} failure identifies its build step and exit code`, () => {
    let step = 0;
    assert.throws(() => ensureDevelopmentCli({ closureReady: () => true, log: () => {}, run: (_program, args) => {
      if (args.at(-1) === '--help') return { status: 0, stdout: 'old help' };
      return { status: step++ === index ? 17 : 0 };
    } }), error => error.message.includes(name) && error.message.includes('exit code 17'));
  });
}

test('a build spawn error preserves its system error and original cause', () => {
  const cause = Object.assign(new Error('cannot start the compiler'), { code: 'EACCES' });
  assert.throws(() => ensureDevelopmentCli({ closureReady: () => true, log: () => {}, run: (_program, args) =>
    args.at(-1) === '--help' ? { status: 0, stdout: 'old help' } : { status: null, error: cause },
  }), error => error.message.includes('TypeScript compilation') && error.message.includes('EACCES') && error.cause === cause);
});

test('a signalled compiler is reported separately from an ordinary exit code', () => {
  assert.throws(() => ensureDevelopmentCli({ closureReady: () => true, log: () => {}, run: (_program, args) =>
    args.at(-1) === '--help' ? { status: 0, stdout: 'old help' } : { status: null, signal: 'SIGTERM' },
  }), /TypeScript compilation.*signal SIGTERM/);
});

test('context options alone do not make an older CLI compatible with tool management', () => {
  const builds = [];
  let toolProbes = 0;
  ensureDevelopmentCli({ closureReady: () => true, log: () => {}, run: (program, args) => {
    if (args.at(-1) === '--help') return { status: 0, stdout: args.includes('tools')
      ? ++toolProbes === 1 ? 'old tools help' : tools : help(args) };
    builds.push(args);
    return { status: 0 };
  } });
  assert.equal(toolProbes, 2);
  assert.equal(builds.length, 4);
});

test('a rebuild that still lacks tool management prevents launch', () => {
  assert.throws(() => ensureDevelopmentCli({ closureReady: () => true, log: () => {}, run: (program, args) =>
    ({ status: 0, stdout: args.includes('tools') ? 'old tools help' : current }),
  }), /still lacks.*tool management/);
});

for (const command of ['learn', 'library']) test(`a CLI without ${command} reads is rebuilt before opening the new learning UI`, () => {
  let probes = 0;
  const builds = [];
  ensureDevelopmentCli({ closureReady: () => true, log: () => {}, run: (_program, args) => {
    if (args.at(-1) === '--help') return { status: 0, stdout:
      args.includes(command) && ++probes === 1 ? 'old help' : help(args) };
    builds.push(args);
    return { status: 0 };
  } });
  assert.equal(probes, 2);
  assert.equal(builds.length, 4);
});

function closureFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'trylo-dev-cli-readiness-'));
  const skill = 'internal/learning/agent/subsystems/skill';
  const sources = new Map([
    ['cmd/trylo/main.ts', 'export {};'],
    ['cmd/trylo/central-runtime-main.ts', 'export {};'],
    ['internal/surface/cli/central-runtime-domains.ts', 'export {};'],
    ['internal/surface/cli/central-runtime-domains.test.ts', 'test-only;'],
    [`${skill}/host/worker.mjs`, 'export {};'],
    [`${skill}/compat/index.mjs`, 'export {};'],
    [`${skill}/vendor/legacy/package.json`, '{"type":"commonjs"}'],
    [`${skill}/vendor/legacy/server.py`, '# pinned native capability'],
    [`${skill}/tests/omitted-runtime.py`, '# test input never copied'],
  ]);
  const asset = Buffer.from(sources.get(`${skill}/vendor/legacy/server.py`));
  sources.set(`${skill}/vendor/VENDOR-MANIFEST.json`, JSON.stringify({ schemaVersion: 1,
    assets: [{ destination: 'legacy/server.py', bytes: asset.length,
      vendoredSha256: createHash('sha256').update(asset).digest('hex') }] }));
  const put = (base, name, text) => {
    const target = path.join(root, base, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
    return target;
  };
  for (const [name, text] of sources) put('src', name, text);
  const helpers = new Map([
    ['srt-win-x64', { output: sandboxOutput, bytes: Buffer.from('sandbox fixture') }],
    [ptyName, { output: ptyOutput, bytes: Buffer.from('pty fixture') }],
  ]);
  const metadata = name => ({ bytes: helpers.get(name).bytes.length,
    sha256: createHash('sha256').update(helpers.get(name).bytes).digest('hex') });
  put('src', 'internal/adapters/sandbox/vendor/sandbox-runtime/PROVENANCE.json',
    JSON.stringify({ artifacts: { 'srt-win-x64': metadata('srt-win-x64') } }));
  put('vendor-bin', 'pty/PROVENANCE.json',
    JSON.stringify({ artifacts: { [ptyName]: metadata(ptyName) } }));
  if (!windows) helpers.delete('srt-win-x64');
  const repair = () => {
    for (const [name, text] of sources) {
      if (name.endsWith('.test.ts') || name.includes('/tests/')) continue;
      const target = put('dist', name.replace(/\.ts$/, '.js'), text);
      const future = new Date(Date.now() + 2000);
      utimesSync(target, future, future);
    }
    for (const row of helpers.values()) put('dist', row.output, row.bytes);
    put('dist', 'sbom.json', JSON.stringify({ components: [...helpers].map(([name, row]) => ({ type: 'file', name,
      hashes: [{ alg: 'SHA-256', content: metadata(name).sha256 }],
      properties: [{ name: 'trylo:artifact-path', value: row.output }] })) }));
  };
  repair();
  return { root, skill, repair, put, close: () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  } };
}

for (const defect of ['child', 'dynamic-sibling', 'stale-source', 'missing-native', 'changed-native',
  ...(windows ? ['missing-sandbox', 'changed-sandbox'] : []), 'missing-pty', 'changed-pty']) {
  test(`current help cannot hide a ${defect} closure defect`, () => {
    const fixture = closureFixture();
    try {
      if (defect === 'child') rmSync(path.join(fixture.root, 'dist/cmd/trylo/central-runtime-main.js'));
      if (defect === 'dynamic-sibling') rmSync(path.join(fixture.root, 'dist/internal/surface/cli/central-runtime-domains.js'));
      if (defect === 'stale-source') {
        const older = new Date(0);
        utimesSync(path.join(fixture.root, 'dist/cmd/trylo/central-runtime-main.js'), older, older);
      }
      if (defect === 'missing-native') rmSync(path.join(fixture.root, 'dist', fixture.skill, 'host/worker.mjs'));
      if (defect === 'changed-native') fixture.put('dist', `${fixture.skill}/vendor/legacy/server.py`, '# altered native capability');
      for (const [component, relative] of [['sandbox', sandboxOutput], ['pty', ptyOutput]]) {
        if (defect === `missing-${component}`) rmSync(path.join(fixture.root, 'dist', relative));
        if (defect === `changed-${component}`) fixture.put('dist', relative, 'changed helper');
      }
      const builds = [];
      const run = (_program, args) => {
        if (args.at(-1) === '--help') return { status: 0, stdout: help(args) };
        builds.push(args);
        fixture.repair();
        return { status: 0 };
      };
      ensureDevelopmentCli({ cliRoot: fixture.root, log: () => {}, run });
      assert.equal(builds.length, 4, 'an incomplete/stale runtime must be rebuilt even when help is current');
      assert.equal(readFileSync(path.join(fixture.root, 'dist', fixture.skill, 'vendor/legacy/server.py'), 'utf8'), '# pinned native capability');
      ensureDevelopmentCli({ cliRoot: fixture.root, log: () => {}, run });
      assert.equal(builds.length, 4, 'the repaired closure must be reused');
    } finally { fixture.close(); }
  });
}

test('a build leaving its child closure absent prevents Desktop launch', () => {
  const fixture = closureFixture();
  try {
    rmSync(path.join(fixture.root, 'dist/cmd/trylo/central-runtime-main.js'));
    assert.throws(() => ensureDevelopmentCli({ cliRoot: fixture.root, log: () => {},
      run: (_program, args) => ({ status: 0, stdout: help(args) }) }), /still lacks/);
  } finally { fixture.close(); }
});
