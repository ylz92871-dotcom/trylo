import { useState, type ReactElement } from 'react';
import type { EffectVerdict, PendingEffect } from '../../runtime/effect-reconciliation';

/**
 * 「上次操作没被证明」的核对卡片。
 *
 * 未确认操作保留为历史事实，用户可以继续对话、检查结果或改变要求。
 * 这张卡片提供可选的结果记录入口，不充当继续对话的门槛。
 *
 * 判据留在人手里：这里是表单，不是开关；没有证据不能提交，判定一次只能记
 * 一个（引擎 append-only，第二个相反判定会被拒，拒绝原因原样显示）。
 */

export type EffectVerdictInput = {
  readonly key: string;
  readonly turn: string;
  readonly verdict: EffectVerdict;
  readonly evidence: string;
};

export type EffectReconcileCardProps = {
  readonly pending: ReadonlyArray<PendingEffect>;
  readonly onSettle: (input: EffectVerdictInput) => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
  /** 判定写回后回调，让宿主重新发起用户那条消息。 */
  readonly onSettled?: (input: EffectVerdictInput) => void;
};

function timeOf(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString('zh-CN', { hour12: false });
}

export function EffectReconcileCard(props: EffectReconcileCardProps): ReactElement {
  const [evidence, setEvidence] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [doneKeys, setDoneKeys] = useState<ReadonlyArray<string>>([]);
  const [error, setError] = useState<string | null>(null);

  const open = props.pending.filter((effect) => !doneKeys.includes(effect.key));
  const canSubmit = evidence.trim().length > 0 && busyKey === null;

  async function settle(effect: PendingEffect, verdict: EffectVerdict): Promise<void> {
    if (!canSubmit || effect.turn === undefined) return;
    const input = { key: effect.key, turn: effect.turn, verdict, evidence: evidence.trim() };
    setBusyKey(effect.key);
    setError(null);
    try {
      const result = await props.onSettle(input);
      if (result.ok) {
        setDoneKeys((keys) => [...keys, effect.key]);
        setEvidence('');
        props.onSettled?.(input);
      } else {
        setError(result.reason);
      }
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="effect-reconcile" role="note" data-tone={open.length === 0 ? 'done' : 'attention'}>
      <p className="effect-reconcile__title">
        {open.length === 0 ? '已记录核对结果' : '上次操作的结果没有被记录'}
      </p>
      <p className="effect-reconcile__body">
        {open.length === 0
          ? '判定已写入会话，可以继续。'
          : '你可以继续对话、检查结果或改变要求。系统不会自动重放这些操作；查明结果后，也可以在这里记录。'}
      </p>

      {open.map((effect) => (
        <div className="effect-reconcile__item" key={effect.key}>
          <p className="effect-reconcile__what">
            {effect.tool === undefined ? '一步已发出的操作' : effect.tool}
            <span className="effect-reconcile__when"> · {timeOf(effect.issuedAt)}</span>
          </p>
          {effect.arguments !== undefined && (
            <pre className="effect-reconcile__args">{JSON.stringify(effect.arguments, null, 2)}</pre>
          )}
          {effect.turn === undefined ? (
            <p className="effect-reconcile__blocked">这条记录缺少轮次信息，无法在应用内核对。</p>
          ) : (
            <div className="effect-reconcile__actions">
              <button type="button" disabled={!canSubmit} onClick={() => void settle(effect, 'committed')}>
                已经做了
              </button>
              <button type="button" disabled={!canSubmit} onClick={() => void settle(effect, 'failed')}>
                没有做成
              </button>
            </div>
          )}
        </div>
      ))}

      {open.length > 0 && (
        <label className="effect-reconcile__evidence">
          你查到了什么
          <input
            value={evidence}
            onChange={(event) => setEvidence(event.target.value)}
            placeholder="例如：输出目录里没有生成的 PDF"
            disabled={busyKey !== null}
          />
        </label>
      )}

      {error !== null && (
        <p className="effect-reconcile__error" role="alert">
          判定没有写入：{error}
        </p>
      )}
    </div>
  );
}
