const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const net = require('node:net');
const path = require('node:path');
const { createDesktopCompanionBridge } = require('./desktop-companion-bridge');

function waitFor(predicate, timeoutMs = 4000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error('Timed out waiting for desktop chat protocol event.'));
      setTimeout(poll, 20);
    };
    poll();
  });
}

async function main() {
  const received = [];
  const udpReceived = [];
  let clientSocket;
  let buffer = '';
  const server = net.createServer(socket => {
    clientSocket = socket;
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) received.push(JSON.parse(line));
      }
    });
  });
  const udpServer = dgram.createSocket('udp4');
  udpServer.on('message', body => {
    try {
      udpReceived.push(JSON.parse(body.toString('utf8')));
    } catch {}
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => udpServer.bind(0, '127.0.0.1', resolve));
  const chatPort = server.address().port;
  const companionPort = udpServer.address().port;
  const bridge = createDesktopCompanionBridge({
    extensionPath: path.join(__dirname, '__missing_companion__'),
    workspacePath: path.join(__dirname, 'desktop-chat-fixture'),
    companionPort,
    chatPort,
  });
  bridge.setChatRequestHandler(async (message, respond) => {
    if (message.mode === 'fun') {
      respond({ type: 'chat_started', requestId: message.requestId, mode: 'fun' });
      return;
    }
    assert.equal(message.mode, 'chat');
    respond({
      type: 'chat_history',
      messages: [{ role: 'assistant', text: 'desktop history', at: 1 }],
    });
  });

  try {
    bridge.enable();
    const hello = await waitFor(() => received.find(message => message.type === 'chat_hello'));
    assert.equal(hello.protocol, 2);
    assert.ok(hello.clientId);

    assert.equal(bridge.openChat(), true);
    const openRequest = await waitFor(() => udpReceived.find(message => message.type === 'open_chat'));
    assert.equal(openRequest.clientId, hello.clientId);
    assert.equal(openRequest.protocol, 1);

    clientSocket.write(`${JSON.stringify({
      protocol: 2,
      type: 'chat_history_request',
      clientId: hello.clientId,
      mode: 'chat',
    })}\n`);
    const history = await waitFor(() => received.find(message => message.type === 'chat_history'));
    assert.equal(history.messages[0].text, 'desktop history');

    clientSocket.write(`${JSON.stringify({
      protocol: 2,
      type: 'chat_send',
      clientId: hello.clientId,
      requestId: 'catbox-attempt',
      mode: 'fun',
      text: 'try cat box',
    })}\n`);
    const funStarted = await waitFor(() => received.find(message => message.requestId === 'catbox-attempt'));
    assert.equal(funStarted.type, 'chat_started');
    assert.equal(funStarted.mode, 'fun');

    clientSocket.write(`${JSON.stringify({
      protocol: 2,
      type: 'chat_send',
      clientId: hello.clientId,
      requestId: 'agent-attempt',
      mode: 'agent',
      text: 'try agent mode',
    })}\n`);
    const rejection = await waitFor(() => received.find(message => message.type === 'chat_error'));
    assert.equal(rejection.requestId, 'agent-attempt');
    assert.match(rejection.error, /only supports Chat and Cat Box modes/i);
    console.log('smoke-desktop-chat: PASS');
  } finally {
    bridge.disable();
    clientSocket?.destroy();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => udpServer.close(resolve));
  }
}

main().catch(error => {
  console.error('smoke-desktop-chat: FAIL');
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
