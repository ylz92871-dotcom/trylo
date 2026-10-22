import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentConversationSurface } from '../../src/components/chat/AgentConversationSurface';
import { InputBar } from '../../src/components/chat/InputBar';
import { TryloV1EventAdapter } from '../../src/host-adapter/trylo-v1-event-adapter';
import { applyEvents } from '../../src/components/chat/events';
import type { ChatMessage } from '../../src/components/chat/types';
import '../../src/styles/tokens.css';
import '../../src/styles/base.css';
import '../../src/styles/components/chat-panel.css';
import '../../src/styles/components/message-list.css';
import '../../src/styles/components/message.css';
import '../../src/styles/components/code-reasoning-transcript.css';
import '../../src/styles/components/event-flow.css';
import '../../src/styles/components/tool-card.css';
import '../../src/styles/components/disclosure.css';
import '../../src/styles/components/input-bar.css';
import '../../src/styles/components/process-header.css';
import './preview.css';

const params = new URLSearchParams(location.search);
const makeMessages = (failure = false): ChatMessage[] => {
  const adapter = new TryloV1EventAdapter();
  let messages: ChatMessage[] = [{ id: 'u', kind: 'text', role: 'user', createdAt: 1, text: '把 API 设置和自动跟随一起修好。' }];
  for (const frame of [
    { type: 'message_start' }, { type: 'message_delta', text: '连接问题已定位，正在修复滚动跟随。完成后一起验证。' }, { type: 'message_end' },
    { type: 'subagent', kind: 'spawn', id: 'connection', status: 'running', agentType: '连接排查', prompt: '检查模型连接保存后，当前会话实际使用哪份配置。保留完整排查结论。', canReceiveInput: true },
    { type: 'subagent', kind: 'spawn', id: 'scroll', status: 'running', agentType: '滚动修复', prompt: '修复持续输出时的滚动体验：阅读历史时保持位置，回到底部后恢复跟随。', canReceiveInput: true },
    { type: 'subagent', kind: 'spawn', id: 'verification', status: 'running', agentType: '回归验证', prompt: '验证模型连接保存、连续发送，以及手动翻阅和恢复跟随。保留失败记录。', canReceiveInput: true },
    { type: 'subagent', kind: 'spawn', id: 'permissions', status: 'running', agentType: '权限检查', prompt: '检查当前工具的授权范围。', canReceiveInput: true },
    { type: 'subagent', kind: 'spawn', id: 'report', status: 'running', agentType: '结果整理', prompt: '汇总各成员的结论。', canReceiveInput: true },
    { type: 'subagent', kind: 'update', id: 'connection', status: 'waiting', round: 1,
      result: '连接可以保存，但当前会话仍引用旧配置。\n\n保存逻辑与会话选择是两条链路。建议让保存动作同步更新当前会话的连接选择，并检查连续发送与重新打开设置的情况。' },
    ...(failure ? [{ type: 'subagent', kind: 'end', id: 'verification', status: 'failed', error: '模型服务请求超时，未产生验证结论。其他成员的答复已保留。' }] : []),
  ]) messages = applyEvents(messages, adapter.feed(JSON.stringify(frame)));
  return messages;
};
function Preview() {
  const [failed, setFailed] = useState(params.get('view') === 'error');
  const [messages, setMessages] = useState(() => makeMessages(failed));
  const [running, setRunning] = useState(true);
  const [text, setText] = useState('');
  return <main className="integration-preview">
    <header><h1>模型连接与滚动体验</h1><div><span>生产组件 · 示例事件</span><button onClick={() => {
      document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    }}>切换主题</button><button onClick={() => { setFailed(!failed); setMessages(makeMessages(!failed)); }}>切换失败状态</button><button onClick={() => setRunning(true)}>重新运行示例</button></div></header>
    <AgentConversationSurface surface="code" messages={messages} running={running} emptyState={null}
      onSubagentInput={async () => { throw new Error('本页为示例事件；在 Desktop 的实际运行中发送补充要求。'); }}
      composer={<InputBar codeMode="agent" onCodeModeChange={() => {}} running={running} messages={messages}
        text={text} onTextChange={setText} onSend={value => { setMessages(current => [...current, { id: `user-${Date.now()}`, kind: 'text', role: 'user', createdAt: Date.now(), text: value }]); setText(''); }}
        onStop={() => setRunning(false)} contextUsed={0} contextWindow={200000} model="示例模型" compacting={false}
        attachments={[]} onAddAttachment={() => {}} onRemoveAttachment={() => {}} onCompact={() => {}}
        activeProcessId={null} permissionLevel="workspace_write" onPermissionLevelChange={() => {}} />} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
