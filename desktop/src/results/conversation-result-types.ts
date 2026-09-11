// Trylo Desktop — P2-1 result domain types (spec §6.1-§6.4).
//
// Pure, framework-free data contracts shared by the projectors, the
// persistence layer and the ResultDock view model adapters. Nothing in this
// file imports React, Tauri, the Git service or the Work runtime. Unknown
// fields are never passed through to disk (spec §4.6 / §2.5).

/** How complete a result projection is. `degraded` means the Agent Run may
 *  have succeeded/failed, but the projection itself is incomplete (e.g. a
 *  Git baseline or terminal scan failed). It never overwrites the runtime
 *  outcome (spec §6.1). */
export type ResultRunStatus =
  | 'collecting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'degraded';

export interface StoredRunMeta {
  readonly runId: string;
  readonly turnId: string;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly status: ResultRunStatus;
  /** Bounded, non-sensitive explanation of a partial / degraded projection. */
  readonly warning?: string;
}

export type CodeFileChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type_changed'
  | 'unmerged'
  | 'unknown';

export interface StoredCodeChange {
  /** Git repo-relative path, always using `/` separators. */
  readonly path: string;
  /** Present for rename / copy. */
  readonly oldPath?: string;
  readonly kind: CodeFileChangeKind;
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly untracked: boolean;
  /** WP-4 (Code diff stats): added lines in the current HEAD -> worktree
   *  diff. Absent when unknown (fetch failed / binary / unavailable). */
  readonly additions?: number;
  /** WP-4: deleted lines in the current HEAD -> worktree diff. */
  readonly deletions?: number;
  /** WP-4: true for a binary change — UI shows `Binary`, not `+N/−N`. */
  readonly binary?: boolean;
}

export type CodeCheckKind = 'test' | 'typecheck' | 'lint' | 'build' | 'format';
export type CodeCheckStatus = 'passed' | 'failed' | 'cancelled';

export interface StoredCodeCheck {
  /** runId + toolCallId. */
  readonly id: string;
  /** Classified + length-bounded; never the raw command or output. */
  readonly label: string;
  readonly kind: CodeCheckKind;
  readonly status: CodeCheckStatus;
  readonly durationMs?: number;
}

export type CodeAttribution = 'run_delta' | 'workspace_only' | 'unavailable';

export interface StoredCodeRunResult {
  readonly meta: StoredRunMeta;
  readonly attribution: CodeAttribution;
  readonly changes: readonly StoredCodeChange[];
  readonly checks: readonly StoredCodeCheck[];
  readonly changeCountTotal: number;
  readonly checkCountTotal: number;
  readonly truncated: boolean;
  /** WP-4: total added lines across all changes (HEAD -> worktree). Absent
   *  when stats were not fetched or incomplete. */
  readonly additionsTotal?: number;
  /** WP-4: total deleted lines across all changes. */
  readonly deletionsTotal?: number;
  /** WP-4: true when every retained change has a reliable stat (either
   *  `binary` or `+N/−N`). When false the UI shows `—` for missing values
   *  and must not present partial totals as complete. */
  readonly statsComplete?: boolean;
}

export type WorkArtifactTarget =
  | { readonly kind: 'file'; readonly relativePath: string }
  | { readonly kind: 'url'; readonly url: string };

export type WorkArtifactChange =
  | 'created'
  | 'updated'
  | 'discovered'
  | 'unchanged';

export type WorkArtifactSource = 'event' | 'scan' | 'recovery';

// ── PR-5: Office delivery verification (spec §11) ──────────────────────
//
// 「Office 交付不是"工具调用成功"，而是验证流水线成功」(§11). A Work run is
// only allowed to claim a deliverable once the deterministic host pipeline
// has judged it. The verdict is persisted NEXT TO the artifact (never inside
// the agent's answer) so that:
//   · a failed verification marks the run `degraded` (§11) — it never rewrites
//     the agent's reply into a success, and the model may keep fixing it in
//     the same conversation;
//   · a missing capability shows up as `partial` WITH the reason, never as a
//     silent pass (§4.4 能力降级合同).

/** `verified` 已验证 · `partial` 部分验证 · `failed` 验证失败 ·
 *  `skipped` 未验证（非 Office 文件 / 预算耗尽 / 无验证能力）。 */
export type OfficeVerificationStatus = 'verified' | 'partial' | 'failed' | 'skipped';

export type OfficeCheckId =
  | 'file-present'
  | 'container-match'
  | 'structure'
  | 'officecli-validate'
  | 'libreoffice-roundtrip';

export type OfficeCheckStatus = 'passed' | 'failed' | 'skipped';

export interface StoredWorkArtifactCheck {
  readonly id: OfficeCheckId;
  readonly status: OfficeCheckStatus;
  /** Bounded, closed-set reason code (never free text). */
  readonly reasonCode?: string;
  /** Short, non-sensitive human detail (never document content). */
  readonly detail?: string;
}

export interface StoredWorkArtifactVerification {
  readonly status: OfficeVerificationStatus;
  readonly checkedAt: number;
  readonly checks: readonly StoredWorkArtifactCheck[];
  /** Why a check did not run, e.g. `officecli:not_installed` (§4.4). */
  readonly skippedCapabilities?: readonly string[];
  /** Set when the artifact was not verified at all (`skipped`). */
  readonly reasonCode?: string;
}

/** Spec §8.6: extend the Artifact display to a generic `file` fallback so
 *  unknown-extension outputs are not mislabelled as `document`. The Work
 *  side keeps its own richer set; the persisted set is the display-level
 *  set we care about here. */
export type StoredWorkArtifactKind =
  | 'document'
  | 'presentation'
  | 'spreadsheet'
  | 'web'
  | 'file';

export interface StoredFileSignature {
  readonly size: number;
  readonly modifiedMs: number;
  readonly contentHash?: string;
}

export interface StoredWorkArtifact {
  /** target kind + canonical target identity. */
  readonly id: string;
  readonly target: WorkArtifactTarget;
  readonly displayName: string;
  readonly artifactKind: StoredWorkArtifactKind;
  /** 1 on first entry into the conversation; only a real cross-run content
   *  change bumps it (spec §8.5). */
  readonly version: number;
  readonly firstSeenAt: number;
  readonly updatedAt: number;
  readonly firstRunId: string;
  readonly lastRunId: string;
  readonly lastTurnId: string;
  readonly lastChange: WorkArtifactChange;
  readonly sources: readonly WorkArtifactSource[];
  readonly signature?: StoredFileSignature;
  /** PR-5 (§11): the delivery-verification verdict for this artifact.
   *  Absent when the file was never put through the pipeline (e.g. an
   *  artifact recorded before PR-5, or a non-Office download). */
  readonly verification?: StoredWorkArtifactVerification;
}

export interface StoredWorkRunDelta {
  readonly runId: string;
  readonly turnId: string;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly status: ResultRunStatus;
  readonly warning?: string;
  readonly createdIds: readonly string[];
  readonly updatedIds: readonly string[];
  readonly discoveredIds: readonly string[];
}

export interface StoredWorkResult {
  readonly latestRun?: StoredWorkRunDelta;
  readonly artifacts: readonly StoredWorkArtifact[];
  readonly artifactCountTotal: number;
  readonly truncated: boolean;
}

export interface StoredConversationResults {
  readonly schemaVersion: 1;
  readonly code?: { readonly latestRun?: StoredCodeRunResult };
  readonly work?: StoredWorkResult;
}