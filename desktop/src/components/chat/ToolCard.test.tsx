// Trylo Desktop — ToolCard component tests (spec §11.4).
//
// §11.4 covers the disclosure contract and the §7.2
// single-loader rule:
//   - running tool auto-expands, done auto-collapses;
//   - a manual user override survives a status change;
//   - `aria-expanded` stays in sync with the visual
//     `.disclosure--open` state;
//   - a running tool renders exactly ONE loop animation
//     (the status Loader), never the old icon rotation or
//     a card border pulse.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import { runtimeArtifactsOf, ToolCard } from './ToolCard';
import type { ToolMessage } from './types';

function tool(over: Partial<ToolMessage>): ToolMessage {
  return {
    id: 't1',
    kind: 'tool',
    role: 'assistant',
    createdAt: 1000,
    turnId: 'u1',
    tool: 'read',
    summary: 'read a.ts',
    status: 'running',
    ...over,
  };
}

describe('ToolCard disclosure (§11.4)', () => {
  it('running tool auto-expands (aria-expanded + visual state)', () => {
    render(<ToolCard message={tool({ status: 'running', tool: 'Read' })} />);
    const head = screen.getByRole('button');
    expect(head).toHaveAttribute('aria-expanded', 'true');
    // Visual state is in sync: the shared disclosure grid row is open.
    expect(head.parentElement!.querySelector('.disclosure')).toHaveClass(
      'disclosure--open',
    );
  });

  it('done tool auto-collapses', () => {
    render(<ToolCard message={tool({ status: 'done' })} />);
    const head = screen.getByRole('button');
    expect(head).toHaveAttribute('aria-expanded', 'false');
    expect(head.parentElement!.querySelector('.disclosure')).not.toHaveClass(
      'disclosure--open',
    );
  });

  it('body stays mounted while collapsed (grid-row disclosure, §7.4)', () => {
    render(<ToolCard message={tool({ status: 'done' })} />);
    // The body is NOT unmounted — the shared .disclosure grid
    // row animates 0fr→1fr instead of an instant mount.
    expect(screen.getByText('status')).toBeInTheDocument();
  });

  it('user override to expand a done card survives a status change', () => {
    const { rerender } = render(<ToolCard message={tool({ status: 'done' })} />);
    const head = screen.getByRole('button');
    // A done card is auto-collapsed…
    expect(head).toHaveAttribute('aria-expanded', 'false');
    // …but the user clicks it open.
    fireEvent.click(head);
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
    // Status flips to error (still auto-collapsed by rule) —
    // the manual override must win.
    rerender(<ToolCard message={tool({ status: 'error', tool: 'Read' })} />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
  });

  it('user override to collapse a running card survives a status change', () => {
    const { rerender } = render(<ToolCard message={tool({ status: 'running' })} />);
    const head = screen.getByRole('button');
    // A running card is auto-expanded…
    expect(head).toHaveAttribute('aria-expanded', 'true');
    // …but the user collapses it.
    fireEvent.click(head);
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
    // Status flips to done — the manual override must win.
    rerender(<ToolCard message={tool({ status: 'done' })} />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('ToolCard motion (§7.2 / §11.4)', () => {
  it('running tool renders exactly ONE loop animation (status loader)', () => {
    const { container } = render(
      <ToolCard message={tool({ status: 'running', tool: 'Read' })} />,
    );
    expect(container.querySelectorAll('.tool__status-icon--spin')).toHaveLength(1);
    // No second/third loops on the same card: no tool-icon
    // rotation, no card border pulse.
    expect(container.querySelector('.tool__icon--spin')).toBeNull();
    expect(container.querySelector('.tool--pulse')).toBeNull();
  });

  it('done/error/interrupted tools have no spin animation', () => {
    for (const status of ['done', 'error', 'interrupted'] as const) {
      const { container, unmount } = render(
        <ToolCard message={tool({ status })} />,
      );
      expect(
        container.querySelectorAll('.tool__status-icon--spin'),
      ).toHaveLength(0);
      unmount();
    }
  });

  it('status pill wording: running verb, done/failed/interrupted labels', () => {
    const { rerender } = render(
      <ToolCard message={tool({ status: 'running', tool: 'Read' })} />,
    );
    const head = () => screen.getByRole('button');
    // Scope to the head button: the always-mounted body
    // also shows the status word, so target the pill.
    expect(head()).toHaveTextContent('Reading…');
    rerender(<ToolCard message={tool({ status: 'done', tool: 'Read' })} />);
    expect(head()).toHaveTextContent('done');
    rerender(<ToolCard message={tool({ status: 'error', tool: 'Read' })} />);
    expect(head()).toHaveTextContent('failed');
    rerender(<ToolCard message={tool({ status: 'interrupted', tool: 'Read' })} />);
    expect(head()).toHaveTextContent('interrupted');
  });

  it('duration is shown once the tool finished', () => {
    const { rerender } = render(<ToolCard message={tool({ status: 'running' })} />);
    const head = () => screen.getByRole('button');
    expect(head()).not.toHaveTextContent(/0\.[0-9]s/);
    rerender(<ToolCard message={tool({ status: 'done', durationMs: 600 })} />);
    expect(head()).toHaveTextContent('0.6s');
  });
});

// ── PR-3 遗留收口: runtime-artifact promote affordance ─────────────────

const SCREENSHOT_RESULT = 'Screenshot of full page.\n- [Screenshot of full page](.trylo\\runtime\\browser\\conv-1\\page-2026-09-02T10-00-00-000Z.png)\n- Downloaded file "spec.pdf" to ".trylo\\runtime\\browser\\conv-1\\spec.pdf"';

describe('runtime artifact parsing (PR-3 收口)', () => {
  it('extracts file names from markdown links and quoted download paths', () => {
    const artifacts = runtimeArtifactsOf(SCREENSHOT_RESULT);
    expect(artifacts.map((a) => a.fileName)).toEqual([
      'page-2026-09-02T10-00-00-000Z.png',
      'spec.pdf',
    ]);
  });

  it('ignores paths outside .trylo/runtime and traversal segments', () => {
    const artifacts = runtimeArtifactsOf(
      '- [doc](docs/readme.md)\n- [bad](.trylo/runtime/browser/conv/../../secrets.png)\n- [short](.trylo/runtime/x.png)',
    );
    expect(artifacts).toEqual([]);
  });

  it('dedupes repeated references and returns [] for undefined', () => {
    const twice = runtimeArtifactsOf(
      '- [a](.trylo/runtime/browser/c/page.png)\n- [b](.trylo\\runtime\\browser\\c\\page.png)',
    );
    expect(twice).toHaveLength(1);
    expect(runtimeArtifactsOf(undefined)).toEqual([]);
  });
});

describe('promote affordance (PR-3 收口, §7.3)', () => {
  it('offers a promote button per runtime file and routes the click to the host', async () => {
    const promotions: [string, string][] = [];
    const { container } = render(
      <ToolCard
        message={tool({
          status: 'done',
          tool: 'mcp__trylo-browser__browser_take_screenshot',
          outputText: SCREENSHOT_RESULT,
        })}
        onPromoteRuntimeArtifact={async (packageId, fileName) => {
          promotions.push([packageId, fileName]);
          return { ok: true };
        }}
      />,
    );
    // Expand the done card first (scope to the head — the body is
    // always mounted and owns its own buttons).
    fireEvent.click(container.querySelector('.tool__head')!);
    const buttons = screen.getAllByRole('button', { name: /提升为交付物/ });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(promotions).toEqual([['playwright', 'page-2026-09-02T10-00-00-000Z.png']]));
    await screen.findAllByText('已提升');
  });

  it('renders the failure reason inline when the promoter refuses', async () => {
    const { container } = render(
      <ToolCard
        message={tool({
          status: 'done',
          tool: 'mcp__trylo-browser__browser_take_screenshot',
          outputText: '- [Screenshot](.trylo/runtime/browser/conv-1/shot.png)',
        })}
        onPromoteRuntimeArtifact={async () => ({ ok: false, error: 'artifact_missing' })}
      />,
    );
    fireEvent.click(container.querySelector('.tool__head')!);
    fireEvent.click(screen.getByRole('button', { name: /提升为交付物/ }));
    await screen.findByText('artifact_missing');
  });

  it('shows no promote affordance without the host callback', () => {
    const { container } = render(
      <ToolCard
        message={tool({
          status: 'done',
          tool: 'mcp__trylo-browser__browser_take_screenshot',
          outputText: SCREENSHOT_RESULT,
        })}
      />,
    );
    fireEvent.click(container.querySelector('.tool__head')!);
    expect(screen.queryByText(/提升为交付物/)).toBeNull();
  });

  it('never offers promote on non-browser tools or running cards', () => {
    const { rerender, container } = render(
      <ToolCard
        message={tool({ status: 'done', tool: 'Bash', outputText: SCREENSHOT_RESULT })}
        onPromoteRuntimeArtifact={async () => ({ ok: true })}
      />,
    );
    fireEvent.click(container.querySelector('.tool__head')!);
    expect(screen.queryByText(/提升为交付物/)).toBeNull();
    rerender(
      <ToolCard
        message={tool({ status: 'running', tool: 'mcp__trylo-browser__browser_take_screenshot', outputText: SCREENSHOT_RESULT })}
        onPromoteRuntimeArtifact={async () => ({ ok: true })}
      />,
    );
    expect(screen.queryByText(/提升为交付物/)).toBeNull();
  });
});

// ── PR-4 偏差②收口: resource 「打开」 affordance ─────────────────────────

const CACHED_REF = {
  id: 'bin-abc',
  storage: 'ephemeral-tool-cache' as const,
  path: 'C:/Users/x/AppData/roaming/trylo/tool-cache/ab/abc.png',
  mimeType: 'image/png',
  size: 12,
  sha256: 'a'.repeat(64),
};

describe('resource open affordance (PR-4 收口, §7.2)', () => {
  it('renders 打开 on a binary-backed resource block and reports failures inline', async () => {
    const { container } = render(
      <ToolCard
        message={tool({
          status: 'done',
          tool: 'mcp__trylo-browser__browser_take_screenshot',
          outputContent: [
            { type: 'resource', uri: 'file:///tmp/shot.png', mimeType: 'image/png', ref: CACHED_REF },
          ],
        })}
        onOpenCachedResource={async () => ({ ok: false, error: '路径不在临时资源区内' })}
      />,
    );
    fireEvent.click(container.querySelector('.tool__head')!);
    fireEvent.click(screen.getByRole('button', { name: '打开' }));
    await screen.findByText('路径不在临时资源区内');
  });

  it('stays silent for text-only resources and when no handler is wired', () => {
    const { container } = render(
      <ToolCard
        message={tool({
          status: 'done',
          outputContent: [{ type: 'resource', uri: 'file:///tmp/notes.txt', text: 'hello' }],
        })}
      />,
    );
    fireEvent.click(container.querySelector('.tool__head')!);
    expect(screen.queryByRole('button', { name: '打开' })).toBeNull();
  });
});
