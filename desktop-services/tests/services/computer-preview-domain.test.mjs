import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createToolingServices } from '../../src/tooling/index.mjs';
import { encode, decodeRaw, eventFrame } from '../../src/protocol/frames.mjs';

test('production tooling domain carries scoped frames and acknowledgements through the real event codec', async () => {
  const testParent = fs.mkdtempSync(path.join(os.tmpdir(), 'trylo-desktop-ui-integration-'));
  const root = fs.mkdtempSync(path.join(testParent, 'computer-preview-domain-'));
  const events = [];
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null });
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
  const commands = [];
  child.stdin.on('data', value => commands.push(value.toString()));
  const services = createToolingServices({ appDataDir: root, sidecarsDir: root,
    emit: async (topic, payload) => events.push(decodeRaw(encode(eventFrame(topic, payload)))),
    seam: { manifests: [], computerPreview: { platform: 'win32', resolveExecutable: async () => 'synthetic-python.exe', spawnWorker: () => child } },
  });
  try {
    const started = await services.computerPreviewStart({ projectRoot: root, conversationId: 'proof', streamId: 'run-proof' });
    assert.equal(started.ok, true);
    child.stdout.write(JSON.stringify({ type: 'status', state: 'running' }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'frame', data: 'aGVsbG8=', mimeType: 'image/jpeg', width: 2560, height: 1600,
      originX: 0, originY: 0, timestamp: 100, seq: 1 }) + '\n');
    await new Promise(resolve => setImmediate(resolve));
    const frame = events.find(event => event?.topic === 'tooling.computerPreviewFrame');
    assert.equal(frame?.payload.width, 2560);
    assert.equal(frame?.payload.streamId, 'run-proof');
    assert.equal(commands.filter(command => command === 'next\n').length, 2);
    services.computerPreviewAck({ scope: frame.payload.scope, streamId: 'run-proof', seq: 1 });
    assert.equal(commands.filter(command => command === 'next\n').length, 2);
    services.computerPreviewStop({ scope: frame.payload.scope, streamId: 'run-proof' });
    assert.ok(events.some(event => event?.topic === 'tooling.computerPreviewStatus' && event.payload.state === 'stopped'));
  } finally {
    services.dispose();
    assert.ok(root.startsWith(testParent + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(testParent, { recursive: true, force: true });
  }
});
