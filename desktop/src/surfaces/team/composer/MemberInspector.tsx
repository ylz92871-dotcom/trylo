import type { ReactElement } from 'react';
import { useState } from 'react';
import {
  TEAM_READ_TOOLS,
  TEAM_SHELL_TOOLS,
  TEAM_WRITE_TOOLS,
  TEAM_META_TOOLS,
  TEAM_RESEARCH_TOOLS,
  TEAM_ROLE_FLOOR_TOOLS,
  SKILL_TOOL_NAME,
  type TeamMemberSpec,
} from '../team-profile-types';
import {
  previewMemberOverlay,
  type ComposerDraft,
  type ModelChoice,
} from './composer-store';

export interface MemberInspectorProps {
  readonly draft: ComposerDraft;
  readonly member: TeamMemberSpec | null;
  readonly modelChoices: readonly ModelChoice[];
  readonly onRename: (memberId: string, displayName: string) => void;
  readonly onPatchOverlay: (
    memberId: string,
    patch: Partial<TeamMemberSpec['overlay']>,
  ) => void;
}

/**
 * The per-member inspector (Foundation spec §10.4 / Appendix A). A
 * form, not a Settings app: the role is text, the spawn group is
 * locked closed, and the default-open groups are Write (worker),
 * Research extra, Skills, and Prompt.
 */
export function MemberInspector(props: MemberInspectorProps): ReactElement {
  const member = props.member;
  const [skillsText, setSkillsText] = useState('');

  if (!member) {
    return (
      <div className="team-composer__inspector">
        <p className="team-composer__inspector-empty">选择左侧成员查看配置</p>
      </div>
    );
  }

  const preview = previewMemberOverlay(member);
  const isPerson = member.baseRole === 'person';
  const isIndependent =
    member.baseRole === 'reviewer' || member.baseRole === 'verifier';

  const toggleTool = (tool: string): void => {
    const current = member.overlay.tools ?? undefined;
    if (current === undefined) {
      // Expand from "full floor" to an explicit list minus the tool.
      const floor = preview.toolsApplied.includes(tool) || tool === SKILL_TOOL_NAME
        ? explicitFloor(member)
        : explicitFloor(member);
      props.onPatchOverlay(member.memberId, {
        tools: floor.filter((t) => t !== tool),
      });
      return;
    }
    const next = current.includes(tool)
      ? current.filter((t) => t !== tool)
      : [...current, tool];
    props.onPatchOverlay(member.memberId, { tools: next });
  };

  return (
    <div className="team-composer__inspector">
      <div className="team-composer__field">
        <span className="team-composer__field-label">角色</span>
        <span className="team-composer__field-value">
          {member.baseRole}
          {isIndependent ? ' · 独立 · 不能被指令 pass' : ''}
        </span>
      </div>

      <div className="team-composer__field">
        <span className="team-composer__field-label">显示名</span>
        <input
          className="team-composer__text-input"
          value={member.displayName}
          maxLength={24}
          disabled={isPerson}
          onChange={(e) => props.onRename(member.memberId, e.target.value)}
        />
      </div>

      <div className="team-composer__field">
        <span className="team-composer__field-label">模型</span>
        <select
          className="team-composer__select"
          value={member.overlay.model || 'inherit'}
          onChange={(e) => props.onPatchOverlay(member.memberId, { model: e.target.value })}
        >
          {props.modelChoices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      </div>

      <details className="team-composer__group" open={!isPerson}>
        <summary>工具</summary>
        <p className="team-composer__group-hint">
          {preview.toolsApplied.length > 0
            ? `生效 ${preview.toolsApplied.length} 项 · Spawn 永远关闭`
            : '该成员为只读执行者'}
        </p>
        <ToolGroup
          title="Write（可去掉）"
          tools={TEAM_WRITE_TOOLS}
          member={member}
          onToggle={toggleTool}
        />
        <ToolGroup
          title="Research（allowlist，需警告）"
          tools={TEAM_RESEARCH_TOOLS}
          member={member}
          onToggle={toggleTool}
          locked={member.baseRole !== 'worker'}
          lockedHint="角色地板：只有 Worker 能加研究工具"
        />
        <details className="team-composer__group">
          <summary>锁定组（Read / Shell / Meta / Spawn）</summary>
          <ToolGroup title="Read" tools={TEAM_READ_TOOLS} member={member} onToggle={toggleTool} />
          <ToolGroup title="Shell" tools={TEAM_SHELL_TOOLS} member={member} onToggle={toggleTool} />
          <ToolGroup title="Meta" tools={TEAM_META_TOOLS} member={member} onToggle={toggleTool} />
          <p className="team-composer__group-hint">
            Spawn（Agent / ExitPlanMode）锁定关闭，任何 overlay 都不能打开。
          </p>
        </details>
      </details>

      <div className="team-composer__field">
        <span className="team-composer__field-label">技能</span>
        {preview.skillsDropped.length > 0 ? (
          <p className="team-composer__group-hint">
            已忽略（{preview.skillsDropped.join('、')}）— 该角色只读
          </p>
        ) : (
          <input
            className="team-composer__text-input"
            placeholder="逗号分隔的技能名；空 = 不加载技能"
            value={skillsText}
            onChange={(e) => setSkillsText(e.target.value)}
            onBlur={() => {
              const skills = skillsText
                .split(/[,，]/)
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
              props.onPatchOverlay(member.memberId, { skills });
            }}
          />
        )}
      </div>

      <div className="team-composer__field">
        <span className="team-composer__field-label">提示 overlay</span>
        <textarea
          className="team-composer__textarea"
          rows={4}
          maxLength={2000}
          placeholder="追加在角色定位之后；不会授予任何工具"
          value={member.overlay.systemPromptOverlay}
          onChange={(e) =>
            props.onPatchOverlay(member.memberId, { systemPromptOverlay: e.target.value })}
        />
        <span className="team-composer__char-count">
          {member.overlay.systemPromptOverlay.length}/2000
        </span>
      </div>
    </div>
  );
}

function explicitFloor(member: TeamMemberSpec): string[] {
  return [...TEAM_ROLE_FLOOR_TOOLS[member.baseRole]];
}

function ToolGroup(props: {
  readonly title: string;
  readonly tools: readonly string[];
  readonly member: TeamMemberSpec;
  readonly onToggle: (tool: string) => void;
  readonly locked?: boolean;
  readonly lockedHint?: string;
}): ReactElement {
  const enabled = props.member.overlay.tools ?? previewMemberOverlay(props.member).toolsApplied;
  return (
    <div className="team-composer__tool-group">
      <span className="team-composer__tool-group-title">{props.title}</span>
      {props.tools.map((tool) => {
        const checked = enabled.includes(tool);
        return (
          <label key={tool} className="team-composer__tool" title={props.locked ? props.lockedHint : undefined}>
            <input
              type="checkbox"
              checked={checked}
              disabled={props.locked === true}
              onChange={() => props.onToggle(tool)}
            />
            <span>{tool}</span>
            {props.locked === true ? <span className="team-composer__locked-tag">锁定</span> : null}
          </label>
        );
      })}
    </div>
  );
}
