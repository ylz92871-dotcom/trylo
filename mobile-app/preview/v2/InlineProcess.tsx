import type { RemoteChatMessage } from '../../src/gateway';
import { Icon } from './icons';

function pretty(value: string) {
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
}

/** The same authoritative message used by the compact view, rendered in place. */
export default function InlineProcess({ message, open, onOpen }: {
  message: RemoteChatMessage;
  open: boolean;
  onOpen: (open: boolean) => void;
}) {
  const thinking = message.role === 'thinking';
  const status = message.status || 'done';
  const label = status === 'streaming' ? '进行中' : status === 'error' ? '失败' : status === 'interrupted' ? '已中断' : '已完成';
  const icon = status === 'error' ? 'close' : status === 'interrupted' ? 'stop' : status === 'streaming' ? 'clock' : 'check';
  let target = '';
  try { const input = JSON.parse(message.input || '{}'); target = String(input.path || input.file_path || input.command || ''); } catch { /* Unstructured inputs are shown in the body. */ }
  return <details className={`v2-inline-event${thinking ? ' is-thinking' : ''} state-${status}`} open={open} onToggle={event => onOpen(event.currentTarget.open)}>
    <summary><span className="v2-inline-kind"><Icon name={thinking ? 'activity' : /command|bash|shell|检查/i.test(message.title || '') ? 'terminal' : 'file'} size={17}/></span><span className="v2-inline-title"><strong>{message.title || (thinking ? '思考摘要' : '工具操作')}</strong>{target && <small>{target}</small>}</span><span className="v2-inline-status">{!thinking && <Icon name={icon} size={12}/>} {thinking ? '思考摘要' : label}</span><Icon name="chevron" size={13}/></summary>
    <div className="v2-inline-body">
      {thinking ? <p>{message.text || '电脑未提供思考摘要。'}</p> : <>
        {message.input !== undefined && <><h3>输入</h3><pre>{pretty(message.input)}</pre></>}
        {message.output !== undefined && <><h3>{status === 'error' ? '错误' : '结果'}</h3><pre>{message.output || '无文本输出'}</pre></>}
        {message.output === undefined && <p>{message.text || (status === 'streaming' ? '等待电脑返回结果。' : '电脑未提供文本结果。')}</p>}
        {message.durationMs != null && <small>耗时 {(message.durationMs / 1000).toFixed(2)} 秒</small>}
      </>}
    </div>
  </details>;
}
