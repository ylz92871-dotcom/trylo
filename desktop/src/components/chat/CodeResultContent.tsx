// Trylo Desktop — CodeResultContent (P2-1, spec §9.4 / §7.6).
//
// Mode-specific body of the shared ResultDock for the Code capability. It
// renders the latest-run change delta + structured checks, plus the
// current workspace changes when run attribution is unavailable. It never
// IPC's directly — open-diff / open-file / refresh are injected by the host.

import type { ReactElement } from 'react';
import { FileCode2, FileText } from 'lucide-react';
import type {
  StoredCodeChange,
  StoredCodeCheck,
  StoredCodeRunResult,
} from '../../results/conversation-result-types';
import type { CodeCheckKind } from '../../results/conversation-result-types';

export interface CodeResultContentProps {
  readonly result: StoredCodeRunResult;
  /** A retained run must not be presented as output from the current turn. */
  readonly historical?: boolean;
  /** Request a Git diff for a change. For a rename, `oldPath` is the rename
   *  source (the left side reads its HEAD blob). Deleted files are supported
   *  too — left = HEAD blob, right = empty (spec §7.7). */
  readonly onOpenDiff: (path: string, oldPath?: string) => void;
  /** Open the plain file (secondary action). */
  readonly onOpenFile: (path: string) => void;
}

const KIND_LABEL: Record<StoredCodeChange['kind'], string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
  renamed: '重命名',
  copied: '复制',
  type_changed: '类型变更',
  unmerged: '有冲突',
  unknown: '变更',
};

const CHECK_LABEL: Record<CodeCheckKind, string> = {
  test: 'test',
  typecheck: 'typecheck',
  lint: 'lint',
  build: 'build',
  format: 'format',
};

function FileName({ path }: { readonly path: string }): ReactElement {
  const normalized = path.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return <span className="code-result__name">
    <span className="code-result__filename">{normalized.slice(slash + 1)}</span>
    {slash >= 0 && <span className="code-result__directory">{normalized.slice(0, slash)}</span>}
  </span>;
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
      <button
        type="button"
        className="code-result__path"
        title={change.path}
        aria-label={`查看差异 ${change.path}`}
        onClick={() => onOpenDiff(change.path, change.oldPath)}
      >
        <FileCode2 size={16} aria-hidden="true" />
        <FileName path={change.path} />
      </button>
      <span className="code-result__metadata">
      <span className="code-result__badge" data-kind={change.kind}>
        {KIND_LABEL[change.kind]}
      </span>
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
      </span>
        <button
          type="button"
          className="code-result__action"
          onClick={() => onOpenFile(change.path)}
          title={change.kind === 'deleted' ? '文件已删除，可查看差异' : '打开文件'}
          aria-label={`打开文件 ${change.path}`}
          disabled={change.kind === 'deleted'}
        >
          <FileText size={15} aria-hidden="true" />
        </button>
    </li>
  );
}

function CheckRow({ check }: { readonly check: StoredCodeCheck }): ReactElement {
  return (
    <li className="code-result__check" data-status={check.status}>
      <span className="code-result__check-label">{check.label}</span>
      <span className="code-result__check-kind">({CHECK_LABEL[check.kind]})</span>
      <span className="code-result__check-status">{{ passed: '通过', failed: '失败', cancelled: '已取消' }[check.status]}</span>
    </li>
  );
}

export function CodeResultContent(props: CodeResultContentProps): ReactElement {
  const { result } = props;
  const runChanges = result.attribution === 'run_delta' ? result.changes : [];
  const isWorkspaceView = result.attribution === 'workspace_only';
  const changesLabel = isWorkspaceView ? '工作区变更' : props.historical ? '变更记录' : '本轮变更';
  const content = (isWorkspaceView ? result.changes : runChanges) ?? [];
  const changedPaths = new Set(content.map(change => change.path));
  const outputOnly = result.outputs?.filter(file => !changedPaths.has(file.path)) ?? [];

  return (
    <div className="code-result">
      {outputOnly.length > 0 && <section className="code-result__section" aria-label="成果文件">
        <h4 className="code-result__section-title">成果文件</h4>
        <ul className="code-result__changes">{outputOnly.map((file) => <li className="code-result__change code-result__change--output" key={file.path}>
          <button type="button" className="code-result__path" title={file.path} aria-label={`打开文件 ${file.path}`} onClick={() => props.onOpenFile(file.path)}><FileText size={16} aria-hidden="true" /><FileName path={file.path} /></button>
          <span className="code-result__badge">{file.change === 'created' ? '新增' : '更新'}</span>
        </li>)}</ul>
      </section>}
      {result.outputsIncomplete && <p className="code-result__notice">成果文件收集不完整，可通过文件树继续查看。</p>}
      {isWorkspaceView && (
        <p className="code-result__notice">
          当前目录无法精确归因到本轮，以下展示工作区现有变更。
        </p>
      )}
      {content.length > 0 && (
        <section className="code-result__section" aria-label={changesLabel}>
          <h4 className="code-result__section-title">
            {changesLabel}
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
        <section className="code-result__section" aria-label="检查结果">
          <h4 className="code-result__section-title">检查结果</h4>
          <ul className="code-result__checks">
            {result.checks.map((check) => (
              <CheckRow key={check.id} check={check} />
            ))}
          </ul>
        </section>
      )}
      {result.changes.length === 0 && result.checks.length === 0 && !result.outputs?.length && (
        <p className="code-result__empty">{props.historical
          ? '未记录到文件变更或检查结果。'
          : '本轮未记录到文件变更或检查结果。'}</p>
      )}
    </div>
  );
}
