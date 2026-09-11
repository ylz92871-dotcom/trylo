// Trylo Desktop — InputRequestCard (M4-E, spec §6.7 Core
// "approval / input").
//
// Renders an inline structured user-input question set
// (`input_request_created`). The user picks one option per
// question and submits — or dismisses — so a task paused
// waiting for input never just sits and times out.
//
// `onRespond(requestId, status, answers)` is wired to
// `WorkRuntime.respondInputRequest` by the host. When no
// responder is provided the card renders read-only.
//
// The card keeps ONE stable identity (the requestId) so
// the resolved / dismissed follow-up events update the
// same card in place via the mapper.

import { useState, type ReactElement } from 'react';
import { ClipboardList } from 'lucide-react';
import type { InputRequestAnswer, InputRequestQuestion } from '@trylo/work';
import type { InputRequestMessage } from './types';

export interface InputRequestCardProps {
  readonly message: InputRequestMessage;
  /** Wired to WorkRuntime.respondInputRequest by the host. */
  readonly onRespond?: (
    requestId: string,
    status: 'submitted' | 'dismissed',
    answers?: Record<string, InputRequestAnswer>,
  ) => void;
}

/** Sentinel radio value for the per-question "Other"
 *  free-text escape hatch (P2-4). Padded so a vendor option
 *  literally named "Other" can never collide with it. */
const OTHER_MARKER = '__other_free_text__';

function buildAnswers(
  questions: readonly InputRequestQuestion[],
  selected: ReadonlyMap<string, string>,
  otherText: ReadonlyMap<string, string>,
): Record<string, InputRequestAnswer> {
  const out: Record<string, InputRequestAnswer> = {};
  for (const q of questions) {
    const label = selected.get(q.id);
    if (label === undefined) continue;
    if (label === OTHER_MARKER) {
      const text = otherText.get(q.id);
      if (text !== undefined && text.trim().length > 0) {
        out[q.id] = { otherText: text };
      }
    } else {
      out[q.id] = { optionLabel: label };
    }
  }
  return out;
}

export function InputRequestCard(
  props: InputRequestCardProps,
): ReactElement {
  const m = props.message;
  const [selected, setSelected] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const [otherText, setOtherText] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  const [submitting, setSubmitting] = useState(false);
  const resolved = m.status !== 'pending';
  const allAnswered =
    m.questions.length > 0 &&
    m.questions.every((q) => {
      const sel = selected.get(q.id);
      if (sel === undefined) return false;
      // "Other" only counts once non-empty free text is given.
      if (sel === OTHER_MARKER) return (otherText.get(q.id) ?? '').trim().length > 0;
      return true;
    });

  const submit = (status: 'submitted' | 'dismissed'): void => {
    if (!props.onRespond || resolved || submitting) return;
    if (status === 'submitted' && !allAnswered) return;
    setSubmitting(true);
    try {
      props.onRespond(
        m.requestId,
        status,
        status === 'submitted'
          ? buildAnswers(m.questions, selected, otherText)
          : undefined,
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="input-request-card">
      <div className="input-request-card__head">
        <ClipboardList size={15} strokeWidth={2} aria-hidden="true" />
        <span className="input-request-card__title">Input needed</span>
        <span className="input-request-card__state">
          {m.status === 'submitted'
            ? 'Submitted'
            : m.status === 'dismissed'
              ? 'Dismissed'
              : 'Pending'}
        </span>
      </div>
      {m.status === 'submitted' && m.answers ? (
        <ul className="input-request-card__answers">
          {m.questions.map((q) => {
            const a = m.answers?.[q.id];
            return (
              <li key={q.id} className="input-request-card__answer">
                <span className="input-request-card__answer-q">{q.question}</span>
                <span className="input-request-card__answer-v">
                  {a?.optionLabel ?? a?.otherText ?? '—'}
                </span>
              </li>
            );
          })}
        </ul>
      ) : m.status === 'submitted' || m.status === 'dismissed' ? (
        <p className="input-request-card__resolved">
          {m.status === 'dismissed'
            ? 'Request dismissed — the task continued with the current progress.'
            : 'Answers submitted to the task.'}
        </p>
      ) : (
        <>
          <ul className="input-request-card__questions">
            {m.questions.map((q) => (
              <li key={q.id} className="input-request-card__question">
                <p className="input-request-card__question-text">{q.question}</p>
                {q.options.length > 0 ? (
                  <div className="input-request-card__options" role="radiogroup" aria-label={q.question}>
                    {q.options.map((o) => (
                      <label key={o.label} className="input-request-card__option">
                        <input
                          type="radio"
                          name={`ir-${m.requestId}-${q.id}`}
                          value={o.label}
                          checked={selected.get(q.id) === o.label}
                          disabled={submitting || !props.onRespond}
                          onChange={() =>
                            setSelected((prev) => new Map(prev).set(q.id, o.label))
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
                    <label className="input-request-card__option">
                      <input
                        type="radio"
                        name={`ir-${m.requestId}-${q.id}`}
                        value={OTHER_MARKER}
                        checked={selected.get(q.id) === OTHER_MARKER}
                        disabled={submitting || !props.onRespond}
                        onChange={() => {
                          setSelected((prev) =>
                            new Map(prev).set(q.id, OTHER_MARKER),
                          );
                          const t = otherText.get(q.id) ?? '';
                          setOtherText((prev) =>
                            t.length === 0
                              ? new Map(prev).set(q.id, '')
                              : prev,
                          );
                        }}
                      />
                      <span className="input-request-card__option-label">
                        Other
                      </span>
                    </label>
                  </div>
                ) : (
                  <p className="input-request-card__no-options">—</p>
                )}
                {selected.get(q.id) === OTHER_MARKER ? (
                  <textarea
                    className="input-request-card__other"
                    aria-label={`${q.question} — other`}
                    placeholder="Type a custom answer…"
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
          <div className="input-request-card__actions">
            <button
              type="button"
              className="input-request-card__btn input-request-card__btn--submit"
              onClick={() => submit('submitted')}
              disabled={submitting || !props.onRespond || !allAnswered}
            >
              Submit
            </button>
            <button
              type="button"
              className="input-request-card__btn input-request-card__btn--dismiss"
              onClick={() => submit('dismissed')}
              disabled={submitting || !props.onRespond}
            >
              Dismiss
            </button>
          </div>
        </>
      )}
    </div>
  );
}
