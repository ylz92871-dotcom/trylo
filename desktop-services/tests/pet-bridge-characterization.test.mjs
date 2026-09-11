// Trylo Desktop Services — pet bridge characterization (migration spec §6.2).
//
// Drives the byte-identical vendor bridge
// (`vendor/legacy/desktop-companion-bridge.js`) against a fake WPF companion
// and pins the wire behavior the Desktop pet integration depends on. Every
// expectation here is derived from the vendor protocol code only (UDP state
// channel, protocol 1 envelope; TCP chat channel, protocol 2) — never from
// any new implementation (spec §10: "先让旧测试在新目录通过再接 Desktop").
//
// Port note: production ports are 49371 (UDP) / 49372 (TCP). The bridge takes
// `companionPort` / `chatPort` options precisely so tests can inject
// ephemeral ports — the same technique as the legacy root smoke
// `smoke-desktop-chat.js`. We bind ephemeral ports to stay parallel-safe and
// to never talk to a real companion exe running on this machine
// (deviation recorded in the migration PR description).
//
// Windows-only: the vendor `enable()` no-ops off win32, so the suite skips
// elsewhere (same constraint as the legacy smoke).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createDesktopCompanionBridge } = require(
  '../vendor/legacy/desktop-companion-bridge.js',
);

const WORKSPACE = 'D:/ws/trylo-demo';
const short = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `fn` until truthy; rejects after `timeoutMs`. */
function eventually(fn, timeoutMs = 1200) {
  const deadline = Date.now() + timeoutMs;
  const attempt = () => {
    const value = fn();
    if (value) return Promise.resolve(value);
    if (Date.now() > deadline) {
      return Promise.reject(new Error(`condition not met within ${timeoutMs}ms`));
    }
    return short(10).then(attempt);
  };
  return attempt();
}

/** Collects parsed protocol messages with consume-based waiting, so stray
 *  re-announces / heartbeats never break a later assertion. */
