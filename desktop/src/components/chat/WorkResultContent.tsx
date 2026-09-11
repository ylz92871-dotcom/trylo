// Trylo Desktop — WorkResultContent (P2-1, spec §9.4 / §8.6).
//
// Mode-specific body of the shared ResultDock for the Work capability. It
// renders the current conversation's accumulated artifacts (scoped store),
// putting the latest run's created / updated / discovered items on top with a
// one-shot badge. Each artifact is rendered through @trylo/work's ArtifactCard
// so every open / open-with / show-in-folder / copy action keeps its existing
// containment gate and host binding (spec §8.6). It never IPC's directly.

import { type ReactElement } from 'react';
import { ArtifactCard, type HostAdapter } from '@trylo/work';
import { verificationSummary } from '../../tooling/office-validation';
import type {
  OfficeVerificationStatus,
  StoredWorkArtifact,
  StoredWorkResult,
} from '../../results/conversation-result-types';

export interface WorkResultContentProps {
  readonly result: StoredWorkResult;
  /** The workspace root used to rebuild an artifact's absolute path from its
   *  persisted project-relative path before the ArtifactCard containment gate. */
  readonly workspaceRoot: string;
  /** The project-root-bound artifact host every card action goes through. */
  readonly host: HostAdapter;
  /** Primary in-app "Open": preview the artifact's content in the app viewer
   *  (receives the absolute disk path), forwarded to each ArtifactCard. */
  readonly onPreviewArtifact?: (path: string) => void;
  /** Request a Git diff of an artifact file (receives its repo-relative path).
   *  Absent for web/url artifacts. */
  readonly onDiffArtifact?: (relPath: string) => void;
  /** Missing-host notice when the Work runtime isn't available. */
  readonly canOpenArtifacts?: boolean;
}

/** Number of artifacts attributable to the most recent run. Historical
 * conversation artifacts must not make a zero-output chat turn look like it
 * produced files. App uses this to decide whether the ResultDock belongs to
 * the current turn at all. */
export function latestRunArtifactCount(
  result: StoredWorkResult,
  expected: { readonly turnId?: string; readonly runId?: string } = {},
): number {
  const latest = result.latestRun;
  if (!latest) return 0;
  // A new user turn starts before the async terminal artifact scan can
  // replace `latestRun`. During that window the stored delta belongs to the
  // previous answer and must not be mounted below the new one.
  if (expected.runId) {
    if (latest.runId !== expected.runId) return 0;
  } else if (expected.turnId) {
    // Some reused Work runtimes do not provide a turn id on their result
    // delta. Until the current run id is visible we hide that ambiguous delta;
    // once run ids match, the artifact is safely attributable to this run.
    if (!latest.turnId || latest.turnId !== expected.turnId) return 0;
  }
  return new Set([
    ...latest.createdIds,
    ...latest.updatedIds,
    ...latest.discoveredIds,
  ]).size;
}

function badgeFor(
  artifact: StoredWorkArtifact,
  latestRun: StoredWorkResult['latestRun'],
): { label: string; kind: 'new' | 'updated' | 'discovered' } | undefined {
  if (!latestRun) return undefined;
  if (latestRun.createdIds.includes(artifact.id)) return { label: '新建', kind: 'new' };
  if (latestRun.updatedIds.includes(artifact.id)) {
    return { label: `已更新 · v${artifact.version}`, kind: 'updated' };
  }
  if (latestRun.discoveredIds.includes(artifact.id)) return { label: '已发现', kind: 'discovered' };
  return undefined;
}

/** Rebuild the absolute path a card can open from the persisted project-
 *  relative path. http(s) targets are returned verbatim (web artifacts). */
function absoluteTarget(
  artifact: StoredWorkArtifact,
  workspaceRoot: string,
): string | null {
  if (artifact.target.kind === 'url') return artifact.target.url;
  const rel = artifact.target.relativePath;
  if (!rel || rel.startsWith('/') || /^[a-z]:/i.test(rel) || rel.split('/').includes('..')) {
    return null; // unsafe persisted path — never handed to a card/gate
  }
  return `${workspaceRoot.replace(/[\\/]+$/, '')}/${rel}`;
}

/** The repo-relative path for a Git diff, or null for url/web artifacts and
 *  unsafe persisted paths. Mirrors the containment gate of `absoluteTarget`. */
function relTarget(artifact: StoredWorkArtifact): string | null {
  if (artifact.target.kind !== 'file') return null;
  const rel = artifact.target.relativePath;
  if (!rel || rel.startsWith('/') || /^[a-z]:/i.test(rel) || rel.split('/').includes('..')) {
    return null;
  }
  return rel;
}

/** Sort key: updatedAt desc, then firstSeenAt desc (stable). */
function byNewest(a: StoredWorkArtifact, b: StoredWorkArtifact): number {
  return b.updatedAt - a.updatedAt || b.firstSeenAt - a.firstSeenAt;
}

const BADGE_ORDER = { new: 0, updated: 1, discovered: 2 } as const;

// ── PR-5 (spec §11): delivery verification badges ──────────────────────
// 「ResultDock 显示"已验证 / 部分验证 / 验证失败"」. The verdict is delivery
// metadata rendered NEXT TO the artifact; it never rewrites the agent's
// answer (§11). An artifact without a verdict was never put through the
// pipeline this run — no badge, never an implied pass (§4.4).

const VERIFICATION_LABELS: Readonly<Record<OfficeVerificationStatus, string>> = {
  verified: '已验证',
  partial: '部分验证',
  failed: '验证失败',
  skipped: '未验证',
};

