// Trylo Desktop — Hermes staged-write approval surface (memory + skills).
//
// The agent can never write MEMORY / SKILLS directly: every learning write
// is staged into the Hermes write-approval queue and must be reviewed by the
// user (arch section 6.3, spec section 7.5). The desktop-services side already
// exposes listPending / pendingDetail / applyPending / discardPending; this
// component is the missing in-app approval entry — without it proposals pile
// up in the queue with no way for the user to approve them.
//
// Safety rules mirrored here:
//   - an infrastructure error is shown as an error, NEVER as "no proposals";
//   - apply is fail-closed: the expectedHash comes from the detail the user
//     actually reviewed, and approval is blocked if no hash can be obtained;
//   - discard only drops the staged proposal — it never touches committed
//     memory/skills.

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { LearningPort } from '../../learning/learning-port';
import type { PendingSubsystem } from '../../services-host/methods';
import { savePendingOrigin, getPendingOrigin, extractSkillNameFromTarget } from './pending-origin';

export interface PendingProposalView {
  readonly id: string;
  readonly subsystem: PendingSubsystem;
  readonly action: string;
  readonly summary: string;
  readonly origin: string;
  readonly createdAt: number | null;
}

interface DetailState {
  readonly status: 'loading' | 'ready' | 'error';
  readonly text: string;
  readonly hash: string | null;
  readonly error: string | null;
}

type Phase = 'loading' | 'ready' | 'error';

interface Notice {
  readonly kind: 'success' | 'warn' | 'error';
  readonly text: string;
}

const HASH_KEYS = ['expectedHash', 'hash', 'content_hash', 'contentHash', 'payload_hash', 'payloadHash'] as const;
const MAX_DETAIL_CHARS = 6000;

const ACTION_LABELS: Readonly<Record<string, string>> = {
  create: '新建',
  patch: '修订',
  edit: '编辑',
  update: '更新',
  write_file: '写入文件',
  remove_file: '删除文件',
  delete: '删除',
  add: '新增',
  replace: '替换',
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Normalise one raw pending record. Items without an id and a known
 *  subsystem are skipped — the queue is shared infrastructure and we must
 *  not render an approve button for something we cannot address. */
function normalize(raw: unknown): PendingProposalView | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const id = asText(rec.id).trim();
  if (!id) return null;
  const subsystem = rec.subsystem === 'memory' || rec.subsystem === 'skills' ? rec.subsystem : null;
  if (!subsystem) return null;
  const createdAt = typeof rec.created_at === 'number' && Number.isFinite(rec.created_at)
    ? rec.created_at
    : null;
  return {
    id,
    subsystem,
    action: asText(rec.action) || 'proposal',
    summary: asText(rec.summary) || '(no summary)',
    origin: asText(rec.origin) || 'unknown',
    createdAt,
  };
}

/** Pull the anti-swap hash out of a detail response. The official store
 *  names it explicitly; we also accept snake_case variants and fall back to
 *  any sha256-looking string under a hash-named key anywhere in the tree. */
