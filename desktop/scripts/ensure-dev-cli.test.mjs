import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureDevelopmentCli } from './ensure-dev-cli.mjs';

const current = 'trylo - learning agent CLI\n  --context-window <tokens>\n  --model-context-window <tokens>\n';
const tools = ['status', 'production-list', 'production-show', 'production-verify', 'production-activate']
  .map(command => `trylo tools ${command}`).join('\n');
const help = args => args.includes('tools') ? tools : current;

test('a current CLI is checked without rebuilding', () => {
  const calls = [];
  ensureDevelopmentCli({ log: () => {}, run: (program, args) => {
    calls.push(args);
    return { status: 0, stdout: help(args) };
  } });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(args => args.at(-1) === '--help'));
});

test('an older checkout dist is rebuilt once and rechecked before Desktop starts', () => {
  let mainProbes = 0;
  const builds = [];
  ensureDevelopmentCli({ log: () => {}, run: (program, args) => {
    if (args.at(-1) === '--help') return { status: 0, stdout:
      !args.includes('tools') && ++mainProbes === 1 ? 'old help' : help(args) };
    builds.push(args);
    return { status: 0 };
  } });
  assert.equal(mainProbes, 2);
  assert.equal(builds.length, 4);
  assert.match(builds[0][0], /typescript[/\\]bin[/\\]tsc$/);
});

test('a failed build prevents launch instead of hiding unsupported commands', () => {
  assert.throws(() => ensureDevelopmentCli({ log: () => {}, run: (program, args) =>
    args.at(-1) === '--help' ? { status: 0, stdout: 'old help' } : { status: 1 },
  }), /build failed/);
});

test('context options alone do not make an older CLI compatible with tool management', () => {
  const builds = [];
  let toolProbes = 0;
  ensureDevelopmentCli({ log: () => {}, run: (program, args) => {
    if (args.at(-1) === '--help') return { status: 0, stdout: args.includes('tools')
      ? ++toolProbes === 1 ? 'old tools help' : tools : current };
    builds.push(args);
    return { status: 0 };
  } });
  assert.equal(toolProbes, 2);
  assert.equal(builds.length, 4);
});

test('a rebuild that still lacks tool management prevents launch', () => {
  assert.throws(() => ensureDevelopmentCli({ log: () => {}, run: (program, args) =>
    ({ status: 0, stdout: args.includes('tools') ? 'old tools help' : current }),
  }), /still lacks.*tool management/);
});
