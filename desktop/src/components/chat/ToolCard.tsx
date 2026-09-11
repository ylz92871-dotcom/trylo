// Trylo Desktop — ToolCard.
//
// v1.15.8.c: re-style. Borrowed the bones from cline's
// ChatRow + CommandOutputRow: a single substantial row
// header, a clear status pill on the right, an
// expanded body with input / output / diff. Running
// tools get a brand-color border so the user can see
// "this is still working" at a glance.
//
// v1.16.5+ (Code-Work workflow sync spec §7.2): a running
// tool carries exactly ONE loop animation — the status
// Loader spinner. The old border pulse and the tool-icon
// rotation are gone, so a single card never shows three
// concurrent loops.
//
// v1.15.9.b: while the tool is running, the status
// pill shows a verb specific to the tool kind
// ("Reading…", "Running…", "Searching…", etc.) instead
// of the generic "running" — addresses the "中间我
// 就根本不知道他在干什么" complaint.

import { useState, type ReactElement, type ReactNode } from 'react';
import { ChevronRight, Loader2, CheckCircle2, XCircle, Ban, Terminal, FileEdit, FileText, Globe, ListTree, Search, FileSearch, Paperclip, Braces, FileWarning, UploadCloud, type LucideIcon } from 'lucide-react';
import type { ToolMessage } from './types';
import type { BinaryRef, ToolResultContent } from '../../tooling/tool-result-content';
import { openCachedToolResource, useBinaryRefObjectUrl } from '../../tooling/tool-result-store';

export interface ToolCardProps {
  readonly message: ToolMessage;
  /** PR-3 遗留收口 (§6.5/§7.3): promote one of the conversation's runtime
   *  artifacts into `.trylo/out`. The HOST supplies the conversation scope
   *  (projectRoot + conversationId); the card only proposes the file name it
   *  can see in its own result text. Absent → no promote affordance. */
  readonly onPromoteRuntimeArtifact?: (
    packageId: string,
    fileName: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Open one cached binary resource with the OS default app (PR-4 偏差②
   *  收口, §7.2 「打开」按钮). Defaults to the store's Tauri-backed helper;
   *  injected for tests. The path is containment-checked twice (store +
   *  Rust gate) before anything opens. */
  readonly onOpenCachedResource?: (ref: BinaryRef) => Promise<{ ok: boolean; error?: string }>;
}

/** MCP server → catalog package id (§8.2 runtime-dir resolution). */
const SERVER_PACKAGE_BY_PREFIX: readonly { readonly prefix: string; readonly packageId: string }[] = [
  { prefix: 'mcp__trylo-browser__', packageId: 'playwright' },
  { prefix: 'mcp__trylo-windows__', packageId: 'windows-mcp' },
  { prefix: 'mcp__trylo-office__', packageId: 'officecli' },
  // CAD/EDA adapters (TRYLO-CAD-EDA-TOOL-ADAPTER §8): export/制造 outputs
  // under the conversation runtime dir get the same promote affordance.
  { prefix: 'mcp__trylo-solidworks__', packageId: 'solidworks-mcp' },
  { prefix: 'mcp__trylo-autocad__', packageId: 'autocad-mcp' },
  { prefix: 'mcp__trylo-kicad__', packageId: 'kicad-mcp' },
  { prefix: 'mcp__trylo-jlceda__', packageId: 'jlceda-mcp' },
  { prefix: 'mcp__trylo-freecad__', packageId: 'freecad-mcp' },
  { prefix: 'mcp__trylo-blender__', packageId: 'blender-mcp' },
];

function packageIdOfTool(tool: string): string | null {
  for (const entry of SERVER_PACKAGE_BY_PREFIX) {
    if (tool.startsWith(entry.prefix)) return entry.packageId;
  }
  return null;
}

/** The pinned playwright-mcp prints every auto-attachment (screenshots,
 *  page snapshots, PDFs, downloads) as a project-root-relative path under
 *  `.trylo/runtime/…` — markdown links for files, a quoted path for
 *  downloads. This parses BOTH shapes so the promote button can propose the
 *  exact file the server wrote into the conversation's runtime temp dir. */
const RUNTIME_PATH_RE = /\[[^\]]*\]\((\.trylo[\\/][^)\s]+)\)|to "(\.trylo[\\/][^"]+)"/g;

