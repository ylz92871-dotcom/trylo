// Local preview only. Real Gateway transport, synthetic Desktop authority.
// No model, shell command, real permission, or external service is invoked.
const { createRemoteGateway } = require('../../desktop-services/vendor/legacy/remote-gateway/index.js');
const TOKEN = 'trylo-mobile-preview-synthetic-only-20261015';
let active = 'preview-code';
let turn = '';
let counter = 0;
let timers = [];
const histories = new Map();
const sessions = [{ id: active, title: '手机远程连接与事件同步', surface: 'code', updatedAt: Date.now() }];
const clear = () => { timers.forEach(clearTimeout); timers = []; };
const later = (ms, fn) => timers.push(setTimeout(fn, ms));
const publishSession = () => gateway.publish({ type: 'sessionState', activeSessionId: active, sessions, conversation: histories.get(active) || [] });
const finish = allowed => {
  clear();
  gateway.publish({ type: 'permissionRequestState', requests: [] });
  if (allowed) {
    gateway.publish({ type: 'trace', id: `${turn}:check`, turnId: turn, toolCallId: 'check', kind: 'tool', title: '运行连接检查', phase: 'completed', output: '预览数据：连接检查完成。此处没有执行真实命令。', durationMs: 1430 });
    gateway.publish({ type: 'turnFinished', turn: { id: turn, resultText: '连接检查已完成。\n\n手机已恢复当前会话，工具结果与审批状态保持同步。你可以继续发送任务，或查看本次操作的详细记录。', completedAt: Date.now() } });
    gateway.publish({ type: 'assistant' });
  } else gateway.publish({ type: 'stopped' });
  histories.set(active, gateway.getSnapshot().conversation);
};
const task = text => {
  clear(); turn = `preview-${++counter}`;
  const at = Date.now();
  gateway.publish({ type: 'agentState', state: 'running' });
  gateway.publish({ type: 'turnStarted', turn: { id: turn, prompt: text, startedAt: at } });
  // A completed commentary block is distinct from the final answer, as in
  // Desktop history. Keep its identity instead of overwriting it at completion.
  gateway.publish({ type: 'sessionState', activeSessionId: active, sessions, conversation: [
    ...gateway.getSnapshot().conversation,
    { id: `${turn}:intro`, role: 'assistant', text: '我先检查远程连接，再核对当前会话的事件是否完整。', at, turnId: turn, status: 'done' },
  ] });
  later(450, () => gateway.publish({ type: 'turnEvent', turnId: turn, event: { category: 'reasoning', title: '核对连接与会话', detail: '以电脑端当前会话为准，检查断线后内容、工具结果和待审批操作能否恢复。', status: 'done' } }));
  later(850, () => gateway.publish({ type: 'trace', id: `${turn}:read`, turnId: turn, toolCallId: 'read', kind: 'tool', title: '读取连接配置', input: '{"path":"mobile-app/src/gateway.ts"}', phase: 'running' }));
  later(1250, () => gateway.publish({ type: 'trace', id: `${turn}:read`, turnId: turn, toolCallId: 'read', kind: 'tool', title: '读取连接配置', output: '预览数据：会话使用电脑端统一事件流，配对信息存放在安全存储中。', phase: 'completed', durationMs: 390 }));
  later(1600, () => {
    gateway.publish({ type: 'trace', id: `${turn}:check`, turnId: turn, toolCallId: 'check', kind: 'tool', title: '运行连接检查', input: '{"command":"npm.cmd run check:connection","cwd":"mobile-app"}', phase: 'running' });
    gateway.publish({ type: 'permissionRequestState', requests: [{ requestId: 'preview-permission', category: 'command', title: '运行连接检查', detail: 'npm.cmd run check:connection', description: '允许在电脑上运行这一次检查。此预览使用合成请求，不会执行命令。' }] });
    histories.set(active, gateway.getSnapshot().conversation);
  });
};
const gateway = createRemoteGateway({ port: 49414, host: '127.0.0.1', authToken: TOKEN, deviceName: '本机验收电脑', workspaceName: 'Trylo', handlers: {
  projects: async () => ({ activeProjectId: 'trylo', projects: [{ id: 'trylo', name: 'Trylo' }] }),
  task: async payload => { task(payload.text); return { accepted: true, requestId: payload.requestId }; },
  permission: async payload => { finish(payload.decision === 'allow'); return { ok: true }; },
  cancel: async () => { finish(false); return { ok: true }; },
  session: async payload => {
    clear(); histories.set(active, gateway.getSnapshot().conversation);
    gateway.publish({ type: 'permissionRequestState', requests: [] });
    if (payload.create) {
      active = `preview-${payload.surface}-${++counter}`;
      sessions.unshift({ id: active, title: '新会话', surface: payload.surface, updatedAt: Date.now() });
      histories.set(active, []);
    } else active = payload.sessionId;
    publishSession(); return { accepted: true, sessionId: active, switching: false };
  },
} });
gateway.start().then(() => {
  gateway.publish({ type: 'projectsState', activeProjectId: 'trylo', projects: [{ id: 'trylo', name: 'Trylo' }] });
  publishSession(); task('检查手机端远程连接，并整理事件展示。');
  console.log('Synthetic preview gateway listening on 127.0.0.1:49414');
});
process.on('SIGINT', () => { clear(); gateway.stop().then(() => process.exit(0)); });