function extractHash(node: unknown, depth = 0): string | null {
  if (depth > 6) return null;
  const rec = asRecord(node);
  if (rec) {
    for (const key of HASH_KEYS) {
      const v = rec[key];
      if (typeof v === 'string' && /^sha256:[0-9a-f]{64}$/.test(v)) return v;
    }
    for (const [k, v] of Object.entries(rec)) {
      if (/hash/i.test(k) && typeof v === 'string' && /^sha256:[0-9a-f]{64}$/.test(v)) return v;
      const nested = extractHash(v, depth + 1);
      if (nested) return nested;
    }
  } else if (Array.isArray(node)) {
    for (const item of node) {
      const nested = extractHash(item, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

function bodyOf(rec: Record<string, unknown>): unknown {
  for (const key of ['item', 'pending', 'proposal', 'payload', 'record', 'detail']) {
    const v = rec[key];
    if (asRecord(v)) return v;
  }
  return rec;
}

function formatDate(ts: number | null): string {
  if (!ts) return '';
  try {
    return new Date(ts * 1000).toLocaleString();
  } catch {
    return '';
  }
}

/** Resolve the human-readable origin label for a pending item. If the stored
 *  origin data is damaged/unparseable → chip shows "实时" (PR-5). */
function resolveOriginLabel(item: PendingProposalView): string {
  try {
    const origin = getPendingOrigin(item.id);
    return origin?.label ?? item.origin;
  } catch {
    return '实时';
  }
}

type CopyAfterApplyResult = 'none' | 'copied' | 'skipped' | 'error';

/** PR-6 copyPlan resolution cache — hermesHome is stable per session. */
let hermesHomeCache: string | null = null;

/**
 * PR-6: apply-time privileged copy of a deliverable into the Skill tree,
 * driven by the review-time copyPlan from the pending-origin map.
 *
 * Guards (all → skip, Skill still applied):
 *   - no origin record or no `skillName` → skip (never parse the opaque
 *     applyPending.result);
 *   - no `.trylo/out` source → skip;
 *   - the sidecar returns `copied:false` + reasonCode → skip.
 * A transport error is reported to diagnostics but NEVER fails the apply —
 * the Skill text was already committed.
 */
async function copyAfterApply(
  port: LearningPort,
  item: PendingProposalView,
  onCopyDiagnostic?: (event: { reasonCode: string; copied: boolean }) => void,
): Promise<CopyAfterApplyResult> {
  const origin = getPendingOrigin(item.id);
  if (!origin || !origin.skillName || !origin.sourceRel || !origin.workspaceRoot) {
    return 'none';
  }
  const sourceRel = origin.sourceRel.replace(/\\/g, '/');
  // destAbs = {HERMES_HOME}/skills/<skillName>/templates/<ascii-slug>.<ext>
  // (spec §5 rule 7). The renderer projects it from health(); the sidecar
  // re-validates its shape against its own hermesHome (defense in depth).
  let hermesHome = hermesHomeCache;
  if (!hermesHome) {
    try {
      const health = await port.health();
      hermesHome = health.hermesHome ?? '';
      hermesHomeCache = hermesHome || null;
    } catch {
      return 'error';
    }
  }
  if (!hermesHome) return 'none';
  const slugBase = (sourceRel.split('/').pop() ?? '').replace(/\.[^.]+$/, '');
  const safeSlug = slugBase.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const ext = (sourceRel.match(/\.([a-z0-9]{1,8})$/i)?.[1] ?? 'pptx').toLowerCase();
  if (!safeSlug) return 'none';
  const destAbs = `${hermesHome}/skills/${origin.skillName}/templates/${safeSlug}.${ext}`;
  try {
    const res = await port.copyTemplateUnderOut({
      workspaceRoot: origin.workspaceRoot,
      sourceRel,
      destAbs,
      expectedBytes: origin.bytes,
      expectedMtimeMs: origin.mtimeMs,
    });
    if (res.ok && res.copied) {
      onCopyDiagnostic?.({ reasonCode: 'template_copy_ok', copied: true });
      return 'copied';
    }
    const reasonCode = res.ok ? res.reasonCode : res.error ?? 'unknown';
    onCopyDiagnostic?.({ reasonCode, copied: false });
    return 'skipped';
  } catch (err) {
    onCopyDiagnostic?.({ reasonCode: 'template_copy_transport_failed', copied: false });
    return 'error';
  }
}

export interface PendingProposalsProps {
  readonly port: LearningPort;
  /** Called whenever the pending count changes, so the panel tab can show a badge. */
  readonly onCountChange?: (count: number) => void;
  /** Called after a successful approve/discard, so sibling views (approved
   *  records) know the committed state may have changed. */
  readonly onSettled?: () => void;
  /** PR-6: diagnostics hook for the apply-time template copy (type
   *  `learning.template_copy`). Optional; never blocks the apply. */
  readonly onCopyDiagnostic?: (event: { reasonCode: string; copied: boolean }) => void;
}

export function PendingProposals(props: PendingProposalsProps): ReactElement {
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<readonly PendingProposalView[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, DetailState>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDiscardId, setConfirmDiscardId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  /** Reload the queue from the backend. Returns the normalised list so
   *  callers can VERIFY the post-action backend state (an apply that leaves
   *  the item in the queue must not be reported as success). */
  const load = useCallback(async (): Promise<readonly PendingProposalView[] | null> => {
    setPhase((p) => (p === 'ready' ? p : 'loading'));
    let res;
    try {
      res = await props.port.listPending();
    } catch (err) {
      setPhase('error');
      setError(err instanceof Error ? err.message : 'learning host unavailable');
      setItems([]);
      props.onCountChange?.(0);
      return null;
    }
    if (!res.ok) {
      // Infrastructure failure must never look like "nothing pending".
      setPhase('error');
      setError(res.error ?? 'pending queue unavailable');
      setItems([]);
      props.onCountChange?.(0);
      return null;
    }
    const parsed = res.pending.map(normalize).filter((x): x is PendingProposalView => x !== null);
    parsed.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    setPhase('ready');
    setError(null);
    setItems(parsed);
    props.onCountChange?.(parsed.length);
    return parsed;
  }, [props]);

  useEffect(() => {
    void load();
    // load identity changes only when the port changes; effect runs on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openDetail = useCallback(async (item: PendingProposalView) => {
    if (expandedId === item.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(item.id);
    setActionError(null);
    if (details[item.id]?.status === 'ready') return;
    setDetails((d) => ({ ...d, [item.id]: { status: 'loading', text: '', hash: null, error: null } }));
    let res;
    try {
      res = await props.port.pendingDetail({ subsystem: item.subsystem, id: item.id });
    } catch (err) {
      setDetails((d) => ({
        ...d,
        [item.id]: { status: 'error', text: '', hash: null, error: err instanceof Error ? err.message : 'learning host unavailable' },
      }));
      return;
    }
    if (!res.ok) {
      setDetails((d) => ({
        ...d,
        [item.id]: { status: 'error', text: '', hash: null, error: res.error ?? 'detail unavailable' },
      }));
      return;
    }
    const detailRec = asRecord(res.detail) ?? {};
    const hash = extractHash(detailRec);
    // PR-5/PR-6: retain target in pending map (with skillName + workspace
    // context), extracted from the pending target. Used at apply time by the
    // copyPlan — never parsed from the opaque applyPending.result.
    const target = detailRec.target ?? detailRec.item ?? detailRec.pending ?? detailRec.payload;
    const skillName = extractSkillNameFromTarget(target);
    savePendingOrigin(item.id, {
      origin: item.origin,
      label: item.summary,
      ...(skillName ? { skillName } : {}),
      createdAt: item.createdAt ?? Date.now(),
    });
    let bodyText: string;
    try {
      bodyText = JSON.stringify(bodyOf(detailRec), null, 2);
    } catch {
      bodyText = String(res.detail);
    }
    if (bodyText.length > MAX_DETAIL_CHARS) {
      bodyText = bodyText.slice(0, MAX_DETAIL_CHARS) + '\n...(truncated)';
    }
    setDetails((d) => ({ ...d, [item.id]: { status: 'ready', text: bodyText, hash, error: null } }));
  }, [details, expandedId, props]);

  const approve = useCallback(async (item: PendingProposalView) => {
    setActionError(null);
    const detail = details[item.id];
    if (!detail || detail.status !== 'ready') {
      setActionError('请先展开提案查看完整内容，再批准。');
      return;
    }
    if (!detail.hash) {
      // Fail-closed: without the reviewed hash we cannot prove the payload
      // is the one the user read, so approval is blocked before any apply.
      setActionError('无法取得提案内容哈希（expectedHash），为防止内容被调包，已阻止本次批准；请刷新后重试。');
      return;
    }
    setBusyId(item.id);
    setNotice(null);
    let res;
    try {
      res = await props.port.applyPending({
        subsystem: item.subsystem,
        id: item.id,
        expectedHash: detail.hash,
        reason: 'approved in Trylo desktop',
      });
    } catch (err) {
      setBusyId(null);
      setNotice({ kind: 'error', text: '批准失败：' + (err instanceof Error ? err.message : 'learning host unavailable') + '（提案仍保留在队列中，未写入）' });
      return;
    }
    setBusyId(null);
    if (!res.ok) {
      setNotice({ kind: 'error', text: '批准失败：' + (res.error ?? 'unknown error') + '（提案仍保留在队列中，未写入）' });
      return;
    }
    // PR-6: apply-time privileged copy (copyPlan from the pending origin map).
    // The Skill apply already succeeded — a copy skip must never be reported
    // as an apply failure (spec §5 rule 7/9).
    const copyResult = await copyAfterApply(props.port, item, props.onCopyDiagnostic);
    let copyResultReason = '';
    if (copyResult === 'skipped') {
      const origin = getPendingOrigin(item.id);
      copyResultReason = origin?.sourceRel ? '源文件已变化或不在 .trylo/out' : '无模板副本';
    }
    // The backend accepted the apply. Drop the item immediately so the
    // user sees the queue shrink, then re-fetch to VERIFY: if the item is
    // still returned by the backend, the write did not really land.
    setItems((list) => list.filter((x) => !(x.id === item.id && x.subsystem === item.subsystem)));
    props.onCountChange?.(Math.max(0, items.length - 1));
    setExpandedId(null);
    setConfirmDiscardId(null);
    props.onSettled?.();
    const refreshed = await load();
    if (refreshed && refreshed.some((x) => x.id === item.id && x.subsystem === item.subsystem)) {
      setNotice({ kind: 'warn', text: `后端仍返回这条提案，写入可能未真正生效：${item.summary}。请再试一次或检查 Hermes。` });
    } else {
      setNotice({
        kind: 'success',
        text: `已批准并写入后端：${item.summary}${copyResult === 'copied' ? '（已复制模板）' : copyResult === 'skipped' ? '（无模板副本：' + copyResultReason + '）' : '（可在“代理学习 → 已批准记录”中查看）'}`,
      });
    }
  }, [details, items.length, load, props]);

  const discard = useCallback(async (item: PendingProposalView) => {
    if (confirmDiscardId !== item.id) {
      setConfirmDiscardId(item.id);
      setActionError(null);
      return;
    }
    setBusyId(item.id);
    setNotice(null);
    let res;
    try {
      res = await props.port.discardPending({ subsystem: item.subsystem, id: item.id });
    } catch (err) {
      setBusyId(null);
      setConfirmDiscardId(null);
      setNotice({ kind: 'error', text: '拒绝失败：' + (err instanceof Error ? err.message : 'learning host unavailable') });
      return;
    }
    setBusyId(null);
    setConfirmDiscardId(null);
    if (!res.ok) {
      setNotice({ kind: 'error', text: '拒绝失败：' + (res.error ?? 'unknown error') });
      return;
    }
    // Same verify-after-write pattern as approve: remove locally, re-fetch,
    // and only report success if the backend no longer returns the item.
    setItems((list) => list.filter((x) => !(x.id === item.id && x.subsystem === item.subsystem)));
    props.onCountChange?.(Math.max(0, items.length - 1));
    setExpandedId(null);
    const refreshed = await load();
    if (refreshed && refreshed.some((x) => x.id === item.id && x.subsystem === item.subsystem)) {
      setNotice({ kind: 'warn', text: `后端仍返回这条提案，拒绝可能未生效：${item.summary}。` });
    } else {
      setNotice({ kind: 'success', text: `已拒绝并从队列移除：${item.summary}（不会影响已有的记忆和技能）` });
    }
  }, [confirmDiscardId, items.length, load, props]);

  if (phase === 'loading') {
    return (
      <section className="learning-inspector__section">
        <p className="learning-inspector__hint">正在读取待审批队列…</p>
      </section>
    );
  }

  if (phase === 'error') {
    return (
      <section className="learning-inspector__section">
        <p className="learning-inspector__empty">读不到待审批队列（不是队列为空）：{error}</p>
        <div className="learning-inspector__actions">
          <button type="button" className="cognition-card__ghost" onClick={() => void load()}>重试</button>
        </div>
      </section>
    );
  }

  return (
    <section className="learning-inspector__section">
      <p className="learning-inspector__hint">
        代理在任务中沉淀的记忆（MEMORY）和技能（SKILL）不会直接写入，全部先暂存在这里。展开查看完整内容后，批准才会生效；拒绝只丢弃这份草稿，不影响已有的记忆和技能。
      </p>
      <div className="learning-inspector__actions">
        <button type="button" className="cognition-card__ghost" onClick={() => void load()}>刷新队列</button>
      </div>
      {notice ? (
        <p className={`learning-inspector__notice learning-inspector__notice--${notice.kind}`} role={notice.kind === 'success' ? 'status' : 'alert'}>
          {notice.text}
          <button type="button" className="learning-inspector__notice-close" aria-label="关闭提示" onClick={() => setNotice(null)}>×</button>
        </p>
      ) : null}
      {actionError ? <p className="learning-inspector__empty" role="alert">{actionError}</p> : null}
      {items.length === 0 ? (
        <p className="learning-inspector__empty">队列为空 —— 没有等待审批的记忆或技能提案。</p>
      ) : (
        <ul className="learning-inspector__list">
          {items.map((item) => {
            const open = expandedId === item.id;
            const detail = details[item.id];
            const busy = busyId === item.id;
            return (
              <li key={item.subsystem + ':' + item.id} className="pending-proposal">
                <button type="button" className="learning-inspector__tab" onClick={() => void openDetail(item)}>
                  <span className={'pending-proposal__badge pending-proposal__badge--' + item.subsystem}>
                    {item.subsystem === 'skills' ? '技能' : '记忆'}
                  </span>
                  <strong>{ACTION_LABELS[item.action] ?? item.action}</strong>
                  <span> · {resolveOriginLabel(item)}{item.createdAt ? ' · ' + formatDate(item.createdAt) : ''}</span>
                </button>
                <p>{item.summary}</p>
                {open ? (
                  <div className="pending-proposal__detail">
                    {detail?.status === 'loading' ? (
                      <p className="learning-inspector__raw">正在读取完整内容…</p>
                    ) : detail?.status === 'error' ? (
                      <p className="learning-inspector__empty">读不到完整内容：{detail.error}</p>
                    ) : detail?.status === 'ready' ? (
                      <>
                        <pre className="learning-inspector__raw pending-proposal__pre">{detail.text}</pre>
                        {detail.hash ? null : (
                          <p className="learning-inspector__empty">未在内容中找到 expectedHash，批准按钮已禁用（防调包）。</p>
                        )}
                        <div className="learning-inspector__modes">
                          <button
                            type="button"
                            className="cognition-card__primary"
                            disabled={busy || !detail.hash}
                            onClick={() => void approve(item)}
                          >
                            {busy ? '处理中…' : '批准写入'}
                          </button>
                          <button
                            type="button"
                            className="cognition-card__ghost"
                            disabled={busy}
                            onClick={() => void discard(item)}
                          >
                            {confirmDiscardId === item.id ? '再点一次确认拒绝' : '拒绝'}
                          </button>
                        </div>
                      </>
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