export interface RuntimeArtifactCandidate {
  /** File name relative to the conversation's runtime dir (the promoter's
   *  `fileName` vocabulary — a flat basename for every pinned surface). */
  readonly fileName: string;
  /** Path as printed in the result text (verbatim, for the title tip). */
  readonly display: string;
}

export function runtimeArtifactsOf(outputText: string | undefined): readonly RuntimeArtifactCandidate[] {
  if (!outputText) return [];
  const out: RuntimeArtifactCandidate[] = [];
  const seen = new Set<string>();
  for (const match of outputText.matchAll(RUNTIME_PATH_RE)) {
    const display = (match[1] ?? match[2] ?? '').replace(/\\/g, '/');
    if (display === '') continue;
    const segments = display.split('/').filter((s) => s !== '' && s !== '.');
    // `.trylo/runtime/<dirName>/<conversationId>/<file>` — at minimum the
    // runtime root, the conversation dir and the file must be present, and
    // no segment may be `..` (the promoter would refuse anyway).
    if (segments.length < 5 || segments.includes('..')) continue;
    const fileName = segments[segments.length - 1]!;
    if (fileName === '' || seen.has(fileName)) continue;
    seen.add(fileName);
    out.push({ fileName, display });
    if (out.length >= 6) break;
  }
  return out;
}

const TOOL_META: Record<string, { label: string; Icon: LucideIcon; tone: 'bash' | 'fs' | 'web' | 'other' }> = {
  bash:     { label: 'Bash',  Icon: Terminal,    tone: 'bash' },
  read:     { label: 'Read',  Icon: FileText,    tone: 'fs' },
  edit:     { label: 'Edit',  Icon: FileEdit,    tone: 'fs' },
  write:    { label: 'Write', Icon: FileEdit,    tone: 'fs' },
  grep:     { label: 'Grep',  Icon: Search,      tone: 'fs' },
  glob:     { label: 'Glob',  Icon: ListTree,     tone: 'fs' },
  webfetch: { label: 'Web',   Icon: Globe,        tone: 'web' },
  websearch:{ label: 'Web',   Icon: FileSearch,   tone: 'web' },
  todo_write:{ label: 'Todo', Icon: ListTree,     tone: 'other' },
};

function toolMeta(name: string): { label: string; Icon: LucideIcon } {
  const m = TOOL_META[name];
  if (m) return m;
  return { label: name || 'tool', Icon: Terminal };
}

const STATUS_ICON: Record<ToolMessage['status'], LucideIcon> = {
  running: Loader2,
  done: CheckCircle2,
  error: XCircle,
  pending: Loader2,
  // The run ended while this invocation was still going
  // (M3 closure spec §6.2) — neutral, NOT a tool failure.
  interrupted: Ban,
};

function statusLabel(s: ToolMessage['status']): string {
  if (s === 'done') return 'done';
  if (s === 'error') return 'failed';
  if (s === 'running') return 'running';
  if (s === 'interrupted') return 'interrupted';
  return 'pending';
}

// v1.15.9.b: verb shown in the status pill while the
// tool is running. Makes the "still working" state
// informative — "Reading src/foo.ts…" is much clearer
// than just "running". Keys match the PascalCase tool
// names emitted by the events stream (per
// the CLI event vocabulary spec).
const ACTIVITY_VERB: Record<string, string> = {
  Bash:      'Running',
  Read:      'Reading',
  Edit:      'Editing',
  Write:     'Writing',
  Grep:      'Searching',
  Glob:      'Listing',
  WebFetch:  'Fetching',
  WebSearch: 'Searching',
  TodoWrite: 'Updating',
};

function activityLabel(tool: string): string {
  return ACTIVITY_VERB[tool] ?? 'Running';
}

