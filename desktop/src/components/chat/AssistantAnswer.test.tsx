import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AssistantAnswer } from './AssistantAnswer';

afterEach(cleanup);

describe('assistant inline file references', () => {
  it('shows a short name while preserving its complete accessible path and open target', () => {
    const open = vi.fn();
    render(<AssistantAnswer text={'查看 `desktop\\src\\SkillsModal.tsx`。'} onOpenArtifact={open} />);
    const file = screen.getByRole('button', { name: 'desktop\\src\\SkillsModal.tsx' });
    expect(file.textContent).toBe('SkillsModal.tsx');
    expect(file.getAttribute('title')).toBe('在右侧打开 desktop\\src\\SkillsModal.tsx');
    fireEvent.click(file);
    expect(open).toHaveBeenCalledWith('desktop/src/SkillsModal.tsx');
  });

  it('uses the shortest distinct directory suffix for same-name files', () => {
    render(<AssistantAnswer text={'`src/server/routes/index.ts`、`tests/server/routes/index.ts`、`other/index.ts`。'} onOpenArtifact={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'src/server/routes/index.ts' }).textContent).toBe('index.ts· src/server/routes');
    expect(screen.getByRole('button', { name: 'tests/server/routes/index.ts' }).textContent).toBe('index.ts· tests/server/routes');
    expect(screen.getByRole('button', { name: 'other/index.ts' }).textContent).toBe('index.ts· other');
  });

  it('does not add directory noise to repeated mentions of the same file', () => {
    render(<AssistantAnswer text={'`src/report.md` 和 `src\\report.md`。'} onOpenArtifact={vi.fn()} />);
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['report.md', 'report.md']);
  });

  it('does not claim a bare basename has a known directory', () => {
    render(<AssistantAnswer text={'`report.md` 和 `drafts/report.md`。'} onOpenArtifact={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'report.md' }).textContent).toBe('report.md· 目录未注明');
    expect(screen.getByRole('button', { name: 'drafts/report.md' }).textContent).toBe('report.md· drafts');
  });

  it('keeps a Markdown file link a single link even when its caption is inline code', () => {
    const open = vi.fn();
    const { container } = render(<AssistantAnswer text={'[`src/report.md`](src/report.md)'} onOpenArtifact={open} />);
    const file = screen.getByRole('link', { name: 'src/report.md' });
    expect(file.textContent).toBe('report.md');
    expect(container.querySelector('a button')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    fireEvent.click(file);
    expect(open).toHaveBeenCalledWith('src/report.md');
  });

  it('preserves authored captions and opens a decoded Markdown path', () => {
    const open = vi.fn();
    render(<AssistantAnswer text={'[**设计说明**](docs/%E8%AE%BE%E8%AE%A1%20%E8%AF%B4%E6%98%8E.md)'} onOpenArtifact={open} />);
    const file = screen.getByRole('link', { name: '设计说明' });
    expect(file.querySelector('strong')?.textContent).toBe('设计说明');
    fireEvent.click(file);
    expect(open).toHaveBeenCalledWith('docs/设计 说明.md');
  });

  it('disambiguates inline-code and Markdown references together', () => {
    render(<AssistantAnswer text={'`src/index.ts` 和 [index.ts](tests/index.ts)'} onOpenArtifact={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'src/index.ts' }).textContent).toBe('index.ts· src');
    expect(screen.getByRole('link', { name: 'index.ts' }).textContent).toBe('index.ts· tests');
  });

  it('keeps file-looking paths inside fenced code blocks as copyable code', () => {
    const { container } = render(<AssistantAnswer text={'```text\nsrc/panel.tsx\n```\n\n```\ndocs/report.md\n```'} onOpenArtifact={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.querySelectorAll('pre code')).toHaveLength(2);
    expect(container.querySelector('pre code')?.className).toBe('language-text');
    expect(container.textContent).toContain('src/panel.tsx');
  });

  it('keeps ordinary commands and code-formatted web URLs as code', () => {
    const { container } = render(<AssistantAnswer text={'`tsc --noEmit`，`cd /d`，`https://example.com/report.pdf`。'} onOpenArtifact={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.querySelectorAll('code')).toHaveLength(3);
  });

  it('keeps ordinary web links and fragment navigation as links', () => {
    render(<AssistantAnswer text={'[网站](https://example.com/report.pdf) 和 [章节](#section)'} onOpenArtifact={vi.fn()} />);
    const web = screen.getByRole('link', { name: '网站' });
    expect(web.getAttribute('href')).toBe('https://example.com/report.pdf');
    expect(web.getAttribute('target')).toBe('_blank');
    expect(web.className).not.toContain('message__artifact-link');
    expect(screen.getByRole('link', { name: '章节' }).getAttribute('href')).toBe('#section');
  });

  it('keeps file mentions as code when no preview callback exists', () => {
    const { container } = render(<AssistantAnswer text={'`src/panel.tsx`'} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('src/panel.tsx');
  });

  it('retains spaces and Unicode in file names and click targets', () => {
    const open = vi.fn();
    render(<AssistantAnswer text={'已生成 `reports/设计 说明 v2.docx`。'} onOpenArtifact={open} />);
    const file = screen.getByRole('button', { name: 'reports/设计 说明 v2.docx' });
    expect(file.textContent).toBe('设计 说明 v2.docx');
    fireEvent.click(file);
    expect(open).toHaveBeenCalledWith('reports/设计 说明 v2.docx');
  });
});
