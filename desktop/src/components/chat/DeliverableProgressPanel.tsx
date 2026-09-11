// Trylo Desktop — DeliverableProgressPanel (redesign spec §8.5).
//
// 2026-09-01 (IDE-style redesign): replaces the flex-wrap milestone
// pills with a vertical step list (GitHub Actions / IntelliJ build
// tool window pattern). Each step shows icon + label + optional
// expandable detail panel. A thin progress bar lives in the header.
// The old monolithic "详情" disclosure is gone — content is per-step.
//
// The panel NEVER invents progress (§16):
//   - while the whole-deck generator runs without a per-page
//     callback it only says "正在生成 N 页" (or "正在生成…"
//     when even the real count is unknown) — never `4 / 10`;
//   - `N / M` appears only when hasRealPageProgress is true;
//   - a visual QA check without a renderer shows `未运行`
//     (not_run), never a green pass.

import { memo, useState, type ReactElement } from 'react';
import { Check, ChevronRight, Circle, Loader, X } from 'lucide-react';
import {
  countSlidesAtLeast,
  getDeliverableDefinition,
  hasRealPageProgress,
  realSlideCount,
  type DeliverableValidationEntry,
  type DeliverableWorkflowDefinition,
  type PresentationOutline,
  type PresentationWorkflowProjection,
} from '@trylo/work';
import type { DeliverableMessage } from './types';

export interface DeliverableProgressPanelProps {
  readonly message: DeliverableMessage;
}

type MilestoneStatus = 'pending' | 'active' | 'done' | 'failed';

/** Derive each registry milestone's status from REAL
 *  projection facts. Anything without a fact stays pending —
 *  the panel never claims a stage the facts don't prove. */
function milestoneStatuses(
  p: PresentationWorkflowProjection,
): Map<string, MilestoneStatus> {
  const out = new Map<string, MilestoneStatus>();
  const rendered = countSlidesAtLeast(p, 'rendered');
  const real = realSlideCount(p);
  const issues = p.slides.filter((s) => s.status === 'issue').length;

  out.set('brief', p.brief.status === 'collecting' ? 'active' : 'done');
  out.set('sources', p.sources.length > 0 ? 'done' : 'pending');
  out.set('outline', p.outline
    ? (p.outline.status === 'approved' || p.outline.status === 'superseded'
        ? 'done'
        : 'active')
    : 'pending');
  out.set('visual', p.visualDirection?.status === 'selected' ? 'done' : 'pending');
  out.set('generate', p.generating
    ? 'active'
    : p.slides.length > 0
      ? (issues > 0 ? 'failed' : 'done')
      : 'pending');
  out.set('preview', rendered > 0 ? (real !== undefined && rendered >= real ? 'done' : 'active') : 'pending');
  out.set('qa', validationStatus(p.validation));
  out.set('export', p.exports.length > 0 ? 'done' : 'pending');

  // Generic families (m1…mN): map the PPT facts onto the
  // positional axis best-effort — brief / structure / export.
  out.set('m1', out.get('brief') ?? 'pending');
  out.set('m3', out.get('outline') ?? 'pending');
  out.set('m8', out.get('export') ?? 'pending');
  return out;
}

function validationStatus(
  entries: readonly DeliverableValidationEntry[],
): MilestoneStatus {
  if (entries.length === 0) return 'pending';
  if (entries.some((e) => e.status === 'running')) return 'active';
  if (entries.some((e) => e.status === 'failed')) return 'failed';
  const decisive = entries.filter((e) => e.status !== 'not_run' && e.status !== 'pending');
  return decisive.length > 0 ? 'done' : 'pending';
}

function MilestoneIcon({ status }: { status: MilestoneStatus }): ReactElement {
  switch (status) {
    case 'done':
      return <Check size={11} strokeWidth={2.4} aria-hidden="true" />;
    case 'failed':
      return <X size={11} strokeWidth={2.4} aria-hidden="true" />;
    case 'active':
      return <Loader size={11} strokeWidth={2.4} aria-hidden="true" />;
    case 'pending':
      return <Circle size={11} strokeWidth={2} aria-hidden="true" />;
  }
}

/** Spec §8.5 A: the brief panel. Missing fields are honest —
 *  "由 Trylo 决定", never fabricated values. */
function BriefSection({ p }: { p: PresentationWorkflowProjection }): ReactElement {
  const b = p.brief;
  const row = (label: string, value: string | undefined): ReactElement => (
    <div className="deliverable-panel__brief-row">
      <span className="deliverable-panel__brief-label">{label}</span>
      <span className="deliverable-panel__brief-value">{value ?? '由 Trylo 决定'}</span>
    </div>
  );
  return (
    <div className="deliverable-panel__brief">
      {row('用途', b.purpose)}
      {row('受众', b.audience)}
      {row('语气', b.tone)}
      {row('语言', b.language)}
      {row('时长', b.durationMinutes !== undefined ? `${b.durationMinutes} 分钟` : undefined)}
      {row('期望页数', b.requestedSlideCount !== undefined ? `${b.requestedSlideCount} 页（期望）` : undefined)}
    </div>
  );
}

