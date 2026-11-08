import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { artifactPath, operationsPath, repositoryRoot, taskPath } from './workspace-paths.mjs';
import { relocatedRecordPath } from './workspace-record-locations.mjs';

test('a frozen archive locator reads the same bytes after relocation without rewriting its record', async () => {
  const name = `layout-locator-${crypto.randomUUID()}.txt`;
  const original = JSON.stringify({ archive: path.join(repositoryRoot, 'output', name), sha256: crypto.createHash('sha256').update('fixture').digest('hex') });
  const target = artifactPath('output', name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.writeFile(target, 'fixture', { flag: 'wx' });
    const record = JSON.parse(original);
    assert.equal(crypto.createHash('sha256').update(await fs.readFile(relocatedRecordPath(record.archive))).digest('hex'), record.sha256);
    assert.equal(JSON.stringify(record), original);
  } finally { await fs.unlink(target); }
});

test('specific operations and historical task locators retain their separate owners', () => {
  assert.equal(relocatedRecordPath(path.join(repositoryRoot, 'work/site-security-v2-20261104/tooling/node.exe')), operationsPath('site-security-v2-20261104/tooling/node.exe'));
  assert.equal(relocatedRecordPath(path.join(repositoryRoot, 'work/skill-daily-20261103/evidence/fixture.json')), taskPath('legacy-work/skill-daily-20261103/evidence/fixture.json'));
  const unrelated = path.join(repositoryRoot, 'output-sibling', 'file');
  assert.equal(relocatedRecordPath(unrelated), unrelated);
  assert.throws(() => relocatedRecordPath(undefined));
});
