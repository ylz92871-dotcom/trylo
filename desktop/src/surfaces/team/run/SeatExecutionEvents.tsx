import type { ReactElement } from 'react';
import { Check, ChevronRight, Circle, Play } from 'lucide-react';
import type { SeatActivityItem } from '../team-types';
import { timeLabel } from './team-presentation';

export function SeatExecutionEvents({ activity }: { readonly activity: readonly SeatActivityItem[] }): ReactElement {
  return <div className="team-execution-events">{activity.map(item => <details key={item.id}
    className={`tool tool--event ${item.kind === 'tool' ? 'tool--running' : item.ok === false ? 'tool--error' : 'tool--done'}`}>
    <summary className="tool__head"><span className="tool__icon">{item.kind === 'tool' ? <Play size={14} /> : item.ok === false ? <Circle size={14} /> : <Check size={14} />}</span>
      <span className="tool__name">{item.label}</span><span className="tool__time">{item.kind === 'tool' ? '执行中' : item.ok === false ? '失败' : '已返回'}</span><span className="tool__chevron"><ChevronRight size={12} /></span></summary>
    <div className="tool__body"><p>{item.kind === 'tool' ? '正在执行，尚未收到工具结果。' : item.ok === false ? '工具返回失败状态。' : '工具已返回成功状态。'}</p><time>{timeLabel(item.at)}</time></div>
  </details>)}</div>;
}
