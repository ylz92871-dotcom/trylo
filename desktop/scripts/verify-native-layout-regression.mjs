// Isolated mutation test: production files are read only.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { artifactPath, temporaryPath } from '../../scripts/workspace-paths.mjs';
const desktop = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const { transform } = createRequire(path.join(desktop, '../desktop-services/package.json'))('esbuild');
const file = path.join(desktop, 'src/tooling/native-browser-layout.ts');
const source = await fs.readFile(file, 'utf8');
const condition = 'if (last && last.command.scope === command.scope && last.command.visible === command.visible)';
assert.ok(source.includes(condition));
const temporaryRoot = temporaryPath('desktop-native-layout-regression');
await fs.mkdir(temporaryRoot, { recursive: true });
const temporary = await fs.mkdtemp(path.join(temporaryRoot, 'run-'));
const proof = { nativeVerified: false, kind: 'blocked native-call backpressure and isolated regression mutation', sourceHash: crypto.createHash('sha256').update(source).digest('hex') };
async function run(name, contents) {
  const target = path.join(temporary, `${name}.mjs`);
  await fs.writeFile(target, (await transform(contents, { loader: 'ts', format: 'esm', target: 'es2022' })).code);
  const { createNativeLayoutQueue } = await import(pathToFileURL(target).href);
  let release;
  const calls = [];
  const queue = createNativeLayoutQueue(command => { calls.push(command.bounds.width); return calls.length === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(); }, () => true);
  const command = width => ({ scope: 'one', operation: 'layout', visible: true, bounds: { x: 700, y: 100, width, height: 600 } });
  const jobs = [queue(command(320)), ...Array.from({ length: 120 }, (_, index) => queue(command(321 + index)))];
  release(); await Promise.all(jobs);
  return { calls: calls.length, firstWidth: calls[0], lastWidth: calls.at(-1) };
}
try {
  proof.baseline = await run('baseline', source);
  assert.equal(proof.baseline.calls, 2); assert.equal(proof.baseline.lastWidth, 440);
  proof.mutant = await run('replay-all-sizes', source.replace(condition, 'if (false)'));
  try { assert.equal(proof.mutant.calls, 2); proof.mutationCaught = false; } catch { proof.mutationCaught = true; }
  assert.equal(proof.mutationCaught, true);
  proof.result = 'pass';
} finally {
  assert.equal(await fs.readFile(file, 'utf8'), source, 'production source changed during mutation verification');
  const resolved = path.resolve(temporary);
  if (resolved.startsWith(temporaryRoot + path.sep) && path.basename(resolved).startsWith('run-')) await fs.rm(resolved, { recursive: true, force: true });
}
const output = artifactPath('desktop-native-layout-regression');
await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, 'resize-regression.json'), JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify(proof));
