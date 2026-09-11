import type { ReactElement } from 'react';
import { useState } from 'react';
import {
  addMember,
  draftStructuralError,
  type ComposerDraft,
  type ModelChoice,
} from './composer-store';
import { MemberInspector } from './MemberInspector';
import { MemberList } from './MemberList';
import type { TeamMemberSpec, TeamRoleId } from '../team-profile-types';

export interface TeamComposerProps {
  readonly draft: ComposerDraft;
  readonly modelChoices: readonly ModelChoice[];
  readonly composerLive: boolean;
  readonly allowNoWorker: boolean;
  readonly inFlight?: boolean;
  readonly canOverwriteSaved: boolean;
  readonly onChange: (next: ComposerDraft) => void;
  readonly onStart: (goal: string) => void;
  /** Launch failure from host-launch, shown without disabling 开始. */
  readonly errorText?: string;
  readonly onSaveAs: (name: string) => void;
  readonly onSaveOverExisting?: () => void;
  readonly onBackToIdle: () => void;
}

export function TeamComposer(props: TeamComposerProps): ReactElement {
  const { draft } = props;
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [saveAsName, setSaveAsName] = useState('');
  const [advanced, setAdvanced] = useState(false);

  const gate = draftStructuralError(draft, { allowNoWorker: props.allowNoWorker });
  const reason = !props.composerLive
    ? '在设置里打开 Team 后才能开始'
    : draft.goal.trim().length === 0
      ? '缺少目标'
      : props.inFlight
        ? '正在开始这场团队…'
        : gate;
  const startEnabled =
    props.composerLive === true &&
    draft.goal.trim().length > 0 &&
    gate === '' &&
    props.inFlight !== true;

  const selectMember = (memberId: string | null): void => {
    props.onChange({ ...draft, selectedMemberId: memberId });
    if (!memberId) setAdvanced(false);
  };
  const addMemberRole = (baseRole: TeamRoleId): void => {
    props.onChange(addMember(draft, baseRole));
  };
  const removeMemberById = (memberId: string): void => {
    const target = draft.members.find((m) => m.memberId === memberId);
    if (!target || target.baseRole === 'person') return;
    props.onChange({
      ...draft,
      members: draft.members.filter((m) => m.memberId !== memberId),
      selectedMemberId: draft.selectedMemberId === memberId ? null : draft.selectedMemberId,
    });
  };
  const renameMemberById = (memberId: string, displayName: string): void => {
    props.onChange({
      ...draft,
      members: draft.members.map((m) =>
        m.memberId === memberId ? { ...m, displayName } : m),
    });
  };
  const patchOverlayById = (
    memberId: string,
    patch: Partial<TeamMemberSpec['overlay']>,
  ): void => {
    props.onChange({
      ...draft,
      members: draft.members.map((m) =>
        m.memberId === memberId ? { ...m, overlay: { ...m.overlay, ...patch } } : m),
    });
  };

  const selectedMember = draft.members.find((m) => m.memberId === draft.selectedMemberId) ?? null;

  return (
    <div className="team-composer">
      <header className="team-composer__head">
        <button type="button" className="team-composer__back" onClick={props.onBackToIdle}>
          返回
        </button>
        <h2 className="team-composer__title">{draft.title}</h2>
        <div className="team-composer__head-actions">
          <button
            type="button"
            className="team-composer__ghost"
            onClick={() => setSaveAsOpen((open) => !open)}
          >
            另存为
          </button>
          <button
            type="button"
            className="team-composer__start"
            disabled={!startEnabled}
            title={reason || '开始'}
            onClick={() => props.onStart(draft.goal)}
          >
            开始
          </button>
        </div>
      </header>
      {reason ? <p className="team-composer__reason">{reason}</p> : null}
      {!reason && props.errorText ? (
        <p className="team-composer__reason">{props.errorText}</p>
      ) : null}

      <div className="team-composer__goal">
        <span className="team-composer__field-label">目标</span>
        <input
          className="team-composer__goal-input"
          value={draft.goal}
          placeholder="这场团队要完成什么"
          onChange={(e) => props.onChange({ ...draft, goal: e.target.value })}
        />
      </div>

      {saveAsOpen ? (
        <div className="team-composer__save-as">
          <input
            className="team-composer__text-input"
            placeholder="模板名称"
            maxLength={24}
            value={saveAsName}
            onChange={(e) => setSaveAsName(e.target.value)}
          />
          <button
            type="button"
            className="team-composer__ghost"
            disabled={saveAsName.trim().length === 0}
            onClick={() => {
              props.onSaveAs(saveAsName.trim());
              setSaveAsOpen(false);
              setSaveAsName('');
            }}
          >
            保存
          </button>
        </div>
      ) : null}

      <div className="team-composer__body">
        <MemberList
          draft={draft}
          onSelect={selectMember}
          onAdd={addMemberRole}
          onRemove={removeMemberById}
        />
        {selectedMember ? (
          <div className="team-composer__selected">
            <button
              type="button"
              className="team-composer__ghost"
              onClick={() => setAdvanced((v) => !v)}
            >
              {advanced ? '收起高级' : '高级'}
            </button>
            {advanced ? (
              <MemberInspector
                draft={draft}
                member={selectedMember}
                modelChoices={props.modelChoices}
                onRename={renameMemberById}
                onPatchOverlay={patchOverlayById}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
