import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NPM_INTEGRITY, NPM_URL, verifyNpmArchive } from './stage-npm.mjs';

test('npm staging rejects altered archive bytes before extracting or executing them', () => {
  assert.throws(() => verifyNpmArchive(Buffer.from('untrusted bytes')), /integrity mismatch/);
  assert.match(NPM_INTEGRITY, /^sha512-/);
  assert.equal(new URL(NPM_URL).hostname, 'registry.npmjs.org');
});
