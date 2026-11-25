import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export const officeEngineDarwinLock = JSON.parse(await fs.readFile(new URL('./office-engine.darwin-arm64.lock.json', import.meta.url), 'utf8'));

export async function officeEngineDigest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyMacosOfficeEngine(root) {
  const lock = officeEngineDarwinLock;
  const bundle = path.join(await fs.realpath(root), lock.bundle);
  assert.equal(await fs.realpath(bundle), bundle, 'LibreOffice application bundle is redirected');
  for (const [file, expected] of Object.entries(lock.criticalFiles)) {
    const target = path.join(bundle, file);
    assert.equal(await fs.realpath(target), target, `LibreOffice critical file is redirected: ${file}`);
    assert.equal(await officeEngineDigest(target), expected, `LibreOffice file differs from the lock: ${file}`);
  }
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', lock.signatureRequirement, bundle], { stdio: 'inherit' });
}
