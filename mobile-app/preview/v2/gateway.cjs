// Independent V2 design fixture: production Gateway + synthetic Desktop state.
// No model, shell command, filesystem scan or real approval is executed.
const { createRemoteGateway } = require('../../../desktop-services/vendor/legacy/remote-gateway/index.js');
const token = 'trylo-mobile-v2-preview-synthetic-20261015';
const records = new Map();
let active = 'connection-review';
let serial = 0;
const at = Date.now();
const initial = 'v2-initial';
records.set(active, {
  id: active, title: '远程连接与事件同步', surface: 'code', updatedAt: at,
  turnId: initial, status: 'waiting', stopped: false,
  conversation: [
    { id: `${initial}:user`, role: 'user', text: '检查手机端的远程连接，确认断线后能恢复当前会话。', at: at - 40000, turnId: initial, status: 'done' },
    { id: `${initial}:intro`, role: 'assistant', text: '我会先核对连接配置，再检查会话恢复。完成后把检查结果整理给你。', at: at - 38000, turnId: initial, status: 'done' },
    { id: `${initial}:thinking`, role: 'thinking', title: '核对会话恢复路径', text: '检查配对身份、连接恢复及待审批操作是否始终以电脑端状态为准。', at: at - 36000, turnId: initial, status: 'done' },
    { id: `${initial}:read`, role: 'tool', title: '读取连接配置', input: '{"path":"mobile-app/src/gateway.ts"}', output: '合成结果：读取到快照与一次性连接票据入口。', durationMs: 280, at: at - 34000, turnId: initial, toolCallId: `${initial}-read`, status: 'done', text: 'gateway.ts' },
    { id: `${initial}:check`, role: 'tool', title: '检查断线恢复', input: '{"command":"npm.cmd run check:connection","cwd":"mobile-app"}', at: at - 32000, turnId: initial, toolCallId: `${initial}-check`, status: 'streaming', text: '需要确认后继续' },
  ],
  approvals: [{ requestId: `${initial}:approval`, category: 'command', title: '检查断线恢复', detail: 'npm.cmd run check:connection', description: '在当前项目运行一次连接检查。此操作是合成预览，不会执行真实命令。' }],
});
records.set('work-report', {
  id: 'work-report', title: '整理远程工作台验收说明', surface: 'work', updatedAt: at - 3600000, status: 'done', turnId: 'report', approvals: [],
  conversation: [{ id: 'report:user', role: 'user', text: '把验收结果整理成一份说明。', status: 'done', at: at - 3601000 }, { id: 'report:assistant', role: 'assistant', text: '验收说明已整理，包括连接恢复、待审批操作和会话切换的检查记录。', status: 'done', at: at - 3600000 }],
});
records.set('desktop-layout', {
  id: 'desktop-layout', title: 'Desktop 侧栏布局', surface: 'code', updatedAt: at - 86400000, status: 'done', turnId: 'layout', approvals: [],
  conversation: [{ id: 'layout:user', role: 'user', text: '检查一下桌面侧栏的布局。', status: 'done', at: at - 86401000 }, { id: 'layout:assistant', role: 'assistant', text: '侧栏检查已完成。这里保留的是上一段会话的合成历史记录。', status: 'done', at: at - 86400000 }],
});
const sessionList = () => [...records.values()].sort((a,b) => b.updatedAt-a.updatedAt).map(({ id, title, surface, updatedAt, conversation }) => ({ id, title, surface, updatedAt, preview: conversation.at(-1)?.text || '', workspace: { id: 'trylo', name: 'Trylo' } }));
const save = () => { records.get(active).conversation = gateway.getSnapshot().conversation; };
const restore = () => {
  const record = records.get(active);
  gateway.publish({ type: 'sessionState', activeSessionId: active, sessions: sessionList(), conversation: record.conversation });
  gateway.publish({ type: 'agentState', state: record.status === 'done' ? 'idle' : record.status });
  gateway.publish({ type: 'permissionRequestState', requests: record.approvals });
  if (record.status === 'done') gateway.publish({ type: 'assistant' });
  if (record.stopped) gateway.publish({ type: 'stopped' });
};
const settle = allowed => {
  const record = records.get(active);
  record.approvals = [];
  gateway.publish({ type: 'permissionRequestState', requests: [] });
  if (allowed) {
    const call = [...record.conversation].reverse().find(item => item.role === 'tool' && item.status === 'streaming');
    if (call) gateway.publish({ type: 'trace', id: call.id, turnId: call.turnId, toolCallId: call.toolCallId, kind: 'tool', title: call.title, phase: 'completed', output: '合成检查结果：恢复后当前会话、工具结果与待审批状态一致。', durationMs: 1320 });
    gateway.publish({ type: 'turnFinished', turn: { id: record.turnId, resultText: '连接检查已完成。\n\n断线后能恢复当前会话，工具结果和审批状态保持一致。检查记录已整理为 connection-review.md，可在「结果」中查看。', completedAt: Date.now() } });
    gateway.publish({ type: 'assistant' }); record.status = 'done'; record.stopped = false;
  } else { gateway.publish({ type: 'stopped' }); record.status = 'idle'; record.stopped = true; }
  save();
  gateway.publish({ type: 'sessionState', activeSessionId: active, sessions: sessionList(), conversation: record.conversation });
};
const resultText = '# 远程连接检查记录\n\n这是第二版预览的合成文档。\n\n- 已核对当前会话身份\n- 已核对工具结果恢复\n- 已核对审批状态恢复\n\n真实手机、外网和完整 Desktop 逐块事件仍需后续验证。';
const gateway = createRemoteGateway({ port: 49424, host: '127.0.0.1', authToken: token, deviceName: '开发电脑', workspaceName: 'Trylo', handlers: {
  projects: async () => ({ activeProjectId: 'trylo', projects: [{ id: 'trylo', name: 'Trylo' }] }),
  session: async payload => {
    save();
    if (payload.create) {
      active = `session-${++serial}`;
      records.set(active, { id: active, title: '新会话', surface: payload.surface, updatedAt: Date.now(), status: 'idle', conversation: [], approvals: [] });
    } else {
      if (!records.has(payload.sessionId)) throw new Error('会话不存在');
      active = payload.sessionId;
    }
    restore(); return { accepted: true, sessionId: active, switching: false };
  },
  task: async payload => {
    const record = records.get(active);
    if (record.approvals.length) throw Object.assign(new Error('请先处理当前待确认操作。'), { statusCode: 409 });
    record.turnId = `v2-task-${++serial}`; record.status = 'running'; record.stopped = false; record.updatedAt = Date.now();
    const id = record.turnId;
    gateway.publish({ type: 'agentState', state: 'running' });
    gateway.publish({ type: 'turnStarted', turn: { id, prompt: payload.text, startedAt: record.updatedAt } });
    gateway.publish({ type: 'sessionState', activeSessionId: active, sessions: sessionList(), conversation: [...gateway.getSnapshot().conversation, { id: `${id}:intro`, role: 'assistant', text: '我会核对当前连接，并将结果整理在这段会话里。', at: Date.now(), turnId: id, status: 'done' }] });
    gateway.publish({ type: 'trace', id: `${id}:check`, turnId: id, toolCallId: `${id}-check`, kind: 'tool', title: '检查断线恢复', phase: 'running', input: '{"command":"npm.cmd run check:connection","cwd":"mobile-app"}' });
    record.approvals = [{ requestId: `${id}:approval`, category: 'command', title: '检查断线恢复', detail: 'npm.cmd run check:connection', description: '合成预览，只模拟本次确认，不执行真实命令。' }];
    gateway.publish({ type: 'permissionRequestState', requests: record.approvals });
    save(); return { accepted: true, requestId: payload.requestId };
  },
  permission: async payload => { settle(payload.decision === 'allow'); return { ok: true }; },
  cancel: async () => { settle(false); return { ok: true }; },
  artifacts: async () => ({ artifacts: records.get(active).status === 'done' ? [{ id: 'connection-review.md', name: 'connection-review.md', kind: 'document', size: Buffer.byteLength(resultText), modifiedAt: Date.now() }] : [] }),
  artifact: async () => ({ name: 'connection-review.md', mimeType: 'text/markdown', data: Buffer.from(resultText).toString('base64') }),
} });
gateway.start().then(() => {
  gateway.publish({ type: 'projectsState', activeProjectId: 'trylo', projects: [{ id: 'trylo', name: 'Trylo' }] });
  restore(); console.log('V2 synthetic Gateway: http://127.0.0.1:49424');
});
process.on('SIGINT', () => gateway.stop().then(() => process.exit(0)));