/** Spec §8.5 C: the outline card. One card, superseded in
 *  place — never stacked (§8.4). */
export function PresentationOutlineCard({
  outline,
}: {
  outline: PresentationOutline;
}): ReactElement {
  const statusLabel =
    outline.status === 'approved' ? '已确认'
      : outline.status === 'awaiting_review' ? '待确认'
        : outline.status === 'superseded' ? '已取代'
          : '草稿';
  const MAX_ROWS = 12;
  const overflow = outline.slides.length - MAX_ROWS;
  return (
    <div className="deliverable-panel__outline">
      <div className="deliverable-panel__outline-head">
        <span className="deliverable-panel__outline-title">
          {`大纲 v${outline.version}`}
        </span>
        <span
          className={`deliverable-panel__outline-status deliverable-panel__outline-status--${outline.status}`}
        >
          {statusLabel}
        </span>
        <span className="deliverable-panel__outline-count">
          {`${outline.slides.length} 页`}
        </span>
      </div>
      <ol className="deliverable-panel__outline-list">
        {outline.slides.slice(0, MAX_ROWS).map((s) => (
          <li key={s.index} className="deliverable-panel__outline-row">
            <span className="deliverable-panel__outline-index">{s.index}</span>
            <span className="deliverable-panel__outline-slide-title">{s.title}</span>
          </li>
        ))}
        {overflow > 0 && (
          <li className="deliverable-panel__outline-overflow">
            {`… 其余 ${overflow} 页`}
          </li>
        )}
      </ol>
    </div>
  );
}

/** Spec §8.5 F: the preview grid. Tiles are honest — a tile
 *  only shows a preview mark when a real rendered preview
 *  exists for that page. Without a packaged renderer the grid
 *  stays placeholder tiles (never fake thumbnails). */
export function PresentationPreviewGrid({
  p,
}: {
  p: PresentationWorkflowProjection;
}): ReactElement | null {
  if (p.slides.length === 0) return null;
  return (
    <div
      className="deliverable-panel__preview-grid"
      aria-label={`预览 · ${p.slides.length} 页`}
    >
      {p.slides.map((s) => (
        <div
          key={s.index}
          className={`deliverable-panel__preview-tile deliverable-panel__preview-tile--${s.status}`}
          title={s.title}
        >
          <span className="deliverable-panel__preview-index">{s.index}</span>
          <span className="deliverable-panel__preview-state">
            {s.previewPath !== undefined
              ? '已渲染'
              : s.status === 'generating'
                ? '生成中'
                : s.status === 'issue'
                  ? '异常'
                  : '待渲染'}
          </span>
        </div>
      ))}
    </div>
  );
}

const VALIDATION_LABELS: Record<DeliverableValidationEntry['status'], string> = {
  pending: '排队中',
  running: '检查中',
  passed: '通过',
  warning: '有警告',
  failed: '未通过',
  not_run: '未运行',
};

// ── Milestone → content mapping ──────────────────────────────
// Each milestone with content renders an expandable step; milestones
// without content (e.g. sources) show as non-interactive rows.