function verificationBadge(artifact: StoredWorkArtifact): ReactElement | null {
  const verification = artifact.verification;
  if (!verification) return null;
  const failedDetails = verification.checks
    .filter((entry) => entry.status === 'failed')
    .map((entry) => `${entry.id}: ${entry.detail ?? entry.reasonCode ?? '未通过'}`);
  const skippedBy = verification.skippedCapabilities ?? [];
  const title = [
    ...failedDetails,
    ...(skippedBy.length > 0 ? [`未执行的检查：${skippedBy.join('、')}`] : []),
  ].join('\n');
  return (
    <span
      className={`work-result__verify work-result__verify--${verification.status}`}
      title={title || undefined}
      data-status={verification.status}
    >
      {VERIFICATION_LABELS[verification.status]}
    </span>
  );
}

function VerificationSummaryLine(props: { artifacts: readonly StoredWorkArtifact[] }): ReactElement | null {
  const summary = verificationSummary(props.artifacts);
  if (!summary) return null;
  const parts: string[] = [];
  if (summary.verified > 0) parts.push(`已验证 ${summary.verified}`);
  if (summary.partial > 0) parts.push(`部分验证 ${summary.partial}`);
  if (summary.failed > 0) parts.push(`验证失败 ${summary.failed}`);
  return (
    <p
      className={`work-result__verify-line${summary.failed > 0 ? ' work-result__verify-line--failed' : ''}`}
      role="status"
    >
      {`交付验证：${parts.join(' · ')}`}
    </p>
  );
}

export function WorkResultContent(props: WorkResultContentProps): ReactElement {
  const { result, latestRun } = { result: props.result, latestRun: props.result.latestRun };

  // Latest-run items first (badged), then the rest by newest.
  const badged = result.artifacts.filter((a) => badgeFor(a, latestRun) !== undefined);
  const rest = result.artifacts.filter((a) => badgeFor(a, latestRun) === undefined);
  const ordered: readonly StoredWorkArtifact[] = [
    ...badged.sort((a, b) => {
      const ka = badgeFor(a, latestRun)?.kind ?? 'discovered';
      const kb = badgeFor(b, latestRun)?.kind ?? 'discovered';
      return BADGE_ORDER[ka] - BADGE_ORDER[kb] || byNewest(a, b);
    }),
    ...rest.sort(byNewest),
  ];

  return (
    <div className="work-result">
      <VerificationSummaryLine artifacts={result.artifacts} />
      {props.canOpenArtifacts === false && (
        <p className="work-result__notice">
          产物已记录；打开或在文件夹中显示需要 Work 运行时。
        </p>
      )}
      {ordered.length === 0 ? (
        <p className="work-result__empty">本轮还没有可交付的产物。</p>
      ) : (
        <>
          {/* Spec §9.4 (C-Edge P2-4): the user must be able to tell
              "this run" from "everything in this conversation" at a
              glance. The badged subset is the latest run's delta; the
              rest is the conversation's accumulated history. */}
          {badged.length > 0 ? (
            <section className="work-result__section" aria-labelledby={`work-latest-${props.result.latestRun?.runId ?? 'n/a'}`}>
              <h4
                id={`work-latest-${props.result.latestRun?.runId ?? 'n/a'}`}
                className="work-result__section-title"
              >
                本轮交付
              </h4>
              <ul className="work-result__list work-result__list--latest">
                {badged.sort((a, b) => {
                  const ka = badgeFor(a, latestRun)?.kind ?? 'discovered';
                  const kb = badgeFor(b, latestRun)?.kind ?? 'discovered';
                  return BADGE_ORDER[ka] - BADGE_ORDER[kb] || byNewest(a, b);
                }).map((artifact) => renderItem(artifact, latestRun, props))}
              </ul>
            </section>
          ) : null}
          {rest.length > 0 ? (
            <section className="work-result__section" aria-label="此对话的历史产物">
              <h4 className="work-result__section-title">此对话的历史产物</h4>
              <ul className="work-result__list">
                {rest.sort(byNewest).map((artifact) => renderItem(artifact, latestRun, props))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

function renderItem(
  artifact: StoredWorkArtifact,
  latestRun: StoredWorkResult['latestRun'],
  props: WorkResultContentProps,
): ReactElement {
  const filePath = absoluteTarget(artifact, props.workspaceRoot);
  const badge = badgeFor(artifact, latestRun);
  const diffRel = relTarget(artifact);
  return (
    <li
      key={artifact.id}
      className="work-result__item"
      data-change={artifact.lastChange}
    >
      {badge ? (
        <span
          className={`work-result__badge work-result__badge--${badge.kind}`}
          data-kind={badge.kind}
        >
          {badge.label}
        </span>
      ) : null}
      {verificationBadge(artifact)}
      {filePath === null ? (
        <div className="work-result__unsafe" title={artifact.displayName}>
          <span className="work-result__unsafe-name">{artifact.displayName}</span>
          <span className="work-result__unsafe-note">路径不可用</span>
        </div>
      ) : (
        <ArtifactCard
          filePath={filePath}
          kind={artifact.artifactKind}
          workspacePath={props.workspaceRoot}
          host={props.host}
          onOpenViewer={props.onPreviewArtifact}
        />
      )}
      {props.onDiffArtifact && diffRel !== null && (
        <button
          type="button"
          className="work-result__diff"
          onClick={() => props.onDiffArtifact!(diffRel)}
          title="查看 Git 变更"
        >
          差异
        </button>
      )}
    </li>
  );
}
