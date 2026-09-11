const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createRemoteGateway } = require('./index');

async function main() {
  const port = 49391;
  const token = crypto.randomBytes(32).toString('base64url');
  let first = null;
  let second = null;

  first = createRemoteGateway({
    port,
    authToken: token,
    workspaceName: 'First workspace',
    handlers: {
      handoff: async () => {
        setTimeout(() => void first.stop(), 30);
        return { releasing: true };
      },
    },
  });
  await first.start();

  try {
    const occupied = createRemoteGateway({ port, authToken: token, workspaceName: 'Second workspace' });
    await assert.rejects(() => occupied.start(), error => error?.code === 'EADDRINUSE');
    await occupied.stop();

    const handoff = await fetch(`http://127.0.0.1:${port}/v1/admin/handoff`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(handoff.status, 202);

    const deadline = Date.now() + 2000;
    while (first.listening && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    assert.equal(first.listening, false);

    second = createRemoteGateway({ port, authToken: token, workspaceName: 'Second workspace' });
    await second.start();
    const health = await fetch(`http://127.0.0.1:${port}/health`).then(response => response.json());
    assert.equal(health.ok, true);
    console.log('remote-gateway handoff test passed');
  } finally {
    await second?.stop().catch(() => null);
    await first?.stop().catch(() => null);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
