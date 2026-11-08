import type { ReactElement } from 'react';
import { CircleAlert, Info } from 'lucide-react';

/** Legacy diagnostic prose stays intact; only its presentation is localized. */
export function RuntimeNotice({ text }: { readonly text: string }): ReactElement {
  const network = /^(?:SYSTEM\s*·\s*)?network\s*-\s*mid_stream:network\b/i.test(text.trim());
  const Icon = network ? CircleAlert : Info;
  return <div className="runtime-notice" data-tone={network ? 'error' : 'neutral'} role={network ? 'alert' : 'note'}>
    <Icon className="runtime-notice__icon" size={16} strokeWidth={1.7} aria-hidden="true" />
    <div className="runtime-notice__content">
      <strong>{network ? '模型连接中断' : '运行提示'}</strong>
      <p>{network ? '本轮输出未能完成。已经显示的内容会保留。' : text}</p>
      {network && <><p>如果本次运行已保存，可在原会话继续；继续前请核对未完成的操作。</p>
        <details><summary>诊断信息</summary><pre>{text}</pre></details></>}
    </div>
  </div>;
}
