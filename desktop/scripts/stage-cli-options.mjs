import assert from 'node:assert/strict';
import path from 'node:path';

/** Candidate staging can consume an already emitted tree without rebuilding shared dist. */
export function stageCliOptions(argv, { cwd, source, resources }) {
  const values = new Map();
  let skipBuild = false;
  let preparedClosure = false;
  for (const value of argv) {
    if (value === '--skip-build') {
      assert.equal(skipBuild, false, 'Duplicate --skip-build');
      skipBuild = true;
      continue;
    }
    if (value === '--prepared-closure') {
      assert.equal(preparedClosure, false, 'Duplicate --prepared-closure');
      preparedClosure = true;
      continue;
    }
    const match = /^--(cli-dist|output)=(.+)$/.exec(value);
    assert.ok(match, `Unknown staging option: ${value}`);
    assert.equal(values.has(match[1]), false, `Duplicate --${match[1]}`);
    values.set(match[1], path.resolve(cwd, match[2]));
  }
  assert.ok(!skipBuild || values.has('cli-dist'), '--skip-build requires an explicit --cli-dist');
  assert.ok(!preparedClosure || skipBuild && values.has('cli-dist'), '--prepared-closure requires --skip-build and --cli-dist');
  const dist = values.get('cli-dist') ?? path.join(source, 'dist');
  const target = values.get('output') ?? path.join(resources, 'cli');
  const within = (parent, child) => child === parent || child.startsWith(parent + path.sep);
  assert.ok(!within(target, source) && !within(source, target), 'Staging output overlaps CLI source');
  assert.ok(!within(target, dist) && !within(dist, target), 'Staging output overlaps build input');
  assert.notEqual(dist, source, 'Build output must not be the CLI source root');
  assert.ok(!within(path.join(source, 'src'), dist), 'Build output overlaps TypeScript sources');
  return { dist, target, skipBuild, preparedClosure, isolatedOutput: values.has('output') };
}
