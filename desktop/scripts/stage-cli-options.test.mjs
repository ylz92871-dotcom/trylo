import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { stageCliOptions } from './build/shared/stage-cli-options.mjs';

const base = path.resolve('stage-options-test');
const input = { cwd: base, source: path.join(base, 'cli'), resources: path.join(base, 'resources') };
test('ordinary staging retains the existing dist and resources target', () => {
  assert.deepEqual(stageCliOptions([], input), { dist: path.join(input.source, 'dist'),
    target: path.join(input.resources, 'cli'), skipBuild: false, preparedClosure: false, isolatedOutput: false });
});
test('frozen candidate skips compilation and selects a separate bundle target', () => {
  const result = stageCliOptions(['--skip-build', '--cli-dist=build-v2', '--output=candidate/cli'], input);
  assert.equal(result.dist, path.join(base, 'build-v2'));
  assert.equal(result.target, path.join(base, 'candidate/cli'));
  assert.equal(result.skipBuild, true);
  assert.equal(result.isolatedOutput, true);
});
test('rejects ambiguous inputs and overlapping paths before staging mutations', () => {
  for (const argv of [['--skip-build'], ['--prepared-closure', '--cli-dist=build'], ['--cli-dist=a', '--cli-dist=b'], ['--unknown'],
    ['--output=cli'], ['--cli-dist=build', '--output=build/nested'],
    ['--cli-dist=build/nested', '--output=build'], ['--cli-dist=cli/src']]) {
    assert.throws(() => stageCliOptions(argv, input));
  }
});
test('prepared frozen inputs select verification without another build or hydration', () => {
  const result = stageCliOptions(['--skip-build', '--prepared-closure', '--cli-dist=build-v2', '--output=candidate/cli'], input);
  assert.equal(result.preparedClosure, true);
  assert.equal(result.skipBuild, true);
});

// Platform builders supply the staged interpreter through the same staging entry.
test("accepts an explicit platform Node interpreter without changing legacy defaults", () => {
  const options = stageCliOptions(["--node=/staged/runtime/bin/node"], {
    cwd: process.cwd(), source: "/source/cli", resources: "/bundle/resources",
  });
  assert.equal(options.node, path.resolve(process.cwd(), "/staged/runtime/bin/node"));
});