export function ToolCard(props: ToolCardProps): ReactElement {
  const m = props.message;
  // v1.15.8.c: separate "the user manually opened this
  // card" from "the card's auto behaviour based on
  // status". The previous useState(defaultOpen) only
  // captured the value at mount time, so when the CLI
  // sent tool_result and status flipped from 'running'
  // to 'done', the card stayed expanded — the body kept
  // showing input/output. The user explicitly asked
  // for tools to "fold back" after they finish, so we
  // now derive `open` from status by default, and only
  // remember the user's manual click.
  const [userOverride, setUserOverride] = useState<boolean | null>(null);
  const open = userOverride ?? (m.status === 'running');
  const onToggle = (): void => {
    setUserOverride((prev) =>
      prev === null ? !(m.status === 'running') : !prev,
    );
  };

  const meta = toolMeta(m.tool);
  const StatusIcon = STATUS_ICON[m.status];

  return (
    <div
      className={`tool tool--${m.status} tool-tone-${TOOL_META[m.tool]?.tone ?? 'other'}`}
      role="listitem"
    >
      <button
        type="button"
        className={`tool__head${!open ? ' tool__head--collapsed' : ''}`}
        onClick={onToggle}
        aria-expanded={open}
      >
        <span
          className={`tool__chevron disclosure-chevron${open ? ' disclosure-chevron--open' : ''}`}
          aria-hidden="true"
        >
          <ChevronRight size={12} strokeWidth={2.4} />
        </span>
        <span className="tool__icon" aria-hidden="true">
          <meta.Icon size={14} strokeWidth={2.2} />
        </span>
        <span className="tool__name">{meta.label}</span>
        <span className="tool__summary">{m.summary || '…'}</span>
        {m.durationMs !== undefined && (
          <span className="tool__time">{(m.durationMs / 1000).toFixed(1)}s</span>
        )}
        <span className="tool__status">
          <StatusIcon
            size={12}
            strokeWidth={2.4}
            className={m.status === 'running' ? 'tool__status-icon--spin' : undefined}
          />
          <span>
            {m.status === 'running'
              ? `${activityLabel(m.tool)}…`
              : statusLabel(m.status)}
          </span>
        </span>
      </button>
      {/* v1.16.5+ (spec §7.4): body stays mounted; the
          shared `.disclosure` grid row animates 0fr→1fr so
          running→expanded and done→collapsed are smooth
          height+opacity transitions, not instant mounts. */}
      <div className={`disclosure${open ? ' disclosure--open' : ''}`}>
        <div className="disclosure__inner">
          <ToolCardBody message={m} card={props} />
        </div>
      </div>
    </div>
  );
}

function isBrowserTool(tool: string): boolean {
  return tool.startsWith('mcp__trylo-browser__') || tool.startsWith('mcp__trylo-playwright__');
}
function isOfficeTool(tool: string): boolean {
  return tool.startsWith('mcp__trylo-office__');
}
function isComputerTool(tool: string): boolean {
  return tool.startsWith('mcp__trylo-windows__');
}
function isCadTool(tool: string): boolean {
  return (
    tool.startsWith('mcp__trylo-solidworks__') ||
    tool.startsWith('mcp__trylo-autocad__') ||
    tool.startsWith('mcp__trylo-kicad__') ||
    tool.startsWith('mcp__trylo-jlceda__') ||
    tool.startsWith('mcp__trylo-freecad__') ||
    tool.startsWith('mcp__trylo-blender__')
  );
}

