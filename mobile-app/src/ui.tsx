import { isValidElement, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { IonIcon } from '@ionic/react';
import { checkmarkOutline, copyOutline, documentTextOutline, imageOutline, returnDownForwardOutline } from 'ionicons/icons';
import type { DirectAttachment } from './directChat';

export type UiLanguage = 'zh' | 'en';

export function uiText(language: UiLanguage, zh: string, en: string) {
  return language === 'en' ? en : zh;
}

export function formatChatTime(value: string | number, language: UiLanguage = 'zh') {
  if (typeof value === 'string') return value;
  return new Date(value).toLocaleTimeString(language === 'en' ? 'en-US' : 'zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function formatRecentTime(value: string | number, language: UiLanguage = 'zh') {
  if (typeof value === 'string') return value;
  const delta = Date.now() - value;
  if (delta < 60_000) return uiText(language, '刚刚', 'Just now');
  if (delta < 3_600_000) return uiText(language, `${Math.max(1, Math.floor(delta / 60_000))} 分钟前`, `${Math.max(1, Math.floor(delta / 60_000))} min ago`);
  if (delta < 86_400_000) return uiText(language, `${Math.max(1, Math.floor(delta / 3_600_000))} 小时前`, `${Math.max(1, Math.floor(delta / 3_600_000))} hr ago`);
  return new Date(value).toLocaleDateString(language === 'en' ? 'en-US' : 'zh-CN', { month: 'short', day: 'numeric' });
}

export function BrandMark({ small = false }: { small?: boolean }) {
  return (
    <div className={`brand-mark${small ? ' brand-mark--small' : ''}`} aria-label="Trylo">
      <svg viewBox="0 0 1024 1024" fill="none" aria-hidden="true">
        <path d="M462 236 L462 420 L624 420" />
        <path d="M276 732 L424 644 L356 512" />
        <path d="M540 676 L622 546 L786 640" />
      </svg>
    </div>
  );
}

export function EmptyState({ icon, title, detail }: { icon: string; title: string; detail: string }) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon"><IonIcon icon={icon} /></div>
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}

const CODE_LANGUAGE_LABELS: Record<string, string> = {
  js: 'JavaScript', jsx: 'JSX', ts: 'TypeScript', tsx: 'TSX', json: 'JSON',
  py: 'Python', python: 'Python', java: 'Java', kt: 'Kotlin', go: 'Go',
  rs: 'Rust', c: 'C', cpp: 'C++', cs: 'C#', php: 'PHP', rb: 'Ruby',
  swift: 'Swift', sql: 'SQL', sh: 'Shell', bash: 'Bash', zsh: 'Shell',
  ps1: 'PowerShell', powershell: 'PowerShell', yaml: 'YAML', yml: 'YAML',
  html: 'HTML', css: 'CSS', scss: 'SCSS', md: 'Markdown', diff: 'Diff',
  xml: 'XML', toml: 'TOML', ini: 'INI', dockerfile: 'Dockerfile',
};

/**
 * Copies text with a fallback for WebViews where the async Clipboard API is
 * unavailable or permission-denied (non-secure contexts, older Android System
 * WebView). Returns whether the text actually made it to the clipboard so the
 * caller can avoid showing a false "Copied" confirmation.
 */
async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path below.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    // Keep it out of view but still selectable, which execCommand requires.
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export function CodeBlock({ children, className = '', language = 'zh' }: { children?: ReactNode; className?: string; language?: UiLanguage }) {
  const [copied, setCopied] = useState(false);
  const [wrapped, setWrapped] = useState(false);
  const text = String(children ?? '').replace(/\n$/, '');
  const rawLanguage = /language-([^\s]+)/.exec(className)?.[1]?.toLowerCase() || '';
  const codeLanguage = CODE_LANGUAGE_LABELS[rawLanguage] || rawLanguage || uiText(language, '代码', 'code');
  const lineCount = text ? text.split('\n').length : 0;
  // Only long snippets benefit from a wrap toggle; short ones stay simple.
  const canWrap = text.split('\n').some(line => line.length > 42);

  const copy = async () => {
    // Clipboard can be denied inside the WebView; only confirm on success.
    if (!(await copyText(text))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-head">
        <span className="markdown-code-lang">{codeLanguage}</span>
        {lineCount > 1 && (
          <span className="markdown-code-lines">{lineCount} {uiText(language, '行', 'lines')}</span>
        )}
        <div className="markdown-code-tools">
          {canWrap && (
            <button
              type="button"
              className={wrapped ? 'is-active' : ''}
              aria-pressed={wrapped}
              onClick={() => setWrapped(value => !value)}
            >
              <IonIcon icon={returnDownForwardOutline} />
              {wrapped ? uiText(language, '不换行', 'No wrap') : uiText(language, '换行', 'Wrap')}
            </button>
          )}
          <button type="button" onClick={copy}>
            <IonIcon icon={copied ? checkmarkOutline : copyOutline} />
            {copied ? uiText(language, '已复制', 'Copied') : uiText(language, '复制', 'Copy')}
          </button>
        </div>
      </div>
      <pre className={wrapped ? 'is-wrapped' : ''}><code className={className}>{children}</code></pre>
    </div>
  );
}

/**
 * Rebuilds Markdown source from a rendered table so it can be copied back out.
 * Reading the DOM avoids threading the original AST through the renderer, and
 * keeps the output pasteable into any Markdown editor.
 */
function tableToMarkdown(table: HTMLTableElement | null): string {
  if (!table) return '';
  const rows = Array.from(table.querySelectorAll('tr'));
  if (!rows.length) return '';
  const cellsOf = (row: HTMLTableRowElement) =>
    Array.from(row.querySelectorAll('th,td')).map(cell =>
      // Escape pipes so a cell containing "|" cannot break the column layout.
      (cell.textContent || '').trim().replace(/\|/g, '\\|'),
    );

  const lines: string[] = [];
  const header = cellsOf(rows[0]);
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`| ${header.map(() => '---').join(' | ')} |`);
  for (const row of rows.slice(1)) {
    const cells = cellsOf(row);
    if (cells.length) lines.push(`| ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

/**
 * Markdown tables overflow the chat bubble on phones, so they get a horizontal
 * scroller plus an edge fade and a swipe hint that only appear while columns
 * remain off-screen, and a copy button that reproduces the Markdown source.
 * Column alignment is left to react-markdown, which already turns GFM's
 * `align` into an inline `text-align` style.
 */
function MarkdownTable({ children, language }: { children?: ReactNode; language: UiLanguage }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [atEnd, setAtEnd] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      const scrollable = el.scrollWidth - el.clientWidth;
      setOverflowing(scrollable > 4);
      setAtEnd(scrollable <= 4 || el.scrollLeft >= scrollable - 4);
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      observer.disconnect();
    };
  }, [children]);

  const copy = async () => {
    const markdown = tableToMarkdown(tableRef.current);
    if (!markdown) return;
    // Only flip the label once the text is really on the clipboard.
    if (!(await copyText(markdown))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className={`markdown-table-wrap${overflowing && !atEnd ? ' has-more' : ''}`}>
      <div className="markdown-table-toolbar">
        <span className="markdown-table-label">{uiText(language, '表格', 'Table')}</span>
        <button type="button" className={`markdown-table-copy${copied ? ' is-copied' : ''}`} onClick={() => void copy()}>
          <IonIcon icon={copied ? checkmarkOutline : copyOutline} />
          {copied ? uiText(language, '已复制', 'Copied') : uiText(language, '复制', 'Copy')}
        </button>
      </div>
      <div className="markdown-table-shell">
      <div className="markdown-table-scroll" ref={scrollRef}>
        <table ref={tableRef}>{children}</table>
      </div>
      </div>
      {overflowing && (
        <span className="markdown-table-hint">{uiText(language, '← 左右滑动查看完整表格 →', '← Swipe to see the full table →')}</span>
      )}
    </div>
  );
}

/**
 * Detects tables and fenced code blocks so the caller can widen the bubble.
 * CSS `:has()` covers this too, but older Android System WebView builds ignore
 * it, so callers get an explicit class instead of silently cramped layouts.
 */
export function hasWideMarkdownBlock(text: string): boolean {
  if (!text) return false;
  if (/(^|\n)\s*```/.test(text)) return true;
  if (/(^|\n)\s{0,3}\|.*\|/.test(text)) return true;
  return false;
}

/**
 * Renders the attachments attached to a message. Images show the stored
 * thumbnail; text files show a compact file chip. Tapping an image opens it
 * full-screen via the caller-provided handler.
 */
export function AttachmentStrip({
  attachments,
  language = 'zh',
  onOpenImage,
}: {
  attachments: DirectAttachment[];
  language?: UiLanguage;
  onOpenImage?: (attachment: DirectAttachment) => void;
}) {
  if (!attachments.length) return null;
  const images = attachments.filter(item => item.kind === 'image');
  const files = attachments.filter(item => item.kind !== 'image');

  return (
    <div className="attachment-strip">
      {images.length > 0 && (
        <div className={`attachment-images${images.length === 1 ? ' is-single' : ''}`}>
          {images.map(image => (
            <button
              type="button"
              key={image.id}
              className="attachment-thumb"
              onClick={() => onOpenImage?.(image)}
              aria-label={uiText(language, `查看图片 ${image.name}`, `View image ${image.name}`)}
            >
              {image.dataUrl
                ? <img src={image.dataUrl} alt={image.name} loading="lazy" />
                : <span className="attachment-thumb__missing"><IonIcon icon={imageOutline} /></span>}
            </button>
          ))}
        </div>
      )}
      {files.map(file => (
        <div className="attachment-file" key={file.id}>
          <IonIcon icon={documentTextOutline} />
          <span className="attachment-file__name">{file.name}</span>
          <span className="attachment-file__size">{formatBytes(file.size)}</span>
        </div>
      ))}
    </div>
  );
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function MarkdownMessage({ text, language = 'zh' }: { text: string; language?: UiLanguage }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        urlTransform={url => {
          try {
            const parsed = new URL(url);
            return parsed.protocol === 'https:' ? parsed.href : '';
          } catch {
            return '';
          }
        }}
        components={{
          pre: ({ children }) => {
            const child = isValidElement<{ children?: ReactNode; className?: string }>(children) ? children : null;
            return <CodeBlock className={child?.props.className} language={language}>{child?.props.children ?? children}</CodeBlock>;
          },
          // GFM column alignment already arrives as an inline `style` from
          // react-markdown, so cells only need the scroll wrapper here.
          table: ({ children }) => <MarkdownTable language={language}>{children}</MarkdownTable>,
          a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
