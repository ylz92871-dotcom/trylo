// Trylo Desktop — InputRequestCard (M4-E, spec §6.7 Core
// "approval / input").
//
// Renders an inline structured user-input question set
// (`input_request`). The user picks options or supplies free text
// and submits — or dismisses — so a task paused
// waiting for input never just sits and times out.
//
// `onRespond(requestId, status, answers)` is wired to
// the conversation supervisor by the host. When no
// responder is provided the card renders read-only.
//
// The card keeps ONE stable identity (the requestId) so
// the resolved / dismissed follow-up events update the
// same card in place via the mapper.

import { useState, type ReactElement } from 'react';
import { Check, Minus } from 'lucide-react';
import type { InputRequestAnswer, InputRequestQuestion } from '../../host-adapter/input-request';
import type { InputRequestMessage } from './types';

export interface InputRequestCardProps {
  readonly message: InputRequestMessage;
  /** Routes the answer to the CLI process that owns this request. */
  readonly onRespond?: (
    requestId: string,
    status: 'submitted' | 'dismissed',
    answers?: Record<string, InputRequestAnswer>,
  ) => void | Promise<boolean>;
}

/** Sentinel radio value for the per-question "Other"
 *  free-text escape hatch (P2-4). Padded so a vendor option
 *  literally named "Other" can never collide with it. */
const OTHER_MARKER = '__other_free_text__';

function buildAnswers(
  questions: readonly InputRequestQuestion[],
  selected: ReadonlyMap<string, readonly string[]>,
  otherText: ReadonlyMap<string, string>,
): Record<string, InputRequestAnswer> {
  const out: Record<string, InputRequestAnswer> = Object.create(null);
  for (const q of questions) {
    const label = selected.get(q.id);
    if (q.options.length === 0) {
      const text = otherText.get(q.id)?.trim();
      if (text) out[q.id] = { otherText: text };
      continue;
    }
    if (!label?.length) continue;
    const labels = label.filter(value => value !== OTHER_MARKER);
    const text = label.includes(OTHER_MARKER) ? otherText.get(q.id)?.trim() : undefined;
    out[q.id] = { ...(q.multiSelect ? (labels.length ? { optionLabels: labels } : {})
      : labels[0] ? { optionLabel: labels[0] } : {}), ...(text ? { otherText: text } : {}) };
  }
  return out;
}