function ToolCardBody(props: { message: ToolMessage; card: ToolCardProps }): ReactElement {
  const m = props.message;
  // The affordance exists ONLY for the managed MCP tools whose servers
  // actually write the runtime temp dir (§8.2). A Bash `ls` that happens to
  // print a `.trylo/runtime/…` path must never grow a promote button.
  const packageId = packageIdOfTool(m.tool);
  const runtimeArtifacts = packageId !== null && m.status === 'done'
    ? runtimeArtifactsOf(m.outputText)
    : [];
  return (
    <div className="tool__body">
      <Field label="status">
        <span>{statusLabel(m.status)}</span>
        {m.durationMs !== undefined && (
          <span className="tool__row-extra"> · {(m.durationMs / 1000).toFixed(1)}s</span>
        )}
      </Field>
      {m.input !== undefined && (
        <Field label="input">
          <ToolInput tool={m.tool} input={m.input} />
        </Field>
      )}
      {m.tool === 'edit' && typeof m.input === 'object' && m.input !== null && (
        <Field label="diff">
          <ToolDiff input={m.input as Record<string, string>} />
        </Field>
      )}
      {/* PR-4 (spec §7.2): rich content blocks when present — thumbnails,
          resources, structured summaries. The collapsed text view falls
          back to `outputText` (old sessions migrated on history load). */}
      {m.outputContent !== undefined && m.outputContent.length > 0 ? (
        <Field label={m.outputError ? 'error' : 'output'}>
          <ToolResultBlocks blocks={m.outputContent} onOpen={props.card.onOpenCachedResource} />
        </Field>
      ) : (m.outputText !== undefined || m.outputError !== undefined) && (
        <Field label={m.outputError ? 'error' : 'output'}>
          <pre className={`tool__code ${m.outputError ? 'tool__code--err' : ''}`}>
            {m.outputError ?? m.outputText ?? ''}
          </pre>
        </Field>
      )}
      {/* PR-3 遗留收口 (§6.5/§7.3): the runtime temp files this result
          references get an explicit promote affordance — process results
          become deliverables only through the user's click (the card never
          promotes on its own), and the sidecar promoter does the copy. */}
      {props.card.onPromoteRuntimeArtifact && packageId !== null && runtimeArtifacts.length > 0 && (
        <Field label="交付">
          <div className="tool__promote-list">
            {runtimeArtifacts.map((artifact) => (
              <PromoteRuntimeArtifactButton
                key={artifact.fileName}
                packageId={packageId}
                artifact={artifact}
                onPromote={props.card.onPromoteRuntimeArtifact!}
              />
            ))}
          </div>
        </Field>
      )}
      {/* Office / Browser / 电脑控制 workflow hint — same mono xs language, no spinner */}
      {isOfficeTool(m.tool) && (
        <Field label="Office">
          <span className="tool__muted">受控 Office 会话 · 写入仅到 .trylo/out/ · 原件不受影响</span>
        </Field>
      )}
      {isBrowserTool(m.tool) && (
        <Field label="浏览器">
          <span className="tool__muted">受控浏览器会话 · 不使用本机登录态 · 下载仅到 .trylo/out/</span>
          <button
            type="button"
            className="tool__promote"
            style={{ marginLeft: 8 }}
            onClick={() => window.dispatchEvent(new CustomEvent('trylo:open-browser-preview'))}
          >
            打开浏览器预览
          </button>
        </Field>
      )}
      {isComputerTool(m.tool) && (
        <Field label="电脑控制">
          <span className="tool__muted">白名单 11 工具 · 截图 1920×1080 上限 · 不持久化 · WatchDog 关闭</span>
        </Field>
      )}
      {isCadTool(m.tool) && (
        <Field label="CAD/EDA">
          <span className="tool__muted">受控 CAD/EDA 适配器 · 查询/导出自动 · 删除与任意代码执行逐次审批</span>
        </Field>
      )}
    </div>
  );
}

// ── PR-4 (spec §7.2): rich tool-result rendering ──────────────────────

function ToolResultBlocks(props: {
  blocks: readonly ToolResultContent[];
  onOpen?: (ref: BinaryRef) => Promise<{ ok: boolean; error?: string }>;
}): ReactElement {
  return (
    <div className="tool__result-blocks">
      {props.blocks.map((block, i) => (
        <ToolResultBlock key={i} block={block} onOpen={props.onOpen} />
      ))}
    </div>
  );
}