function stepContentFor(
  milestoneId: string,
  p: PresentationWorkflowProjection,
): ReactElement | null {
  switch (milestoneId) {
    case 'brief':
    case 'm1':
      return <BriefSection p={p} />;
    case 'outline':
    case 'm3':
      return p.outline !== undefined ? <PresentationOutlineCard outline={p.outline} /> : null;
    case 'visual':
      return p.visualDirection !== undefined ? (
        <div className="deliverable-panel__visual">
          <span className="deliverable-panel__section-title">视觉方向</span>
          <span className="deliverable-panel__visual-value">
            {[p.visualDirection.mode, p.visualDirection.templateName, p.visualDirection.brandName]
              .filter((v): v is string => v !== undefined)
              .join(' · ') || '由 Trylo 决定'}
          </span>
        </div>
      ) : null;
    case 'generate':
    case 'preview':
      return <PresentationPreviewGrid p={p} />;
    case 'qa':
      return p.validation.length > 0 ? (
        <ul className="deliverable-panel__validation" aria-label="质检">
          {p.validation.map((v) => (
            <li
              key={v.id}
              className={`deliverable-panel__validation-row deliverable-panel__validation-row--${v.status}`}
            >
              <span className="deliverable-panel__validation-label">{v.label}</span>
              <span className="deliverable-panel__validation-status">
                {VALIDATION_LABELS[v.status]}
              </span>
              {v.evidence !== undefined && (
                <span className="deliverable-panel__validation-evidence">{v.evidence}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null;
    case 'export':
    case 'm8':
      return p.exports.length > 0 ? (
        <ul className="deliverable-panel__exports" aria-label="导出">
          {p.exports.map((e) => (
            <li key={`${e.format}:${e.path}`} className="deliverable-panel__export-row">
              <span className="deliverable-panel__export-format">{e.format.toUpperCase()}</span>
              <span className="deliverable-panel__export-path">{e.path}</span>
            </li>
          ))}
        </ul>
      ) : null;
    default:
      return null;
  }
}

// ── IDE-style step component ──────────────────────────────────

function MilestoneStep({
  milestone,
  status,
  expanded,
  onToggle,
  children,
}: {
  milestone: DeliverableWorkflowDefinition['milestones'][number];
  status: MilestoneStatus;
  expanded: boolean;
  onToggle: () => void;
  children: ReactElement | null;
}): ReactElement {
  const hasContent = children !== null;
  return (
    <li className={`deliverable-panel__step deliverable-panel__step--${status}`}>
      <button
        type="button"
        className="deliverable-panel__step-head"
        onClick={onToggle}
        disabled={!hasContent}
        aria-expanded={hasContent ? expanded : undefined}
      >
        <span className="deliverable-panel__step-icon">
          <MilestoneIcon status={status} />
        </span>
        <span className="deliverable-panel__step-label">{milestone.label}</span>
        {hasContent && (
          <ChevronRight
            size={12}
            strokeWidth={2.2}
            className={`deliverable-panel__step-chevron disclosure-chevron${expanded ? ' disclosure-chevron--open' : ''}`}
            aria-hidden="true"
          />
        )}
      </button>
      {hasContent && (
        <div className={`disclosure deliverable-panel__step-body${expanded ? ' disclosure--open' : ''}`}>
          <div className="disclosure__inner">
            {children}
          </div>
        </div>
      )}
    </li>
  );
}

// ── Progress bar ──────────────────────────────────────────────

function ProgressBar({
  p,
}: {
  p: PresentationWorkflowProjection;
}): ReactElement | null {
  if (!hasRealPageProgress(p)) return null;
  const rendered = countSlidesAtLeast(p, 'rendered');
  const real = realSlideCount(p);
  if (real === undefined || real === 0) return null;
  const pct = Math.min(100, Math.round((rendered / real) * 100));
  return (
    <div
      className="deliverable-panel__progress-track"
      role="progressbar"
      aria-valuenow={rendered}
      aria-valuemin={0}
      aria-valuemax={real}
      aria-label={`${rendered} / ${real} 页`}
    >
      <div
        className="deliverable-panel__progress-fill"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────

function DeliverableProgressPanelImpl(
  props: DeliverableProgressPanelProps,
): ReactElement {
  const p = props.message.projection;
  const def: DeliverableWorkflowDefinition = getDeliverableDefinition(p.kind);
  const statuses = milestoneStatuses(p);
  const real = realSlideCount(p);

  // Spec §8.5 E / §16: the ONLY honest progress lines.
  let progressLine: string | undefined;
  if (p.generating) {
    progressLine = real !== undefined ? `正在生成 ${real} 页…` : '正在生成…';
  } else if (hasRealPageProgress(p) && real !== undefined) {
    progressLine = `${countSlidesAtLeast(p, 'rendered')} / ${real} 页已渲染`;
  }

  // Per-step expand state (IDE-style: each step independently expandable).
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());
  const toggleStep = (id: string) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div
      className="deliverable-panel"
      role="listitem"
      aria-label={`交付物进度 · ${def.milestones.length} 阶段`}
    >
      <div className="deliverable-panel__head">
        <span className="deliverable-panel__head-kind">演示文稿</span>
        {real !== undefined && (
          <span className="deliverable-panel__head-count">{`${real} 页`}</span>
        )}
        {progressLine !== undefined && (
          <span className="deliverable-panel__head-progress" role="status">
            {progressLine}
          </span>
        )}
      </div>

      <ProgressBar p={p} />

      <ol className="deliverable-panel__steps" aria-label="交付物阶段">
          {def.milestones.map((m) => {
            const status = statuses.get(m.id) ?? 'pending';
            const content = stepContentFor(m.id, p);
            return (
              <MilestoneStep
                key={m.id}
                milestone={m}
                status={status}
                expanded={expandedSteps.has(m.id)}
                onToggle={() => toggleStep(m.id)}
              >
                {content}
              </MilestoneStep>
            );
          })}
      </ol>

      {/* Spec §8.6 / §8.8: a checkpoint awaiting the user's
       *  decision shows IN PLACE on the panel. The decision
       *  itself travels the existing approval/input channel —
       *  the panel only surfaces the node. */}
      {p.outline?.status === 'awaiting_review' &&
        def.checkpoints.some((c) => c.afterMilestone === 'outline') && (
          <div className="deliverable-panel__checkpoint" role="status">
            <span className="deliverable-panel__checkpoint-label">
              {def.checkpoints.find((c) => c.afterMilestone === 'outline')?.label ?? '确认'}
            </span>
            <span className="deliverable-panel__checkpoint-text">
              大纲待你确认——确认后才开始生成，可在上方审批卡片中决定。
            </span>
          </div>
        )}
    </div>
  );
}

export const DeliverableProgressPanel = memo(DeliverableProgressPanelImpl);