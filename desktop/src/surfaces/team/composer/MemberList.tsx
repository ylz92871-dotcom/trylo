import type { ReactElement } from 'react';
import { TEAM_ROLE_DISPLAY_NAME, TEAM_ROLE_DUTY, type TeamMemberSpec } from '../team-profile-types';
import { addableRoles, type ComposerDraft } from './composer-store';

export interface MemberListProps {
  readonly draft: ComposerDraft;
  readonly onSelect: (memberId: string | null) => void;
  readonly onAdd: (baseRole: TeamMemberSpec['baseRole']) => void;
  readonly onRemove: (memberId: string) => void;
}

export function MemberList(props: MemberListProps): ReactElement {
  const { draft } = props;
  const addable = addableRoles(draft);
  return (
    <div className="team-composer__members">
      <p className="team-composer__field-label">上场</p>
      <div className="team-composer__member-rows" role="list">
        {draft.members.map((member) => {
          const selected = draft.selectedMemberId === member.memberId;
          const removable = member.baseRole !== 'person';
          const extraWriter = member.baseRole === 'worker'
            && draft.members.filter((m) => m.baseRole === 'worker')[0]?.memberId !== member.memberId;
          return (
            <div
              key={member.memberId}
              role="listitem"
              className={`team-composer__member-row${selected ? ' team-composer__member-row--selected' : ''}`}
            >
              <button
                type="button"
                className="team-composer__member-name"
                onClick={() => props.onSelect(selected ? null : member.memberId)}
                aria-pressed={selected}
              >
                <span className="team-composer__member-title">{member.displayName}</span>
                <span className="team-composer__member-duty">
                  {extraWriter ? '只读，避免两个人同时改' : TEAM_ROLE_DUTY[member.baseRole]}
                </span>
              </button>
              <button
                type="button"
                className="team-composer__member-remove"
                onClick={() => props.onRemove(member.memberId)}
                disabled={!removable}
                title={removable ? '移除该成员' : '组队必须有代表你'}
                aria-label={`移除 ${member.displayName}`}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      {addable.length > 0 ? (
        <div className="team-composer__add">
          {addable.map((role) => (
            <button
              key={role}
              type="button"
              className="team-composer__add-role"
              onClick={() => props.onAdd(role)}
            >
              + {TEAM_ROLE_DISPLAY_NAME[role]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
