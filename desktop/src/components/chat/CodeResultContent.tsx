// Trylo Desktop — CodeResultContent (P2-1, spec §9.4 / §7.6).
//
// Mode-specific body of the shared ResultDock for the Code capability. It
// renders the latest-run change delta + structured checks, plus the
// current workspace changes when run attribution is unavailable. It never
// IPC's directly — open-diff / open-file / refresh are injected by the host.

import type { ReactElement } from 'react';
import type {
  StoredCodeChange,
  StoredCodeCheck,
  StoredCodeRunResult,
} from '../../results/conversation-result-types';
import type { CodeCheckKind } from '../../results/conversation-result-types';

export interface CodeResultContentProps {
  readonly result: StoredCodeRunResult;
  /** Request a Git diff for a change. For a rename, `oldPath` is the rename
   *  source (the left side reads its HEAD blob). Deleted files are supported
   *  too — left = HEAD blob, right = empty (spec §7.7). */
  readonly onOpenDiff: (path: string, oldPath?: string) => void;
  /** Open the plain file (secondary action). */
  readonly onOpenFile: (path: string) => void;
}

const KIND_LABEL: Record<StoredCodeChange['kind'], string> = {
  added: 'added',
  modified: 'modified',
  deleted: 'deleted',
  renamed: 'renamed',
  copied: 'copied',
  type_changed: 'type changed',
  unmerged: 'unmerged',
  unknown: 'unknown',
};

const CHECK_LABEL: Record<CodeCheckKind, string> = {
  test: 'test',
  typecheck: 'typecheck',
  lint: 'lint',
  build: 'build',
  format: 'format',
};

/** Longest path shown before CSS truncation kicks in. */
function truncatePath(path: string): string {
  return path.length > 140 ? `${path.slice(0, 139)}…` : path;
}

function ChangeRow({
  change,
  onOpenDiff,
  onOpenFile,
}: {
  readonly change: StoredCodeChange;
  readonly onOpenDiff: (path: string, oldPath?: string) => void;
  readonly onOpenFile: (path: string) => void;
}): ReactElement {
  // WP-4: colour is never the only signal — the `+N` / `−N` / `Binary`
  // text always carries the information. Missing numbers render as `—`,
  // never a fake `+0 −0`.
  const isBinary = change.binary === true;
  const hasStats = change.additions !== undefined || change.deletions !== undefined;
  return (
    <li className="code-result__change">
      <span className="code-result__badge" data-kind={change.kind}>
        {KIND_LABEL[change.kind]}
      </span>
      <button
        type="button"
        className="code-result__path"
        title={`Open ${change.path}`}
        onClick={() => onOpenFile(change.path)}
      >
        {truncatePath(change.path)}
      </button>
      <span className="code-result__stat" aria-label={
        isBinary ? 'diff stats Binary' : hasStats
          ? `diff stats +${change.additions ?? 0} −${change.deletions ?? 0}`
          : 'diff stats unavailable'
      }>
        {isBinary ? (
          'Binary'
        ) : hasStats ? (
          <>
            <span className="code-result__plus">+{change.additions ?? 0}</span>
            <span className="code-result__minus">−{change.deletions ?? 0}</span>
          </>
        ) : (
          '—'
        )}
      </span>
      <span className="code-result__actions">
        <button
          type="button"
          className="code-result__action"
          onClick={() => onOpenDiff(change.path, change.oldPath)}
          title="Open Git diff"
        >
          Diff
        </button>
        <button
          type="button"
          className="code-result__action"
          onClick={() => onOpenFile(change.path)}
          title="Open file"
        >
          Open
        </button>
      </span>
    </li>
  );
}

function CheckRow({ check }: { readonly check: StoredCodeCheck }): ReactElement {
  return (
    <li className="code-result__check" data-status={check.status}>
      <span className="code-result__check-label">{check.label}</span>
      <span className="code-result__check-kind">({CHECK_LABEL[check.kind]})</span>
      <span className="code-result__check-status">{check.status}</span>
    </li>
  );
}

export function CodeResultContent(props: CodeResultContentProps): ReactElement {
  const { result } = props;
  const runChanges = result.attribution === 'run_delta' ? result.changes : [];
  const isWorkspaceView = result.attribution === 'workspace_only';
  const content = (isWorkspaceView ? result.changes : runChanges) ?? [];

  return (
    <div className="code-result">
      {isWorkspaceView && (
        <p className="code-result__notice">
          当前目录无法精确归因到本轮，以下展示工作区现有变更。
        </p>
      )}
      {content.length > 0 && (
        <section className="code-result__section" aria-label={
          isWorkspaceView ? 'Workspace changes' : 'This run'
        }>
          <h4 className="code-result__section-title">
            {isWorkspaceView ? 'Workspace changes' : 'This run'}
          </h4>
          <ul className="code-result__changes">
            {content.map((change) => (
              <ChangeRow
                key={change.path}
                change={change}
                onOpenDiff={props.onOpenDiff}
                onOpenFile={props.onOpenFile}
              />
            ))}
          </ul>
        </section>
      )}
      {result.checks.length > 0 && (
        <section className="code-result__section" aria-label="Checks">
          <h4 className="code-result__section-title">Checks</h4>
          <ul className="code-result__checks">
            {result.checks.map((check) => (
              <CheckRow key={check.id} check={check} />
            ))}
          </ul>
        </section>
      )}
      {result.changes.length === 0 && result.checks.length === 0 && (
        <p className="code-result__empty">No Git changes or checks observed this run.</p>
      )}
    </div>
  );
}