function ToolResultBlock(props: { block: ToolResultContent; onOpen?: (ref: BinaryRef) => Promise<{ ok: boolean; error?: string }> }): ReactElement {
  const block = props.block;
  switch (block.type) {
    case 'text':
      return <pre className="tool__code">{block.text}</pre>;
    case 'image':
      return <ToolImageBlock refMeta={block.ref} alt={block.alt} />;
    case 'audio':
      return <ToolAudioBlock refMeta={block.ref} />;
    case 'resource':
      return <ToolResourceBlock block={block} onOpen={props.onOpen} />;
    case 'resource_link':
      return (
        <div className="tool__result-ref">
          <Paperclip size={13} strokeWidth={2} aria-hidden="true" />
          <span className="tool__result-ref-name">{block.name}</span>
          <span className="tool__result-ref-meta">{block.uri}</span>
        </div>
      );
    case 'structured':
      return <ToolStructuredBlock value={block.value} schema={block.schema} />;
    default:
      return <pre className="tool__code tool__code--err">[unsupported content]</pre>;
  }
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** Image thumbnail (§7.1: MIME whitelist + size cap are enforced by the
 *  store's read path; an expired / missing / foreign file renders the
 *  safe placeholder, never a broken image and never raw bytes). */
function ToolImageBlock(props: { refMeta: BinaryRef; alt?: string }): ReactElement {
  const { url, failed } = useBinaryRefObjectUrl(props.refMeta);
  if (url) {
    return (
      <figure className="tool__result-image">
        <img src={url} alt={props.alt ?? 'tool result image'} loading="lazy" />
        <figcaption className="tool__result-ref-meta">
          {props.refMeta.mimeType} · {formatBytes(props.refMeta.size)}
        </figcaption>
      </figure>
    );
  }
  return <ToolUnavailablePlaceholder kind="图片" refMeta={props.refMeta} failed={failed} />;
}

function ToolAudioBlock(props: { refMeta: BinaryRef }): ReactElement {
  const { url, failed } = useBinaryRefObjectUrl(props.refMeta);
  if (url) {
    return (
      <figure className="tool__result-audio">
        <audio controls src={url} preload="none" />
        <figcaption className="tool__result-ref-meta">
          {props.refMeta.mimeType} · {formatBytes(props.refMeta.size)}
        </figcaption>
      </figure>
    );
  }
  return <ToolUnavailablePlaceholder kind="音频" refMeta={props.refMeta} failed={failed} />;
}

/** Expired cache / unreadable file placeholder — metadata (size, hash
 *  date) survives in the session record, the bytes do not (§7.1). */
function ToolUnavailablePlaceholder(props: { kind: string; refMeta: BinaryRef; failed: boolean }): ReactElement {
  return (
    <div className="tool__result-expired" title={props.refMeta.path}>
      <FileWarning size={14} strokeWidth={2} aria-hidden="true" />
      <span>
        {props.kind}
        {props.failed ? ' 已过期或不可用' : ' 加载中…'}（{formatBytes(props.refMeta.size)}）
      </span>
    </div>
  );
}

/** Embedded resource: text-backed resources render inline; binary-backed
 *  ones render as a file chip (metadata only — the temp copy is claimed
 *  by the Artifact Promoter, §7.3 过程结果不冒充交付物). The PR-4 偏差②
 *  「打开」button opens the CACHED binary copy with the OS default app —
 *  user-driven, containment-checked in the store AND the Rust gate
 *  (§7.1: URIs are never auto-opened; only cache-contained refs qualify). */
function ToolResourceBlock(props: { block: Extract<ToolResultContent, { type: 'resource' }>; onOpen?: (ref: BinaryRef) => Promise<{ ok: boolean; error?: string }> }): ReactElement {
  const block = props.block;
  const text = block.text;
  return (
    <div className="tool__result-ref">
      <Paperclip size={13} strokeWidth={2} aria-hidden="true" />
      <div className="tool__result-ref-body">
        <span className="tool__result-ref-name">{block.uri}</span>
        {block.mimeType !== undefined && (
          <span className="tool__result-ref-meta">{block.mimeType}</span>
        )}
        {block.ref !== undefined && (
          <span className="tool__result-ref-meta">
            {formatBytes(block.ref.size)} · 临时资源（经 Artifact Promoter 提升后成为交付物）
          </span>
        )}
        {text !== undefined && text !== '' && (
          <pre className="tool__code">{text.length > 2000 ? `${text.slice(0, 2000)}\n…` : text}</pre>
        )}
        {block.ref !== undefined && (
          <OpenCachedResourceButton
            refMeta={block.ref}
            onOpen={props.onOpen ?? openCachedToolResource}
          />
        )}
      </div>
    </div>
  );
}

/** The 「打开」 affordance on a binary-backed resource chip. State machine:
 *  idle → busy → done (no visible change) or failed (inline reason). */
function OpenCachedResourceButton(props: {
  refMeta: BinaryRef;
  onOpen: (ref: BinaryRef) => Promise<{ ok: boolean; error?: string }>;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onOpen = (): void => {
    setBusy(true);
    setError(null);
    props
      .onOpen(props.refMeta)
      .then((result) => {
        if (!result.ok) setError(result.error ?? '打开失败');
      })
      .catch(() => setError('打开失败'))
      .finally(() => setBusy(false));
  };
  return (
    <span className="tool__result-actions">
      <button
        type="button"
        className="tool__promote"
        onClick={onOpen}
        disabled={busy}
        title={props.refMeta.path}
      >
        打开
      </button>
      {error !== null && <span className="tool__promote-error">{error}</span>}
    </span>
  );
}

/** One runtime-temp artifact → `.trylo/out`. The explicit, user-driven
 *  promotion (§7.3): idle → busy → 已提升 / 失败, never automatic. */
function PromoteRuntimeArtifactButton(props: {
  packageId: string;
  artifact: RuntimeArtifactCandidate;
  onPromote: (packageId: string, fileName: string) => Promise<{ ok: boolean; error?: string }>;
}): ReactElement {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const onPromote = (): void => {
    setState('busy');
    setError(null);
    props
      .onPromote(props.packageId, props.artifact.fileName)
      .then((result) => {
        if (result.ok) setState('done');
        else {
          setState('failed');
          setError(result.error ?? '提升失败');
        }
      })
      .catch(() => {
        setState('failed');
        setError('提升失败');
      });
  };
  const label = state === 'done' ? '已提升' : state === 'busy' ? '提升中…' : '提升为交付物';
  return (
    <span className="tool__promote-row" title={props.artifact.display}>
      <button
        type="button"
        className="tool__promote"
        onClick={onPromote}
        disabled={state === 'busy' || state === 'done'}
      >
        {state === 'done'
          ? <CheckCircle2 size={12} strokeWidth={2.2} aria-hidden="true" />
          : <UploadCloud size={12} strokeWidth={2.2} aria-hidden="true" />}
        <span>{label}</span>
      </button>
      <span className="tool__promote-name">{props.artifact.fileName}</span>
      {error !== null && <span className="tool__promote-error">{error}</span>}
    </span>
  );
}

/** Structured content: collapsed by default (§7.2 折叠 JSON/摘要). */
function ToolStructuredBlock(props: { value: unknown; schema?: string }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="tool__result-structured">
      <button type="button" className="tool__result-structured-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Braces size={13} strokeWidth={2} aria-hidden="true" />
        <span>structured result</span>
        {props.schema !== undefined && (
          <span className="tool__result-ref-meta">{props.schema}</span>
        )}
        <ChevronRight size={12} strokeWidth={2.4} className={open ? 'disclosure-chevron--open' : undefined} aria-hidden="true" />
      </button>
      {open && (
        <pre className="tool__code tool__code--json">
          {JSON.stringify(props.value, null, 2).slice(0, 4000)}
        </pre>
      )}
    </div>
  );
}

function Field(props: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="tool__row-block">
      <span className="tool__row-key">{props.label}</span>
      <div className="tool__row-value">{props.children}</div>
    </div>
  );
}

