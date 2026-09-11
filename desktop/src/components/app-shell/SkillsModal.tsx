// Trylo Desktop — Skills library modal (opened from Settings).
//
// A dedicated dialog for the installed Hermes Skills: list, expand
// and read full SKILL.md content. Read-only by construction —
// installing a skill always goes through the staged proposal flow
// (学习 → 代理学习 → 待审批), exactly like memory writes; this modal
// surfaces where that happens instead of pretending to install.
//
// Failure policy mirrors the learning panels: a backend/Hermes
// failure renders an explicit "读不到" error with retry, NEVER a
// fake "no skills installed" empty state. The whole dialog has one
// scrolling body (flex min-height:0 + overflow-y:auto).

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { LearningPort } from '../../learning/learning-port';

interface SkillSummary {
  readonly name: string;
  readonly category: string;
  readonly description: string;
}

type ListPhase = 'loading' | 'ready' | 'error';

interface SkillDetailState {
  readonly status: 'loading' | 'ready' | 'error';
  readonly content: string;
  readonly error: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeSkill(raw: unknown): SkillSummary | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const name = asText(rec.name ?? rec.title ?? rec.id).trim();
  if (!name) return null;
  return {
    name,
    category: asText(rec.category) || '未分类',
    description: asText(rec.description ?? rec.summary) || '(无描述)',
  };
}

export interface SkillsModalProps {
  readonly open: boolean;
  readonly port: LearningPort;
  readonly onClose: () => void;
  /** Opens the Learning panel's pending tab (skill proposals awaiting
   *  approval). Optional — absent in tests; the hint text still renders. */
  readonly onOpenPending?: () => void;
}

export function SkillsModal(props: SkillsModalProps): ReactElement | null {
  const [phase, setPhase] = useState<ListPhase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [skills, setSkills] = useState<readonly SkillSummary[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillDetailState>({ status: 'loading', content: '', error: null });

  const load = useCallback(async (): Promise<void> => {
    setPhase('loading');
    setError(null);
    try {
      const res = await props.port.skills({ op: 'list' });
      if (!res.ok) {
        setPhase('error');
        setError(res.error ?? 'skills list unavailable');
        setSkills([]);
        return;
      }
      const list = Array.isArray(res.skills) ? res.skills : [];
      setSkills(list.map(normalizeSkill).filter((x): x is SkillSummary => x !== null));
      setPhase('ready');
    } catch (err) {
      // Transport failure (host gone) — degrade, never fake-empty.
      setPhase('error');
      setError(err instanceof Error ? err.message : String(err));
      setSkills([]);
    }
  }, [props.port]);

  useEffect(() => {
    if (props.open) {
      setExpanded(null);
      setDetail({ status: 'loading', content: '', error: null });
      void load();
    }
  }, [props.open, load]);

  // Escape closes.
  useEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.open, props.onClose]);

  const toggle = async (skill: SkillSummary): Promise<void> => {
    if (expanded === skill.name) {
      setExpanded(null);
      return;
    }
    setExpanded(skill.name);
    setDetail({ status: 'loading', content: '', error: null });
    try {
      const res = await props.port.skills({ op: 'view', name: skill.name });
      if (!res.ok) {
        setDetail({ status: 'error', content: '', error: res.error ?? 'skill view unavailable' });
        return;
      }
      setDetail({ status: 'ready', content: asText(res.content) || '(技能内容为空)', error: null });
    } catch (err) {
      setDetail({
        status: 'error',
        content: '',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  if (!props.open) return null;

  return (
    <div
      className="settings-modal__backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Skills"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div className="settings-modal skills-modal">
        <header className="settings-modal__header">
          <h2 className="settings-modal__title">
            技能库 Skills{phase === 'ready' ? `（${skills.length}）` : ''}
          </h2>
          <button
            type="button"
            className="settings-modal__close"
            onClick={props.onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="settings-modal__body skills-modal__body">
          <p className="settings-modal__desc skills-modal__intro">
            技能是代理的可复用工作手册（SOP）。代理在任务中总结的经验会先生成
            <strong> 提案 </strong>，经你在「学习 → 代理学习 → 待审批」里批准后才会安装到这里。
          </p>

          {phase === 'loading' ? (
            <p className="skills-modal__status">正在读取已安装技能…</p>
          ) : phase === 'error' ? (
            <div className="skills-modal__error" role="alert">
              <span>读不到技能列表（不是没有技能）：{error}</span>
              <button type="button" className="settings-modal__btn settings-modal__btn--ghost" onClick={() => void load()}>
                重试
              </button>
            </div>
          ) : skills.length === 0 ? (
            <div className="skills-modal__empty">
              <p>还没有已安装的技能。</p>
              <p className="settings-modal__hint">
                代理干活时沉淀的经验会进入待审批队列；批准后就会出现在这里。
              </p>
              {props.onOpenPending ? (
                <button
                  type="button"
                  className="settings-modal__btn settings-modal__btn--primary"
                  onClick={() => {
                    props.onClose();
                    props.onOpenPending?.();
                  }}
                >
                  去看待审批提案
                </button>
              ) : null}
            </div>
          ) : (
            <ul className="skills-modal__list">
              {skills.map((skill) => {
                const isOpen = expanded === skill.name;
                return (
                  <li key={skill.name} className="skills-modal__item">
                    <button
                      type="button"
                      className="skills-modal__item-head"
                      onClick={() => void toggle(skill)}
                      aria-expanded={isOpen}
                    >
                      <span className="skills-modal__item-name">{skill.name}</span>
                      <span className="skills-modal__item-meta">
                        <span className="skills-modal__category">{skill.category}</span>
                        <span className="skills-modal__chevron" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                      </span>
                    </button>
                    <p className="skills-modal__item-desc">{skill.description}</p>
                    {isOpen ? (
                      <div className="skills-modal__detail">
                        {detail.status === 'loading' ? (
                          <span className="skills-modal__status">正在读取技能内容…</span>
                        ) : detail.status === 'error' ? (
                          <span className="skills-modal__error-text">读不到技能内容：{detail.error}</span>
                        ) : (
                          <pre className="skills-modal__content">{detail.content}</pre>
                        )}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="settings-modal__footer">
          {props.onOpenPending ? (
            <button
              type="button"
              className="settings-modal__btn settings-modal__btn--ghost"
              onClick={() => {
                props.onClose();
                props.onOpenPending?.();
              }}
            >
              待审批提案
            </button>
          ) : <span />}
          <button
            type="button"
            className="settings-modal__btn settings-modal__btn--primary"
            onClick={props.onClose}
          >
            关闭
          </button>
        </footer>
      </div>
    </div>
  );
}
