// Trylo Desktop — ArtifactCard security gate tests
// (M3 closure spec §9.3 / §14.6, fixing M3-P1-11).
//
// Denied targets must render DISABLED actions with a
// visible reason (§9.3: never left clickable), and every
// failed host action must surface user feedback instead
// of being fire-and-forget (audit M3-P1-11).

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactCard } from './ArtifactCard';
import type { ArtifactHost as HostAdapter } from '../../host-adapter/artifact-actions';

const ROOT = 'D:/CC/trylo';

function mockPlatform(platform: string): () => void {
  const original = Object.getOwnPropertyDescriptor(window.navigator, 'platform');
  Object.defineProperty(window.navigator, 'platform', { value: platform, configurable: true });
  return () => {
    if (original) Object.defineProperty(window.navigator, 'platform', original);
    else delete (window.navigator as { platform?: string }).platform;
  };
}

let restorePlatform: (() => void) | undefined;
afterEach(() => {
  restorePlatform?.();
  restorePlatform = undefined;
});

function makeHost(overrides?: Partial<HostAdapter>): HostAdapter {
  return {
    openFile: vi.fn().mockResolvedValue(undefined),
    openFileWithApp: vi.fn().mockResolvedValue(undefined),
    showInFolder: vi.fn().mockResolvedValue(undefined),
    copyToClipboard: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('ArtifactCard containment gate (§9.3)', () => {
  it('enables actions for a target inside the project root', () => {
    render(
      <ArtifactCard
        filePath="D:/CC/trylo/.trylo/out/report.docx"
        kind="document"
        workspacePath={ROOT}
        host={makeHost()}
      />,
    );
    const open = screen.getByRole('button', { name: 'Open' }) as HTMLButtonElement;
    expect(open.disabled).toBe(false);
    expect(screen.queryByText(/已拒绝/)).toBeNull();
  });

  it('disables actions and explains why for a target OUTSIDE the root', () => {
    render(
      <ArtifactCard
        filePath="D:/CC/other-project/evil.docx"
        kind="document"
        workspacePath={ROOT}
        host={makeHost()}
      />,
    );
    const open = screen.getByRole('button', { name: 'Open' }) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    expect(open.title).toContain('项目根目录');
    // The reason is visible text, not just a tooltip.
    expect(screen.getByText(/不在当前项目根目录内/)).toBeTruthy();
  });

  it('disables actions with a reason when no project root is available', () => {
    render(
      <ArtifactCard
        filePath="D:/CC/trylo/.trylo/out/report.docx"
        kind="document"
        host={makeHost()}
      />,
    );
    const open = screen.getByRole('button', { name: 'Open' }) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    expect(screen.getByText(/缺少项目根目录/)).toBeTruthy();
  });

  it('never calls the host for a denied target', () => {
    const host = makeHost();
    render(
      <ArtifactCard
        filePath="D:/CC/trylo/../../windows/system32/cmd.exe"
        kind="document"
        workspacePath={ROOT}
        host={host}
      />,
    );
    const open = screen.getByRole('button', { name: 'Open' }) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    fireEvent.click(open); // no-op on disabled, belt and braces
    expect(host.openFile).not.toHaveBeenCalled();
  });

  it('lets http(s) web artifacts skip the file gate', () => {
    render(
      <ArtifactCard
        filePath="https://example.com/page"
        kind="web"
        host={makeHost()}
      />,
    );
    // No workspacePath, yet the URL action stays enabled. The open
    // button's accessible name is "Open"; the file name lives in a span.
    const file = screen.getByRole('button', { name: 'Open' }) as HTMLButtonElement;
    expect(file.disabled).toBe(false);
    expect(screen.getByTitle('page')).toBeTruthy();
  });
});

describe('ArtifactCard failure feedback (§9.3 step 5, §14.6)', () => {
  it.each(['https://example.com/site/index.html', 'http://example.com/report.pdf'])(
    'opens HTTP(S) artifact %s through its existing URL host, never the local viewer',
    (filePath) => {
      const host = makeHost();
      const onOpenViewer = vi.fn();
      render(<ArtifactCard filePath={filePath} kind="web" host={host} onOpenViewer={onOpenViewer} />);
      fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      expect(host.openFile).toHaveBeenCalledWith(filePath);
      expect(onOpenViewer).not.toHaveBeenCalled();
    },
  );

  it('delegates generic PDF preview to the desktop instead of opening the OS app', () => {
    const host = makeHost(); const onOpenViewer = vi.fn();
    render(<ArtifactCard filePath={`${ROOT}/.trylo/out/report.pdf`} kind="file" workspacePath={ROOT} host={host} onOpenViewer={onOpenViewer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onOpenViewer).toHaveBeenCalledWith(`${ROOT}/.trylo/out/report.pdf`);
    expect(host.openFile).not.toHaveBeenCalled();
  });
  it('shows a visible alert and calls onActionError when the host rejects', async () => {
    const host = makeHost({
      openFile: vi.fn().mockRejectedValue(new Error('目标不存在或不可访问')),
    });
    const onActionError = vi.fn();
    render(
      <ArtifactCard
        filePath="D:/CC/trylo/.trylo/out/report.docx"
        kind="document"
        workspacePath={ROOT}
        host={host}
        onActionError={onActionError}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('目标不存在或不可访问');
    expect(onActionError).toHaveBeenCalledWith(
      '目标不存在或不可访问',
      'D:/CC/trylo/.trylo/out/report.docx',
    );
  });

  it('opens through the host on a contained target (no denial)', async () => {
    const host = makeHost();
    render(
      <ArtifactCard
        filePath="D:/CC/trylo/.trylo/out/report.docx"
        kind="document"
        workspacePath={ROOT}
        host={host}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await Promise.resolve();
    expect(host.openFile).toHaveBeenCalledWith('D:/CC/trylo/.trylo/out/report.docx');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('ArtifactCard action menu', () => {
  it('keeps the application choice and forwards the selected native opener', () => {
    const host = makeHost();
    const filePath = `${ROOT}/deck.pptx`;
    render(<ArtifactCard filePath={filePath} kind="presentation" workspacePath={ROOT} host={host} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Microsoft PowerPoint' }));
    expect(host.openFileWithApp).toHaveBeenCalledWith(filePath, { name: 'Microsoft PowerPoint', identifier: 'powerpnt' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('copies generic paths and reveals the contained file through the host', () => {
    const host = makeHost();
    const filePath = `${ROOT}/export.pdf`;
    render(<ArtifactCard filePath={filePath} kind="file" workspacePath={ROOT} host={host} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy path' }));
    expect(host.copyToClipboard).toHaveBeenCalledWith(filePath);
    fireEvent.click(screen.getByRole('button', { name: 'Open options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in folder' }));
    expect(host.showInFolder).toHaveBeenCalledWith(filePath);
  });

  it('keeps copying available for denied paths while file launch actions stay disabled', () => {
    const host = makeHost();
    render(<ArtifactCard filePath="C:/outside/secret.pdf" kind="file" workspacePath={ROOT} host={host} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open options' }));
    expect((screen.getByRole('menuitem', { name: 'Open in folder' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy path' }));
    expect(host.copyToClipboard).toHaveBeenCalledWith('C:/outside/secret.pdf');
    expect(host.openFile).not.toHaveBeenCalled();
    expect(host.showInFolder).not.toHaveBeenCalled();
  });

  it('closes with Escape or an outside pointer without invoking an action', () => {
    const host = makeHost();
    render(<ArtifactCard filePath={`${ROOT}/note.md`} kind="document" workspacePath={ROOT} host={host} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open options' }));
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open options' }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(host.openFile).not.toHaveBeenCalled();
  });

  it.each([
    ['document', 'report.docx'],
    ['presentation', 'deck.ppt'],
    ['spreadsheet', 'table.tsv'],
    ['web', 'page.html'],
  ] as const)('uses the desktop reader for supported %s files', (kind, file) => {
    const host = makeHost();
    const onOpenViewer = vi.fn();
    const filePath = `${ROOT}/${file}`;
    render(<ArtifactCard filePath={filePath} kind={kind} workspacePath={ROOT} host={host} onOpenViewer={onOpenViewer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onOpenViewer).toHaveBeenCalledWith(filePath);
    expect(host.openFile).not.toHaveBeenCalled();
  });

  it('retains external opening for a native document without a desktop reader', () => {
    const host = makeHost();
    const onOpenViewer = vi.fn();
    const filePath = `${ROOT}/report.pages`;
    render(<ArtifactCard filePath={filePath} kind="document" workspacePath={ROOT} host={host} onOpenViewer={onOpenViewer} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(host.openFile).toHaveBeenCalledWith(filePath);
    expect(onOpenViewer).not.toHaveBeenCalled();
  });

  it('reports clipboard failures using the same alert and callback as opening failures', async () => {
    const host = makeHost({ copyToClipboard: vi.fn().mockRejectedValue(new Error('clipboard unavailable')) });
    const onActionError = vi.fn();
    const filePath = `${ROOT}/export.pdf`;
    render(<ArtifactCard filePath={filePath} kind="file" workspacePath={ROOT} host={host} onActionError={onActionError} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy path' }));
    expect((await screen.findByRole('alert')).textContent).toContain('clipboard unavailable');
    expect(onActionError).toHaveBeenCalledWith('clipboard unavailable', filePath);
  });
});

describe('ArtifactCard shared review rows', () => {
  it('uses the existing preview action and host menu from the file row', () => {
    const host = makeHost();
    const onOpenViewer = vi.fn();
    const filePath = `${ROOT}/.trylo/out/report.pdf`;
    render(<ArtifactCard filePath={filePath} kind="file" layout="row" workspacePath={ROOT}
      host={host} onOpenViewer={onOpenViewer} metadata={<span>已验证</span>} />);
    fireEvent.click(screen.getByRole('button', { name: '打开文件 .trylo/out/report.pdf' }));
    expect(onOpenViewer).toHaveBeenCalledWith(filePath);
    expect(screen.getByText('.trylo/out')).toBeTruthy();
    expect(screen.getByText('已验证')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'report.pdf 的更多操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '在文件夹中显示' }));
    expect(host.showInFolder).toHaveBeenCalledWith(filePath);
  });

  it('keeps a denied row disabled and retains its visible containment reason', () => {
    const host = makeHost();
    const onOpenViewer = vi.fn();
    render(<ArtifactCard filePath="C:/outside/secret.pdf" kind="file" layout="row"
      workspacePath={ROOT} host={host} onOpenViewer={onOpenViewer} />);
    const open = screen.getByRole('button', { name: '打开文件 C:/outside/secret.pdf' }) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    fireEvent.click(open);
    expect(screen.getByRole('note').textContent).toContain('不在当前项目根目录内');
    expect(host.openFile).not.toHaveBeenCalled();
    expect(onOpenViewer).not.toHaveBeenCalled();
  });

  it('keeps HTTP(S) row and browser-menu actions on the URL host', () => {
    const host = makeHost();
    const onOpenViewer = vi.fn();
    const filePath = 'https://example.com/index.html';
    render(<ArtifactCard filePath={filePath} kind="web" layout="row" host={host} onOpenViewer={onOpenViewer} />);
    fireEvent.click(screen.getByRole('button', { name: `打开链接 ${filePath}` }));
    fireEvent.click(screen.getByRole('button', { name: 'index.html 的更多操作' }));
    expect(screen.queryByRole('menuitem', { name: '在文件夹中显示' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: '在浏览器中打开' }));
    expect(host.openFile).toHaveBeenCalledTimes(2);
    expect(host.openFile).toHaveBeenLastCalledWith(filePath);
    expect(onOpenViewer).not.toHaveBeenCalled();
  });
});

describe('ArtifactCard macOS external apps and Finder labels (Code & Work)', () => {
  it('offers macOS application identifiers and Reveal in Finder in card layout', () => {
    restorePlatform = mockPlatform('MacIntel');
    const host = makeHost();
    const filePath = `${ROOT}/deck.pptx`;
    render(<ArtifactCard filePath={filePath} kind="presentation" workspacePath={ROOT} host={host} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open options' }));
    expect(screen.getByRole('menuitem', { name: 'Keynote' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'LibreOffice' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Preview' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Reveal in Finder' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Microsoft PowerPoint' }));
    expect(host.openFileWithApp).toHaveBeenCalledWith(filePath, {
      name: 'Microsoft PowerPoint',
      identifier: 'Microsoft PowerPoint',
    });
  });

  it('offers macOS spreadsheet/document apps and 在访达中显示 in row layout', () => {
    restorePlatform = mockPlatform('MacIntel');
    const host = makeHost();
    const filePath = `${ROOT}/sheet.xlsx`;
    render(
      <ArtifactCard
        filePath={filePath}
        kind="spreadsheet"
        layout="row"
        workspacePath={ROOT}
        host={host}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'sheet.xlsx 的更多操作' }));
    expect(screen.getByRole('menuitem', { name: 'Numbers' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '在访达中显示' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Microsoft Outlook' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: '在访达中显示' }));
    expect(host.showInFolder).toHaveBeenCalledWith(filePath);
  });
});
