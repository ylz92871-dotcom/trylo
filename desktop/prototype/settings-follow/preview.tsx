import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsModal } from '../../src/components/app-shell/SettingsModal';
import { settingsDefaults } from '../../src/settings/settings-store';
import { MessageList } from '../../src/components/chat/MessageList';
import type { ChatMessage } from '../../src/components/chat/types';
import '../../src/styles/tokens.css';
import '../../src/styles/base.css';
import '../../src/styles/components/settings-modal.css';
import '../../src/styles/components/message-list.css';
import '../../src/styles/components/message.css';
import '../../src/styles/components/code-reasoning-transcript.css';
import '../../src/styles/components/event-flow.css';
import '../../src/styles/components/tool-card.css';
import '../../src/styles/components/disclosure.css';

const demo = { ...settingsDefaults, apiFormat: 'openai' as const, apiHost: 'https://api.example.test/v1', apiModel: 'example-model', apiKey: 'demo-key-not-a-credential' };
const history: ChatMessage[] = Array.from({ length: 30 }, (_, i) => ({ id: `history-${i}`, kind: 'text', role: i % 2 ? 'assistant' : 'user', createdAt: i, text: `第 ${i + 1} 条验证消息。${'这里是用于测试长对话滚动位置的示例内容。'.repeat(4)}` }));
function Preview(): JSX.Element {
 const scrollMode = new URLSearchParams(location.search).has('scroll');
 const [open, setOpen] = useState(!scrollMode);
 const [messages,setMessages] = useState<ChatMessage[]>([...history, { id:'live-user',kind:'text',role:'user',createdAt:100,text:'开始持续输出。' }, {id:'live-answer',kind:'text',role:'assistant',createdAt:101,turnId:'live-user',text:'正在整理结果。'}]);
 const [running,setRunning] = useState(false);
 useEffect(() => {
  if(!running) return;
  const timer=setInterval(()=>setMessages(prev=>prev.map(m=>m.id==='live-answer'&&m.kind==='text'?{...m,text:m.text+'\n\n新的输出到了。继续核对自动跟随与手动阅读。'}:m)),80);
  return()=>clearInterval(timer);
 },[running]);
 return <main style={{height:'100dvh', display:'flex',flexDirection:'column',overflow:'hidden'}}>
  <header style={{padding:12,display:'flex',gap:12,flexShrink:0}}>
    <button onClick={()=>setOpen(true)}>打开设置</button>
    <button onClick={()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';}}>切换主题</button>
    <button onClick={()=>setRunning(true)}>开始输出</button>
    <button onClick={()=>setRunning(false)}>结束输出</button>
    <span>独立预览 · 示例数据</span>
  </header>
  <MessageList messages={messages} running={running} surface="code" />
  <SettingsModal open={open} initialTab={new URLSearchParams(location.search).get('tab') === 'tools' ? 'tools' : undefined} initial={demo} onClose={()=>setOpen(false)} />
 </main>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