export function InputRequestCard(
  props: InputRequestCardProps,
): ReactElement {
  const m = props.message;
  const [selected, setSelected] = useState<ReadonlyMap<string, readonly string[]>>(
    () => new Map(),
  );
  const [otherText, setOtherText] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const choose = (question: InputRequestQuestion, value: string): void => {
    setSelected(previous => {
      const current = previous.get(question.id) ?? [];
      const next = question.multiSelect ? current.includes(value)
        ? current.filter(item => item !== value) : [...current, value] : [value];
      return new Map(previous).set(question.id, next);
    });
  };
  const resolved = m.status !== 'pending';
  const allAnswered =
    m.questions.length > 0 &&
    m.questions.every((q) => {
      if (q.options.length === 0) return (otherText.get(q.id) ?? '').trim().length > 0;
      const sel = selected.get(q.id);
      if (!sel?.length) return false;
      // "Other" only counts once non-empty free text is given.
      if (sel.includes(OTHER_MARKER)) return (otherText.get(q.id) ?? '').trim().length > 0;
      return true;
    });

  const submit = async (status: 'submitted' | 'dismissed'): Promise<void> => {
    if (!props.onRespond || resolved || submitting) return;
    if (status === 'submitted' && !allAnswered) return;
    setSubmitting(true);
    setError('');
    try {
      const delivered = await props.onRespond(
        m.requestId,
        status,
        status === 'submitted'
          ? buildAnswers(m.questions, selected, otherText)
          : undefined,
      );
      if (delivered === false) setError('回答尚未送达，请重试。');
    } catch {
      setError('回答发送失败，请重试。');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={`input-request-card${resolved ? ' input-request-card--resolved' : ''}`}>
      {resolved && <div className="input-request-card__head">
        {m.status === 'submitted' ? <Check size={14} aria-hidden="true" />
          : m.status === 'dismissed' ? <Minus size={14} aria-hidden="true" />
            : null}
        <span className="input-request-card__title">
          {m.status === 'submitted'
            ? '已回答'
            : m.status === 'dismissed'
              ? '已跳过'
              : '需要你的回答'}
        </span>
        {m.questions.length > 1 ? <span className="input-request-card__state">{m.questions.length} 个问题</span> : null}
      </div>}
      {m.status === 'submitted' && m.answers ? (
        <ul className="input-request-card__answers">
          {m.questions.map((q) => {
            const a = m.answers?.[q.id];
            return (
              <li key={q.id} className="input-request-card__answer">
                <span className="input-request-card__answer-q">{q.question}</span>
                <span className="input-request-card__answer-v">
                  {[...(a?.optionLabels ?? (a?.optionLabel ? [a.optionLabel] : [])), ...(a?.otherText ? [a.otherText] : [])].join(', ') || '—'}
                </span>
              </li>
            );
          })}
        </ul>
      ) : m.status === 'submitted' || m.status === 'dismissed' ? (
        <p className="input-request-card__resolved">
          {m.status === 'dismissed'
            ? '本次问题已跳过。'
            : '回答已提交。'}
        </p>
      ) : (
        <>
          <ul className="input-request-card__questions">
            {m.questions.map((q) => (
              <li key={q.id} className="input-request-card__question">
                <p className="input-request-card__question-text">{q.question}</p>
                {q.options.length > 0 ? (
                  <div className="input-request-card__options" role={q.multiSelect ? 'group' : 'radiogroup'} aria-label={q.question}>
                    {q.options.map((o) => (
                      <label key={o.label} className="input-request-card__option"
                        data-selected={selected.get(q.id)?.includes(o.label) ?? false}>
                        <input
                          type={q.multiSelect ? 'checkbox' : 'radio'}
                          name={`ir-${m.requestId}-${q.id}`}
                          value={o.label}
                          checked={selected.get(q.id)?.includes(o.label) ?? false}
                          disabled={submitting || !props.onRespond}
                          onChange={() =>
                            choose(q, o.label)
                          }
                        />
                        <span className="input-request-card__option-label">
                          {o.label}
                        </span>
                        {o.description ? (
                          <span className="input-request-card__option-desc">
                            {o.description}
                          </span>
                        ) : null}
                      </label>
                    ))}
                    <label className="input-request-card__option"
                      data-selected={selected.get(q.id)?.includes(OTHER_MARKER) ?? false}>
                      <input
                        type={q.multiSelect ? 'checkbox' : 'radio'}
                        name={`ir-${m.requestId}-${q.id}`}
                        value={OTHER_MARKER}
                        checked={selected.get(q.id)?.includes(OTHER_MARKER) ?? false}
                        disabled={submitting || !props.onRespond}
                        onChange={() => {
                          choose(q, OTHER_MARKER);
                          const t = otherText.get(q.id) ?? '';
                          setOtherText((prev) =>
                            t.length === 0
                              ? new Map(prev).set(q.id, '')
                              : prev,
                          );
                        }}
                      />
                      <span className="input-request-card__option-label">
                        其他
                      </span>
                    </label>
                  </div>
                ) : (
                  null
                )}
                {q.options.length === 0 || selected.get(q.id)?.includes(OTHER_MARKER) ? (
                  <textarea
                    className="input-request-card__other"
                    aria-label={`${q.question} — 自定义回答`}
                    placeholder="输入你的想法…"
                    value={otherText.get(q.id) ?? ''}
                    disabled={submitting || !props.onRespond}
                    onChange={(e) =>
                      setOtherText((prev) =>
                        new Map(prev).set(q.id, e.target.value),
                      )
                    }
                  />
                ) : null}
              </li>
            ))}
          </ul>
          {error ? <p className="input-request-card__error" role="alert">{error}</p> : null}
          <div className="input-request-card__actions">
            <button
              type="button"
              className="input-request-card__btn input-request-card__btn--dismiss"
              onClick={() => submit('dismissed')}
              disabled={submitting || !props.onRespond}
            >
              跳过
            </button>
            <button
              type="button"
              className="input-request-card__btn input-request-card__btn--submit"
              onClick={() => submit('submitted')}
              disabled={submitting || !props.onRespond || !allAnswered}
            >
              {submitting ? '正在发送…' : '提交回答'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