function ToolInput(props: { tool: string; input: unknown }): ReactElement {
  const input = props.input;
  if (input === undefined) {
    return <span className="tool__muted">(no input)</span>;
  }
  if (props.tool === 'Bash' && typeof input === 'object' && input !== null) {
    const cmd = (input as Record<string, unknown>)['command'];
    if (typeof cmd === 'string') {
      return <pre className="tool__code tool__code--bash">{cmd}</pre>;
    }
  }
  if ((props.tool === 'Read' || props.tool === 'Write' || props.tool === 'Edit' || props.tool === 'Glob') &&
      typeof input === 'object' && input !== null) {
    const obj = input as Record<string, unknown>;
    const path = obj['file_path'] ?? obj['path'];
    if (typeof path === 'string') {
      return <code className="tool__inline">{path}</code>;
    }
  }
  if (props.tool === 'Grep' && typeof input === 'object' && input !== null) {
    const obj = input as Record<string, unknown>;
    return (
      <span className="tool__inline">
        pattern <code>{String(obj['pattern'] ?? '?')}</code> in <code>{String(obj['path'] ?? '?')}</code>
      </span>
    );
  }
  return (
    <pre className="tool__code tool__code--json">
      {JSON.stringify(input, null, 2)}
    </pre>
  );
}

function ToolDiff(props: { input: Record<string, string> }): ReactElement {
  const oldStr = String(props.input['old_string'] ?? '');
  const newStr = String(props.input['new_string'] ?? '');
  return (
    <div className="tool__diff">
      {oldStr && (
        <pre className="tool__diff-old">
          {oldStr.split('\n').map((line, i) => (
            <div key={`o${i}`} className="tool__diff-line tool__diff-line--del">- {line}</div>
          ))}
        </pre>
      )}
      {newStr && (
        <pre className="tool__diff-new">
          {newStr.split('\n').map((line, i) => (
            <div key={`n${i}`} className="tool__diff-line tool__diff-line--add">+ {line}</div>
          ))}
        </pre>
      )}
    </div>
  );
}
