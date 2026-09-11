import type { ReactElement } from 'react';
import { useCallback } from 'react';

export interface IdleTemplateRow {
  readonly id: string;
  readonly title: string;
  readonly roster: string;
}

export interface IdleProfileRow {
  readonly id: string;
  readonly title: string;
}

export interface TeamIdleProps {
  readonly composerLive?: boolean;
  readonly disabledReason?: string;
  readonly templates?: readonly IdleTemplateRow[];
  readonly customProfiles?: readonly IdleProfileRow[];
  readonly onOpenComposer?: (templateId: string) => void;
  readonly onOpenProfile?: (profileId: string) => void;
  readonly onDeleteProfile?: (profileId: string) => void;
  readonly onSuggest?: () => void;
  readonly canSuggest?: boolean;
  /** Last Person message — used as the continue-this-task entry. */
  readonly lastPrompt?: string;
}

const DEFAULT_TEMPLATE_ROWS: readonly IdleTemplateRow[] = [
  { id: 'small-change', title: '实现小改动', roster: '代表你 · 动手 · 审查' },
  { id: 'architecture', title: '架构改动', roster: '代表你 · 架构 · 动手 · 审查 · 验收' },
  { id: 'verify-only', title: '交付验收', roster: '代表你 · 动手 · 验收' },
  { id: 'review-only', title: '只审不写', roster: '代表你 · 审查' },
];

/**
 * Team idle: templates and a continue-last-task line. No dead Start button.
 */
export function TeamIdle(props: TeamIdleProps): ReactElement {
  const templates = props.templates ?? DEFAULT_TEMPLATE_ROWS;
  const live = props.composerLive === true;
  const canContinue = live && props.canSuggest === true && Boolean(props.onSuggest);

  const openComposer = useCallback((templateId: string) => {
    props.onOpenComposer?.(templateId);
  }, [props]);

  return (
    <div className="team-idle">
      <p className="team-idle__hint">
        {live
          ? (canContinue ? '用刚才的任务组一组，或选一个模板。' : '选一个模板，填好目标后开始。')
          : (props.disabledReason ?? '在设置里打开 Team 后才能组队。')}
      </p>

      {canContinue ? (
        <button
          type="button"
          className="team-idle__continue"
          onClick={props.onSuggest}
        >
          用刚才那句话组一组
        </button>
      ) : null}

      <p className="team-idle__section">模板</p>
      <div className="team-idle__rows" role="list">
        {templates.map((t) => (
          <button
            key={t.id}
            type="button"
            role="listitem"
            className="team-idle__row"
            onClick={() => openComposer(t.id)}
            disabled={!live}
          >
            <span className="team-idle__row-title">{t.title}</span>
            <span className="team-idle__row-roster">{t.roster}</span>
          </button>
        ))}
      </div>

      {props.customProfiles && props.customProfiles.length > 0 ? (
        <>
          <p className="team-idle__section">我保存的</p>
          <div className="team-idle__rows" role="list">
            {props.customProfiles.map((p) => (
              <div key={p.id} role="listitem" className="team-idle__row team-idle__row--static">
                <button
                  type="button"
                  className="team-idle__row-open"
                  onClick={() => props.onOpenProfile?.(p.id)}
                  disabled={!live}
                >
                  <span className="team-idle__row-title">{p.title}</span>
                </button>
                {props.onDeleteProfile ? (
                  <button
                    type="button"
                    className="team-idle__row-delete"
                    onClick={() => props.onDeleteProfile?.(p.id)}
                    aria-label={`删除 ${p.title}`}
                  >
                    ×
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
