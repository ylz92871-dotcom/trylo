import { useEffect, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Channel, invoke } from '@tauri-apps/api/core';
import type { CompanionDisplay } from './companion/macos-companion-port';
import './companion/macos-companion.css';

const labels: Record<CompanionDisplay, string> = {
  idle: '可以开始新任务',
  running: '任务进行中',
  waiting: '等待审批',
  done: '任务已完成',
  failed: '任务发生错误',
  stopped: '任务已停止',
};

function MacosCompanion(): ReactElement {
  const [display, setDisplay] = useState<CompanionDisplay>('idle');
  const [failure, setFailure] = useState('');
  useEffect(() => {
    let active = true;
    const onDisplay = new Channel<CompanionDisplay>();
    onDisplay.onmessage = value => { if (active) setDisplay(value); };
    void invoke('macos_companion_subscribe', { onDisplay }).catch(() => {
      if (active) setFailure('暂时无法读取任务状态');
    });
    return () => { active = false; };
  }, []);

  return <main className="companion-window">
    <img src="/logo/trylo-app-icon-1024.png" width="44" height="44" alt="" />
    <div className="companion-window__status">
      <strong>Trylo 桌面伙伴</strong>
      <span role="status">{failure || labels[display]}</span>
    </div>
    <button type="button" onClick={() => {
      void invoke('macos_companion_return').catch(() => setFailure('暂时无法打开主窗口'));
    }}>打开 Trylo</button>
  </main>;
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<MacosCompanion />);