function createCollector(label) {
  const items = [];
  const waiters = [];
  return {
    push(item) {
      items.push(item);
      for (let i = 0; i < waiters.length; i++) {
        const waiter = waiters[i];
        if (waiter.predicate(item)) {
          waiters.splice(i, 1);
          item.claimed = true;
          clearTimeout(waiter.timer);
          waiter.resolve(item);
          return;
        }
      }
    },
    waitFor(predicate, timeoutMs = 1500) {
      const existing = items.find((item) => !item.claimed && predicate(item));
      if (existing) {
        existing.claimed = true;
        return Promise.resolve(existing);
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve: (item) => {
            item.claimed = true;
            clearTimeout(waiter.timer);
            resolve(item);
          },
          timer: null,
        };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`${label}: message not received within ${timeoutMs}ms`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    /** Asserts no UNCLAIMED message matching `predicate` shows up within
     *  `withinMs` (used for "the bridge must stay silent" pins). */
    async assertNone(predicate, withinMs = 350) {
      await short(withinMs);
      const stray = items.find((item) => !item.claimed && predicate(item));
      assert.equal(
        stray,
        undefined,
        `${label}: unexpected message ${JSON.stringify(stray)}`,
      );
    },
  };
}

describe('pet bridge characterization (fake WPF)', { skip: process.platform !== 'win32' }, () => {
  /** Fake WPF side. The UDP socket plays the production companion: it
   *  receives envelopes on an ephemeral port and answers permission
   *  decisions back to the bridge's ephemeral source port (the vendor
   *  socket never binds, so the peer must reply to rinfo). */
  const fake = {
    udp: null,
    udpPort: 0,
    lastRinfo: null,
    udpCol: createCollector('udp'),
    server: null,
    tcpPort: 0,
    chatCol: createCollector('tcp'),
    bridgeConn: null,
  };
  let bridge = null;
  let clientId = '';
  const decisions = [];
  const chatRequests = [];

  function sendDecision(message) {
    assert.ok(fake.lastRinfo, 'no envelope received yet; cannot reply');
    fake.udp.send(
      Buffer.from(JSON.stringify(message), 'utf8'),
      fake.lastRinfo.port,
      fake.lastRinfo.address,
    );
  }

  function sendChatLine(message) {
    assert.ok(fake.bridgeConn && !fake.bridgeConn.destroyed, 'bridge chat connection missing');
    fake.bridgeConn.write(`${JSON.stringify(message)}\n`);
  }

  before(async () => {
    fake.udp = dgram.createSocket('udp4');
    await new Promise((resolve, reject) => {
      fake.udp.once('error', reject);
      fake.udp.bind(0, '127.0.0.1', () => {
        fake.udp.removeListener('error', reject);
        resolve();
      });
    });
    fake.udpPort = fake.udp.address().port;
    fake.udp.on('message', (body, rinfo) => {
      fake.lastRinfo = rinfo;
      try {
        fake.udpCol.push(JSON.parse(body.toString('utf8')));
      } catch {
        // Malformed datagrams are not part of the characterized behavior.
      }
    });

    fake.server = net.createServer((conn) => {
      fake.bridgeConn = conn;
      conn.setEncoding('utf8');
      let buffer = '';
      conn.on('data', (chunk) => {
        buffer += chunk;
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line) continue;
          try {
            fake.chatCol.push(JSON.parse(line));
          } catch {
            // Malformed lines are covered by their own test below.
          }
        }
      });
    });
    await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
    fake.tcpPort = fake.server.address().port;

    // A nonexistent extension dir keeps launchCompanion() from spawning a
    // real TryloDesktopPet.exe (same trick as the legacy smoke).
    const missingDir = path.join(os.tmpdir(), `trylo-test-missing-companion-${Date.now()}`);
    bridge = createDesktopCompanionBridge({
      extensionPath: missingDir,
      workspacePath: WORKSPACE,
      companionPort: fake.udpPort,
      chatPort: fake.tcpPort,
    });
  });

  after(() => {
    try {
      bridge?.dispose();
    } catch {
      // teardown best-effort
    }
    try {
      fake.bridgeConn?.destroy();
    } catch {
      // teardown best-effort
    }
    try {
      fake.server?.close();
    } catch {
      // teardown best-effort
    }
    try {
      fake.udp?.close();
    } catch {
      // teardown best-effort
    }
  });

  it('enable() announces hello + chat_hello with the full protocol-1 envelope', async () => {
    bridge.enable();
    assert.equal(bridge.enabled, true);

    const hello = await fake.udpCol.waitFor((m) => m.type === 'hello');
    assert.equal(hello.protocol, 1);
    clientId = hello.clientId;
    assert.match(clientId, /^[0-9a-f-]{36}$/);
    assert.equal(hello.workspacePath, WORKSPACE);
    assert.equal(hello.workspaceName, 'trylo-demo');
    assert.equal(hello.extensionPid, process.pid);
    assert.equal(hello.permission, null);
    // Initial lastState per the vendor module.
    assert.equal(hello.state, 'idle');
    assert.equal(hello.detail, 'Ready');
    assert.equal(hello.level, 'info');
    assert.equal(hello.progress, 0);

    const chatHello = await fake.chatCol.waitFor((m) => m.type === 'chat_hello');
    assert.equal(chatHello.protocol, 2);
    assert.equal(chatHello.clientId, clientId);
    assert.equal(typeof chatHello.at, 'number');

    // Heartbeat rides the same envelope every HEARTBEAT_MS (vendor: 2000).
    const beat = await fake.udpCol.waitFor((m) => m.type === 'heartbeat', 3200);
    assert.equal(beat.protocol, 1);
    assert.equal(beat.clientId, clientId);
    assert.equal(beat.state, 'idle');
  });

  it('publish() maps the five known types onto state frames (table-driven)', async () => {
    const cases = [
      {
        name: 'agentState passes state fields through',
        payload: { type: 'agentState', state: 'thinking', detail: 'Analyzing', level: 'info', meta: { progress: 42 } },
        state: 'thinking',
        detail: 'Analyzing',
        level: 'info',
        progress: 42,
      },
      {
        name: 'agentState applies vendor defaults for missing fields',
        payload: { type: 'agentState' },
        state: 'idle',
        detail: '',
        level: 'info',
        progress: 0,
      },
      {
        name: 'assistant maps to done/Final response ready',
        payload: { type: 'assistant' },
        state: 'done',
        detail: 'Final response ready',
        level: 'success',
        progress: 100,
      },
      {
        name: 'stopped maps to waiting_output/Task stopped',
        payload: { type: 'stopped' },
        state: 'waiting_output',
        detail: 'Task stopped',
        level: 'warn',
        progress: 0,
      },
      {
        name: 'error maps to failed with the given message',
        payload: { type: 'error', message: 'Boom happened' },
        state: 'failed',
        detail: 'Boom happened',
        level: 'error',
        progress: 100,
      },
    ];
    for (const c of cases) {
      bridge.publish(c.payload);
      const frame = await fake.udpCol.waitFor(
        (m) => m.type === 'state' && m.state === c.state && m.detail === c.detail,
      );
      assert.equal(frame.protocol, 1);
      assert.equal(frame.clientId, clientId);
      assert.equal(frame.level, c.level, c.name);
      assert.equal(frame.progress, c.progress, c.name);
    }
  });

  it('publish() ignores unknown / non-object payloads silently', async () => {
    bridge.publish({ type: 'nonsense' });
    bridge.publish(null);
    bridge.publish('a string');
    await fake.udpCol.assertNone((m) => m.type === 'state');
  });

  it('permissionRequestState pins the first pending request into envelope.permission', async () => {
    bridge.publish({
      type: 'permissionRequestState',
      requests: [
        { requestId: 'req-1', title: 'Run Bash', detail: 'npm test', description: 'wants to run tests', category: 'bash', approvalState: 'pending' },
        { requestId: 'req-2', title: 'Already decided', approvalState: 'approved' },
      ],
    });
    const frame = await fake.udpCol.waitFor((m) => m.type === 'state');
    assert.deepEqual(frame.permission, {
      requestId: 'req-1',
      title: 'Run Bash',
      detail: 'npm test',
      description: 'wants to run tests',
      category: 'bash',
      approvalState: 'pending',
    });

    // The pending permission rides on every subsequent envelope…
    bridge.publish({ type: 'agentState', state: 'stalled', detail: 'Waiting', level: 'warn', meta: {} });
    const stalled = await fake.udpCol.waitFor((m) => m.type === 'state' && m.state === 'stalled');
    assert.equal(stalled.permission.requestId, 'req-1');
  });

  it('permission_decision round-trips when valid and ignores invalid frames', async () => {
    bridge.setPermissionDecisionHandler((payload) => {
      decisions.push(payload);
    });

    sendDecision({ protocol: 1, type: 'permission_decision', clientId, requestId: 'req-1', decision: 'allow' });
    await eventually(() => decisions.length === 1);
    assert.deepEqual(decisions[0], { requestId: 'req-1', decision: 'allow' });

    // Wrong clientId / invalid decision / wrong requestId / wrong protocol
    // must all be ignored (vendor validation gate).
    sendDecision({ protocol: 1, type: 'permission_decision', clientId: 'other-client', requestId: 'req-1', decision: 'deny' });
    sendDecision({ protocol: 1, type: 'permission_decision', clientId, requestId: 'req-1', decision: 'maybe' });
    sendDecision({ protocol: 1, type: 'permission_decision', clientId, requestId: 'req-x', decision: 'deny' });
    sendDecision({ protocol: 2, type: 'permission_decision', clientId, requestId: 'req-1', decision: 'deny' });
    await short(250);
    assert.equal(decisions.length, 1);
  });

  it('permission_decision is ignored once nothing is pending', async () => {
    bridge.publish({ type: 'permissionRequestState', requests: [] });
    const cleared = await fake.udpCol.waitFor((m) => m.type === 'state');
    assert.equal(cleared.permission, null);

    sendDecision({ protocol: 1, type: 'permission_decision', clientId, requestId: 'req-1', decision: 'deny' });
    await short(250);
    assert.equal(decisions.length, 1); // unchanged
  });

  it('chat_send reaches the chat handler; emit() writes protocol-2 lines back', async () => {
    bridge.setChatRequestHandler((message, emit) => {
      chatRequests.push(message);
      emit({ type: 'chat_started', requestId: message.requestId });
    });

    sendChatLine({ protocol: 2, clientId, type: 'chat_send', requestId: 'r-9', mode: 'chat', text: 'hi' });
    await eventually(() => chatRequests.length === 1);
    assert.equal(chatRequests[0].type, 'chat_send');
    assert.equal(chatRequests[0].requestId, 'r-9');
    assert.equal(chatRequests[0].mode, 'chat');
    assert.equal(chatRequests[0].text, 'hi');
    assert.equal(chatRequests[0].protocol, 2);

    const ack = await fake.chatCol.waitFor((m) => m.type === 'chat_started');
    assert.equal(ack.protocol, 2);
    assert.equal(ack.clientId, clientId);
    assert.equal(ack.workspacePath, WORKSPACE);
    assert.equal(ack.requestId, 'r-9');
  });

  it('chat frames with an unsupported mode are rejected by the bridge itself', async () => {
    sendChatLine({ protocol: 2, clientId, type: 'chat_send', requestId: 'r-10', mode: 'agent', text: 'x' });
    const err = await fake.chatCol.waitFor((m) => m.type === 'chat_error');
    assert.equal(err.mode, 'agent');
    assert.equal(err.requestId, 'r-10');
    assert.match(err.error, /only supports Chat and Cat Box modes/i);
  });

  it('malformed / foreign chat lines are dropped without breaking the stream', async () => {
    fake.bridgeConn.write('this is not json\n');
    sendChatLine({ protocol: 2, clientId: 'nope', type: 'chat_send', requestId: 'r-12', mode: 'chat', text: 'x' });
    // A well-formed frame right after must still reach the handler.
    sendChatLine({ protocol: 2, clientId, type: 'chat_history_request', requestId: 'r-11', mode: 'chat' });
    await eventually(() => chatRequests.length === 2);
    assert.equal(chatRequests[1].type, 'chat_history_request');
    assert.equal(chatRequests[1].requestId, 'r-11');
  });

  it('disable() sends detach + chat_detach and mutes further sends', async () => {
    bridge.disable();

    const detach = await fake.udpCol.waitFor((m) => m.type === 'detach');
    assert.equal(detach.protocol, 1);
    assert.equal(detach.clientId, clientId);
    const chatDetach = await fake.chatCol.waitFor((m) => m.type === 'chat_detach');
    assert.equal(chatDetach.clientId, clientId);
    assert.equal(bridge.enabled, false);

    // After disable the vendor send gate passes only `detach`.
    bridge.publish({ type: 'agentState', state: 'thinking', detail: 'post-disable', level: 'info', meta: {} });
    await fake.udpCol.assertNone((m) => m.type === 'state' && m.detail === 'post-disable');

    // A second disable() is a no-op (no second detach).
    bridge.disable();
    await fake.udpCol.assertNone((m) => m.type === 'detach', 250);
  });
});
