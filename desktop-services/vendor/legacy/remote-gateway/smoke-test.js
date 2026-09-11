const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { WebSocket } = require('ws');
const { createRemoteGateway } = require('./index');

async function main() {
  const token = crypto.randomBytes(32).toString('base64url');
  let remoteTask = null;
  let remoteFunMessage = null;
  let selectedProjectId = null;
  let handoffRequested = false;
  const gateway = createRemoteGateway({
    port: 49389,
    authToken: token,
    workspaceName: 'Gateway smoke test',
    handlers: {
      task: async payload => { remoteTask = payload; },
      fun: async (payload, emit) => {
        if (payload.type === 'fun_state_request') {
          return {
            characters: [{ id: 'guide', name: 'Guide', avatar: '✦', accent: '#dcc97e', intro: 'Demo', opening: 'Hello' }],
            histories: { guide: [] },
          };
        }
        if (payload.type === 'chat_history_request') return { characterId: payload.charId, messages: [] };
        if (payload.type === 'fun_memory_request') return { characterId: payload.charId, memories: { facts: [], impression: '' } };
        if (payload.type === 'chat_send') {
          remoteFunMessage = payload;
          emit({ type: 'chat_started', requestId: payload.requestId, characterId: payload.charId });
          emit({ type: 'chat_complete', requestId: payload.requestId, characterId: payload.charId, text: 'Hello from Cat Box' });
        }
        return { ok: true };
      },
      projects: async () => ({
        projects: [
          { id: 'project-main', name: 'Main board', lastSeenAt: Date.now() },
          { id: 'project-next', name: 'Next project', lastSeenAt: Date.now() - 1000 },
        ],
        activeProjectId: 'project-main',
      }),
      project: async payload => { selectedProjectId = payload.projectId; },
      handoff: async () => {
        handoffRequested = true;
        return { releasing: true };
      },
    },
  });

  await gateway.start();
  try {
    const health = await fetch('http://127.0.0.1:49389/health').then(response => response.json());
    assert.equal(health.ok, true);

    const unauthorized = await fetch('http://127.0.0.1:49389/v1/snapshot');
    assert.equal(unauthorized.status, 401);

    gateway.publish({ type: 'modeState', mode: 'plan', at: Date.now() });
    gateway.publish({ type: 'agentState', state: 'writing_files', detail: 'Writing gateway files', at: Date.now() });
    const writingProgress = gateway.getSnapshot().agent.progress;
    assert.ok(writingProgress >= 38 && writingProgress < 100);
    gateway.publish({ type: 'trace', title: 'Assistant message detail', detail: 'internal diagnostic', at: Date.now() });
    gateway.publish({ type: 'trace', title: 'Editing mobile interface', detail: 'Updating task view', kind: 'tool', at: Date.now() });
    const snapshot = await fetch('http://127.0.0.1:49389/v1/snapshot', {
      headers: { Authorization: `Bearer ${token}` },
    }).then(response => response.json());
    assert.equal(snapshot.agent.status, 'running');
    assert.equal(snapshot.agent.mode, 'plan');
    assert.equal(snapshot.agent.timeline.length, 1);
    assert.equal(snapshot.agent.technicalEventCount, 1);
    assert.ok(snapshot.agent.progress > writingProgress);
    assert.ok(snapshot.agent.progress < 100);
    assert.equal(snapshot.device.workspace, 'Gateway smoke test');

    const longThinking = '思考内容'.repeat(1400);
    gateway.publish({ type: 'ideStreamThinking', turnId: 'turn-long', delta: longThinking, at: Date.now() });
    const unboundedThinking = gateway.getSnapshot().conversation.find(item => item.id === 'turn-long:thinking-live');
    assert.equal(unboundedThinking.text, longThinking);
    assert.ok(unboundedThinking.text.length > 4000);
    assert.ok(Number.isInteger(gateway.getSnapshot().agent.progress));

    const fullApprovalDetail = 'npm.cmd run build '.repeat(80);
    gateway.publish({
      type: 'permissionRequestState',
      requests: [{
        requestId: 'approval-full',
        category: 'command',
        title: 'Run complete build',
        detail: fullApprovalDetail,
        description: 'Full approval explanation',
        toolName: 'shell_command',
        blockedPath: '[workspace]/mobile-app',
      }],
    });
    const approvalSnapshot = gateway.getSnapshot().approvals[0];
    assert.equal(approvalSnapshot.detail, fullApprovalDetail);
    assert.equal(approvalSnapshot.description, 'Full approval explanation');

    const projectState = await fetch('http://127.0.0.1:49389/v1/projects', {
      headers: { Authorization: `Bearer ${token}` },
    }).then(response => response.json());
    assert.equal(projectState.projects.length, 2);
    assert.equal(projectState.activeProjectId, 'project-main');
    const switchResponse = await fetch('http://127.0.0.1:49389/v1/projects/project-next/select', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(switchResponse.status, 202);
    assert.equal(selectedProjectId, 'project-next');

    const handoffResponse = await fetch('http://127.0.0.1:49389/v1/admin/handoff', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(handoffResponse.status, 202);
    assert.equal(handoffRequested, true);

    const turnAt = Date.now();
    gateway.publish({ type: 'turnStarted', turn: { id: 'turn-1', prompt: 'Mirror this task', mode: 'plan', startedAt: turnAt }, at: turnAt });
    gateway.publish({ type: 'turnEvent', turnId: 'turn-1', event: { id: 'reason-1', kind: 'reasoning', category: 'reasoning', title: 'Checking the request', detail: 'Compare the current session and mobile view.', status: 'running', at: turnAt + 1 }, at: turnAt + 1 });
    gateway.publish({ type: 'ideStreamText', turnId: 'turn-1', delta: 'Streaming reply', at: turnAt + 2 });
    const liveConversation = gateway.getSnapshot().conversation;
    assert.deepEqual(liveConversation.slice(-3).map(item => item.role), ['user', 'thinking', 'assistant']);
    assert.equal(liveConversation[liveConversation.length - 2].status, 'streaming');

    const remoteResponse = await fetch('http://127.0.0.1:49389/v1/chat/messages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Continue from mobile' }),
    });
    assert.equal(remoteResponse.status, 202);
    assert.equal(remoteTask.text, 'Continue from mobile');
    assert.equal(remoteTask.mode, 'plan');

    const funStateResponse = await fetch('http://127.0.0.1:49389/v1/fun', {
      headers: { Authorization: `Bearer ${token}` },
    }).then(response => response.json());
    assert.equal(funStateResponse.characters[0].id, 'guide');
    const funMessageResponse = await fetch('http://127.0.0.1:49389/v1/fun/guide/messages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello Cat Box', thinkMode: true }),
    });
    assert.equal(funMessageResponse.status, 202);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(remoteFunMessage.charId, 'guide');
    assert.equal(remoteFunMessage.text, 'Hello Cat Box');
    assert.equal(remoteFunMessage.thinkMode, true);

    gateway.publish({ type: 'assistant', mode: 'plan', text: 'The mobile interface is ready.', at: Date.now() });
    const completedSnapshot = gateway.getSnapshot();
    assert.equal(completedSnapshot.agent.status, 'done');
    assert.equal(completedSnapshot.agent.finalResponse.text, 'The mobile interface is ready.');

    gateway.publish({ type: 'configuration', apiKey: 'must-not-cross-remote-boundary' });
    const sanitizedSnapshot = gateway.getSnapshot();
    assert.equal(Object.prototype.hasOwnProperty.call(sanitizedSnapshot, 'apiKey'), false);

    const ticketResponse = await fetch('http://127.0.0.1:49389/v1/socket-ticket', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }).then(response => response.json());
    assert.ok(ticketResponse.ticket);

    const firstMessage = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:49389/v1/events?ticket=${ticketResponse.ticket}`);
      socket.once('message', data => {
        resolve(JSON.parse(data.toString('utf8')));
        socket.close();
      });
      socket.once('error', reject);
    });
    assert.equal(firstMessage.type, 'snapshot');
    assert.equal(firstMessage.snapshot.agent.status, 'done');
    assert.equal(firstMessage.snapshot.agent.finalResponse.text, 'The mobile interface is ready.');

    console.log('remote-gateway smoke test passed');
  } finally {
    await gateway.stop();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
