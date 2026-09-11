// node:test — vendored remote gateway Trylo P3 patch: `surface` forwarding
// plus the read-only /v1/artifacts routes. Spins the real HTTP server with
// stub Desktop handlers; asserts auth, shape sanitizing, traversal guards,
// and byte streaming without touching the Desktop.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createRemoteGateway } from '../../vendor/legacy/remote-gateway/index.js';

const PORT = 49401;
const TOKEN = crypto.randomBytes(32).toString('base64url');

let seenTask = null;
const gateway = createRemoteGateway({
  port: PORT,
  authToken: TOKEN,
  workspaceName: 'Artifacts test',
  handlers: {
    task: async (payload) => {
      seenTask = payload;
      return { accepted: true, requestId: payload.requestId };
    },
    artifacts: async () => ({
      artifacts: [
        { id: 'out/report.docx', name: 'out/report.docx', kind: 'document', size: 11, modifiedAt: 7 },
        // Oversized shape: must be capped / filtered by the gateway.
        { id: 'x'.repeat(500), name: 'y'.repeat(500), kind: 'k'.repeat(100), size: -5, modifiedAt: NaN },
      ],
    }),
    artifact: async ({ path }) => {
      if (path === 'out/report.docx') {
        return { name: 'report.docx', mimeType: 'application/pdf', size: 5, data: Buffer.from('hello').toString('base64') };
      }
      throw Object.assign(new Error('missing'), { statusCode: 404 });
    },
  },
});

const auth = { Authorization: `Bearer ${TOKEN}` };

before(async () => {
  await gateway.start();
});

after(async () => {
  await gateway.stop();
});

test('POST /v1/chat/messages forwards surface work to the task handler', async () => {
  const response = await fetch(`http://127.0.0.1:${PORT}/v1/chat/messages`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'make a deck', surface: 'work' }),
  });
  assert.equal(response.status, 202);
  assert.equal(seenTask.surface, 'work');
  assert.equal(seenTask.text, 'make a deck');
});

test('POST /v1/chat/messages defaults a missing surface to code', async () => {
  const response = await fetch(`http://127.0.0.1:${PORT}/v1/chat/messages`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'fix bug' }),
  });
  assert.equal(response.status, 202);
  assert.equal(seenTask.surface, 'code');
});

test('GET /v1/artifacts requires auth and sanitizes the list', async () => {
  const denied = await fetch(`http://127.0.0.1:${PORT}/v1/artifacts`);
  assert.equal(denied.status, 401);
  const response = await fetch(`http://127.0.0.1:${PORT}/v1/artifacts`, { headers: auth });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.artifacts.length, 2);
  assert.deepEqual(body.artifacts[0], {
    id: 'out/report.docx',
    name: 'out/report.docx',
    kind: 'document',
    size: 11,
    modifiedAt: 7,
  });
  assert.ok(body.artifacts[1].id.length <= 200);
  assert.equal(body.artifacts[1].size, 0);
});

test('GET /v1/artifacts/content streams bytes and guards traversal', async () => {
  const denied = await fetch(`http://127.0.0.1:${PORT}/v1/artifacts/content?path=out/report.docx`);
  assert.equal(denied.status, 401);
  const response = await fetch(`http://127.0.0.1:${PORT}/v1/artifacts/content?path=out/report.docx`, { headers: auth });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /application\/pdf/);
  assert.match(response.headers.get('content-disposition') || '', /report\.docx/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.toString('utf8'), 'hello');

  const traversal = await fetch(`http://127.0.0.1:${PORT}/v1/artifacts/content?path=..%2Fsecret.txt`, { headers: auth });
  assert.equal(traversal.status, 400);
  const missing = await fetch(`http://127.0.0.1:${PORT}/v1/artifacts/content?path=out%2Fgone.pdf`, { headers: auth });
  assert.equal(missing.status, 404);
});
