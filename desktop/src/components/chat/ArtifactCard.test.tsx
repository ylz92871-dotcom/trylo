// Trylo Desktop — ArtifactCard security gate tests
// (M3 closure spec §9.3 / §14.6, fixing M3-P1-11).
//
// Denied targets must render DISABLED actions with a
// visible reason (§9.3: never left clickable), and every
// failed host action must surface user feedback instead
// of being fire-and-forget (audit M3-P1-11).

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ArtifactCard, type HostAdapter } from '@trylo/work';

const ROOT = 'C:/work/demo-ws';

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
        filePath="C:/work/demo-ws/.trylo/out/report.docx"
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
        filePath="C:/work/other-project/evil.docx"
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
        filePath="C:/work/demo-ws/.trylo/out/report.docx"
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
        filePath="C:/work/demo-ws/../../windows/system32/cmd.exe"
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
  it('shows a visible alert and calls onActionError when the host rejects', async () => {
    const host = makeHost({
      openFile: vi.fn().mockRejectedValue(new Error('目标不存在或不可访问')),
    });
    const onActionError = vi.fn();
    render(
      <ArtifactCard
        filePath="C:/work/demo-ws/.trylo/out/report.docx"
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
      'C:/work/demo-ws/.trylo/out/report.docx',
    );
  });

  it('opens through the host on a contained target (no denial)', async () => {
    const host = makeHost();
    render(
      <ArtifactCard
        filePath="C:/work/demo-ws/.trylo/out/report.docx"
        kind="document"
        workspacePath={ROOT}
        host={host}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await Promise.resolve();
    expect(host.openFile).toHaveBeenCalledWith('C:/work/demo-ws/.trylo/out/report.docx');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
