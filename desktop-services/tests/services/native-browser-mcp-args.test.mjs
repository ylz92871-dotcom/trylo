import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeBrowserMcpArgs } from '../../src/tooling/native-browser-mcp.mjs';

const gate = 'http://127.0.0.1:64430/aabbcc';
const socket = 'ws://127.0.0.1:64430/aabbcc/cdp/browser';
test('old Chrome profiles reconnect without losing their session path', () => {
  assert.deepEqual(nativeBrowserMcpArgs(gate, ['--no-performance-crux', '--browserUrl', `${gate}/`]),
    ['--no-performance-crux', '--wsEndpoint', socket]);
  assert.deepEqual(nativeBrowserMcpArgs(gate, [`--browserUrl=${gate}`]), ['--wsEndpoint', socket]);
});
test('current Chrome and Playwright arguments stay scoped to the same gate', () => {
  const chrome = ['--wsEndpoint', socket];
  const playwright = ['--cdp-endpoint', `${gate}/`];
  assert.deepEqual(nativeBrowserMcpArgs(gate, chrome), chrome);
  assert.deepEqual(nativeBrowserMcpArgs(gate, playwright), playwright);
});
test('a mismatched old endpoint is refused instead of bypassing the gate', () => {
  for (const value of ['http://127.0.0.1:64430/', `${gate}/other`, 'http://127.0.0.1:64430/ddff']) {
    assert.throws(() => nativeBrowserMcpArgs(gate, ['--browserUrl', value]), /does not match/);
  }
});
