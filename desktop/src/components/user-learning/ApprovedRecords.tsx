// Trylo Desktop — committed learning records (already-approved memory + skills).
//
// The approval queue (PendingProposals) only shows STAGED writes. This view
// shows what actually landed in Hermes afterwards: the MEMORY / USER blocks
// from memory_snapshot and the installed skills from skills_list. Both are
// read-only, opaque-by-design Hermes payloads — we branch on `ok` and render
// defensively, never re-interpreting Hermes policy.
//
// Failure policy mirrors the queue UI: an infrastructure error is shown as
// an error for that section, NEVER as "nothing approved yet".

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { LearningPort } from '../../learning/learning-port';

type Phase = 'loading' | 'ready' | 'error';

interface MemoryState {
  readonly phase: Phase;
  readonly error: string | null;
  readonly memoryBlock: string;
  readonly userBlock: string;
}

interface SkillView {
  readonly name: string;
  readonly category: string;
  readonly description: string;
}

interface SkillsState {
  readonly phase: Phase;
  readonly error: string | null;
  readonly skills: readonly SkillView[];
}

interface SkillDetail {
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

function normalizeSkill(raw: unknown): SkillView | null {
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

export interface ApprovedRecordsProps {
  readonly port: LearningPort;
  /** Bump to force a reload (e.g. right after a proposal was approved). */
  readonly reloadKey?: number;
}

export function ApprovedRecords(props: ApprovedRecordsProps): ReactElement {
  const [memory, setMemory] = useState<MemoryState>({ phase: 'loading', error: null, memoryBlock: '', userBlock: '' });
  const [skills, setSkills] = useState<SkillsState>({ phase: 'loading', error: null, skills: [] });
  const [openSkill, setOpenSkill] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, SkillDetail>>({});

  const load = useCallback(async () => {
    setMemory({ phase: 'loading', error: null, memoryBlock: '', userBlock: '' });
    setSkills({ phase: 'loading', error: null, skills: [] });

    const [memRes, skillRes] = await Promise.allSettled([
      props.port.memorySnapshot(),
      props.port.skills({ op: 'list' }),
    ]);

    if (memRes.status === 'rejected' || !memRes.value.ok) {
      const err = memRes.status === 'rejected'
        ? (memRes.reason instanceof Error ? memRes.reason.message : 'learning host unavailable')
        : (memRes.value.error ?? 'memory snapshot unavailable');
      setMemory({ phase: 'error', error: err, memoryBlock: '', userBlock: '' });
    } else {
      const rec = asRecord(memRes.value.snapshot) ?? asRecord(memRes.value) ?? {};
      setMemory({
        phase: 'ready',
        error: null,
        memoryBlock: asText(rec.memoryBlock ?? rec.memory ?? ''),
        userBlock: asText(rec.userBlock ?? rec.user ?? ''),
      });
    }

    if (skillRes.status === 'rejected' || !skillRes.value.ok) {
      const err = skillRes.status === 'rejected'
        ? (skillRes.reason instanceof Error ? skillRes.reason.message : 'learning host unavailable')
        : (skillRes.value.error ?? 'skills list unavailable');
      setSkills({ phase: 'error', error: err, skills: [] });
    } else {
      const list = Array.isArray(skillRes.value.skills) ? skillRes.value.skills : [];
      setSkills({
        phase: 'ready',
        error: null,
        skills: list.map(normalizeSkill).filter((x): x is SkillView => x !== null),
      });
    }
  }, [props.port]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.reloadKey]);

  const openSkillDetail = useCallback(async (skill: SkillView) => {
    if (openSkill === skill.name) {
      setOpenSkill(null);
      return;
    }
    setOpenSkill(skill.name);
    if (details[skill.name]?.status === 'ready') return;
    setDetails((d) => ({ ...d, [skill.name]: { status: 'loading', content: '', error: null } }));
    let res;
    try {
      res = await props.port.skills({ op: 'view', name: skill.name });
    } catch (err) {
      setDetails((d) => ({
        ...d,
        [skill.name]: { status: 'error', content: '', error: err instanceof Error ? err.message : 'learning host unavailable' },
      }));
      return;
    }
    if (!res.ok) {
      setDetails((d) => ({
        ...d,
        [skill.name]: { status: 'error', content: '', error: res.error ?? 'skill view unavailable' },
      }));
      return;
    }
    let content = asText(res.content);
    if (!content) {
      try {
        content = JSON.stringify(asRecord(res) ?? res, null, 2);
      } catch {
        content = String(res);
      }
    }
    if (content.length > 6000) content = content.slice(0, 6000) + '\n...(truncated)';
    setDetails((d) => ({ ...d, [skill.name]: { status: 'ready', content, error: null } }));
  }, [details, openSkill, props.port]);

  return (
    <section className="learning-inspector__section">
      <p className="learning-inspector__hint">
        这里是已经批准并真正写入 Hermes 的内容：代理的长期记忆（MEMORY）、你的画像事实（USER），以及已安装的技能（SKILL）。批准后的提案会出现在这里；只读，不能在这里直接修改。
      </p>
      <div className="learning-inspector__actions">
        <button type="button" className="cognition-card__ghost" onClick={() => void load()}>刷新记录</button>
      </div>

      <h4 className="learning-inspector__subhead">
        记忆 MEMORY（{memory.phase === 'ready' ? (memory.memoryBlock.trim() ? '已写入' : '空') : '—'}）
      </h4>
      {memory.phase === 'loading' ? (
        <p className="learning-inspector__raw">正在读取已批准的记忆…</p>
      ) : memory.phase === 'error' ? (
        <p className="learning-inspector__empty">读不到记忆快照（不是没有记忆）：{memory.error}</p>
      ) : memory.memoryBlock.trim() ? (
        <pre className="learning-inspector__raw approved-record__pre">{memory.memoryBlock}</pre>
      ) : (
        <p className="learning-inspector__empty">还没有已批准的记忆条目。在“待审批”里批准的记忆提案会写入这里。</p>
      )}

      <h4 className="learning-inspector__subhead">
        用户画像 USER（{memory.phase === 'ready' ? (memory.userBlock.trim() ? '已写入' : '空') : '—'}）
      </h4>
      {memory.phase === 'ready' ? (
        memory.userBlock.trim() ? (
          <pre className="learning-inspector__raw approved-record__pre">{memory.userBlock}</pre>
        ) : (
          <p className="learning-inspector__empty">还没有已批准的用户画像条目。</p>
        )
      ) : null}

      <h4 className="learning-inspector__subhead">
        技能 SKILLS（{skills.phase === 'ready' ? String(skills.skills.length) : '—'}）
      </h4>
      {skills.phase === 'loading' ? (
        <p className="learning-inspector__raw">正在读取已安装的技能…</p>
      ) : skills.phase === 'error' ? (
        <p className="learning-inspector__empty">读不到技能列表（不是没有技能）：{skills.error}</p>
      ) : skills.skills.length === 0 ? (
        <p className="learning-inspector__empty">还没有已批准的技能。在“待审批”里批准的技能提案会安装到这里。</p>
      ) : (
        <ul className="learning-inspector__list">
          {skills.skills.map((skill) => {
            const open = openSkill === skill.name;
            const detail = details[skill.name];
            return (
              <li key={skill.name}>
                <button type="button" className="learning-inspector__tab" onClick={() => void openSkillDetail(skill)}>
                  <span className="pending-proposal__badge pending-proposal__badge--skills">技能</span>
                  <strong>{skill.name}</strong>
                  <span> · {skill.category}</span>
                </button>
                <p>{skill.description}</p>
                {open ? (
                  <div className="pending-proposal__detail">
                    {detail?.status === 'loading' ? (
                      <p className="learning-inspector__raw">正在读取技能内容…</p>
                    ) : detail?.status === 'error' ? (
                      <p className="learning-inspector__empty">读不到技能内容：{detail.error}</p>
                    ) : detail?.status === 'ready' ? (
                      <pre className="learning-inspector__raw pending-proposal__pre">{detail.content}</pre>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
