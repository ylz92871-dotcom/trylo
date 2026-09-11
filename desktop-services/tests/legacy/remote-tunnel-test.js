const assert = require('node:assert/strict');
const {
  DEFAULT_NAMED_TUNNEL_URL,
  extractQuickTunnelUrl,
  isQuickTunnelUrl,
  isTryloNamedTunnelUrl,
  normalizePublicUrl,
} = require('./remote-tunnel');

assert.equal(normalizePublicUrl(' https://example.com/// '), 'https://example.com');
assert.equal(
  extractQuickTunnelUrl('INF Your quick Tunnel has been created! Visit it at https://amber-bird-123.trycloudflare.com'),
  'https://amber-bird-123.trycloudflare.com',
);
assert.equal(isQuickTunnelUrl('https://amber-bird-123.trycloudflare.com'), true);
assert.equal(isQuickTunnelUrl('https://remote.trylo.example'), false);
assert.equal(DEFAULT_NAMED_TUNNEL_URL, 'https://remote.trylocode.me');
assert.equal(isTryloNamedTunnelUrl('https://remote.trylocode.me/'), true);
assert.equal(isTryloNamedTunnelUrl('https://trylocode.me'), false);
assert.equal(extractQuickTunnelUrl('no public address yet'), '');

console.log('remote tunnel parser smoke test passed');
