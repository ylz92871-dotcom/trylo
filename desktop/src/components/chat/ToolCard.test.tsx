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

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { describe, expect, it } from 'vitest'
import { runtimeArtifactsOf, ToolCard } from './ToolCard'
import type { ToolMessage } from './types'

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
  }
}

describe('ToolCard disclosure (§11.4)', () => {
  it('running tool auto-expands (aria-expanded + visual state)', () => {
    render(<ToolCard message={tool({ status: 'running', tool: 'Read' })} />)
    const head = screen.getByRole('button')
    expect(head).toHaveAttribute('aria-expanded', 'true')
    // Visual state is in sync: the shared disclosure grid row is open.
    expect(head.parentElement!.querySelector('.disclosure')).toHaveClass('disclosure--open')
  })

  it('done tool auto-collapses', () => {
    render(<ToolCard message={tool({ status: 'done' })} />)
    const head = screen.getByRole('button')
    expect(head).toHaveAttribute('aria-expanded', 'false')
    expect(head.parentElement!.querySelector('.disclosure')).not.toHaveClass('disclosure--open')
  })

  it('body mounts lazily; once opened it stays mounted while collapsing (§7.4)', () => {
    // A never-opened card mounts WITHOUT its body: history runs mount
    // collapsed cards in bulk while scrolling the virtualized list, and the
    // body (full output text + result parsing) is the expensive part. The
    // card renders one header row, nothing more.
    const first = render(<ToolCard message={tool({ status: 'done' })} />)
    expect(first.queryByText('status')).not.toBeInTheDocument()
    first.unmount()

    // Once a card HAS been open (a running card starts expanded), collapsing
    // must not unmount the body — the shared .disclosure grid row animates
    // 0fr→1fr against live content instead of an instant mount (spec §7.4).
    const { rerender } = render(<ToolCard message={tool({ status: 'running' })} />)
    expect(screen.getByText('status')).toBeInTheDocument()
    rerender(<ToolCard message={tool({ status: 'done' })} />)
    expect(screen.getByText('status')).toBeInTheDocument()
  })

  it('lazy body renders the LATEST message when opened after updates', () => {
    // Adversarial: lazy-mounting must never serve stale content. A collapsed
    // card whose message updates (result arrives) still shows the fresh
    // output the moment the user opens it.
    const { rerender } = render(<ToolCard message={tool({ status: 'done' })} />)
    expect(screen.queryByText('hello output')).not.toBeInTheDocument()

    rerender(<ToolCard message={tool({ status: 'done', outputText: 'hello output' })} />)
    // Still collapsed, still no body…
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('hello output')).not.toBeInTheDocument()

    // …and opening renders the CURRENT output, not the mount-time one.
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('hello output')).toBeInTheDocument()

    // Collapse again — body retained (disclosure animation), content intact.
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('hello output')).toBeInTheDocument()
  })

  it('user override to expand a done card survives a status change', () => {
    const { rerender } = render(<ToolCard message={tool({ status: 'done' })} />)
    const head = screen.getByRole('button')
    // A done card is auto-collapsed…
    expect(head).toHaveAttribute('aria-expanded', 'false')
    // …but the user clicks it open.
    fireEvent.click(head)
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true')
    // Status flips to error (still auto-collapsed by rule) —
    // the manual override must win.
    rerender(<ToolCard message={tool({ status: 'error', tool: 'Read' })} />)
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true')
  })

  it('user override to collapse a running card survives a status change', () => {
    const { rerender } = render(<ToolCard message={tool({ status: 'running' })} />)
    const head = screen.getByRole('button')
    // A running card is auto-expanded…
    expect(head).toHaveAttribute('aria-expanded', 'true')
    // …but the user collapses it.
    fireEvent.click(head)
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false')
    // Status flips to done — the manual override must win.
    rerender(<ToolCard message={tool({ status: 'done' })} />)
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('ToolCard motion (§7.2 / §11.4)', () => {
  it('running tool renders exactly ONE loop animation (status loader)', () => {
    const { container } = render(<ToolCard message={tool({ status: 'running', tool: 'Read' })} />)
    expect(container.querySelectorAll('.tool__status-icon--spin')).toHaveLength(1)
    // No second/third loops on the same card: no tool-icon
    // rotation, no card border pulse.
    expect(container.querySelector('.tool__icon--spin')).toBeNull()
    expect(container.querySelector('.tool--pulse')).toBeNull()
  })

  it('done/error/interrupted tools have no spin animation', () => {
    for (const status of ['done', 'error', 'interrupted'] as const) {
      const { container, unmount } = render(<ToolCard message={tool({ status })} />)
      expect(container.querySelectorAll('.tool__status-icon--spin')).toHaveLength(0)
      unmount()
    }
  })

  it('status pill wording: running verb, done/failed/interrupted labels', () => {
    const { rerender } = render(<ToolCard message={tool({ status: 'running', tool: 'Read' })} />)
    const head = () => screen.getByRole('button')
    // Scope to the head button: the always-mounted body
    // also shows the status word, so target the pill.
    expect(head()).toHaveTextContent('Reading…')
    rerender(<ToolCard message={tool({ status: 'done', tool: 'Read' })} />)
    expect(head()).toHaveTextContent('done')
    rerender(<ToolCard message={tool({ status: 'error', tool: 'Read' })} />)
    expect(head()).toHaveTextContent('failed')
    rerender(<ToolCard message={tool({ status: 'interrupted', tool: 'Read' })} />)
    expect(head()).toHaveTextContent('interrupted')
  })

  it('duration is shown once the tool finished', () => {
    const { rerender } = render(<ToolCard message={tool({ status: 'running' })} />)
    const head = () => screen.getByRole('button')
    expect(head()).not.toHaveTextContent(/0\.[0-9]s/)
    rerender(<ToolCard message={tool({ status: 'done', durationMs: 600 })} />)
    expect(head()).toHaveTextContent('0.6s')
  })
})

// ── PR-3 遗留收口: runtime-artifact promote affordance ─────────────────

const SCREENSHOT_RESULT =
  'Screenshot of full page.\n- [Screenshot of full page](.trylo\\runtime\\browser\\conv-1\\page-2026-09-02T10-00-00-000Z.png)\n- Downloaded file "spec.pdf" to ".trylo\\runtime\\browser\\conv-1\\spec.pdf"'

describe('runtime artifact parsing (PR-3 收口)', () => {
  it('extracts file names from markdown links and quoted download paths', () => {
    const artifacts = runtimeArtifactsOf(SCREENSHOT_RESULT)
    expect(artifacts.map((a) => a.fileName)).toEqual([
      'page-2026-09-02T10-00-00-000Z.png',
      'spec.pdf',
    ])
  })

  it('ignores paths outside .trylo/runtime and traversal segments', () => {
    const artifacts = runtimeArtifactsOf(
      '- [doc](docs/readme.md)\n- [bad](.trylo/runtime/browser/conv/../../secrets.png)\n- [short](.trylo/runtime/x.png)',
    )
    expect(artifacts).toEqual([])
  })

  it('dedupes repeated references and returns [] for undefined', () => {
    const twice = runtimeArtifactsOf(
      '- [a](.trylo/runtime/browser/c/page.png)\n- [b](.trylo\\runtime\\browser\\c\\page.png)',
    )
    expect(twice).toHaveLength(1)
    expect(runtimeArtifactsOf(undefined)).toEqual([])
  })
})

describe('promote affordance (PR-3 收口, §7.3)', () => {
  it('offers a promote button per runtime file and routes the click to the host', async () => {
    const promotions: [string, string][] = []
    const { container } = render(
      <ToolCard
        message={tool({
          status: 'done',
          tool: 'mcp__trylo-browser__browser_take_screenshot',
          outputText: SCREENSHOT_RESULT,
        })}
        onPromoteRuntimeArtifact={async (packageId, fileName) => {
          promotions.push([packageId, fileName])
          return { ok: true }
        }}
      />,
    )
    // Expand the done card first (scope to the head — the body is
    // always mounted and owns its own buttons).
    fireEvent.click(container.querySelector('.tool__head')!)
    const buttons = screen.getAllByRole('button', { name: /提升为交付物/ })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[0]!)
    await waitFor(() =>
      expect(promotions).toEqual([['playwright', 'page-2026-09-02T10-00-00-000Z.png']]),
    )
    await screen.findAllByText('已提升')
  })

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
    )
    fireEvent.click(container.querySelector('.tool__head')!)
    fireEvent.click(screen.getByRole('button', { name: /提升为交付物/ }))
    await screen.findByText('artifact_missing')
  })

  it('shows no promote affordance without the host callback', () => {
    const { container } = render(
      <ToolCard
        message={tool({
          status: 'done',
          tool: 'mcp__trylo-browser__browser_take_screenshot',
          outputText: SCREENSHOT_RESULT,
        })}
      />,
    )
    fireEvent.click(container.querySelector('.tool__head')!)
    expect(screen.queryByText(/提升为交付物/)).toBeNull()
  })

  it('never offers promote on non-browser tools or running cards', () => {
    const { rerender, container } = render(
      <ToolCard
        message={tool({ status: 'done', tool: 'Bash', outputText: SCREENSHOT_RESULT })}
        onPromoteRuntimeArtifact={async () => ({ ok: true })}
      />,
    )
    fireEvent.click(container.querySelector('.tool__head')!)
    expect(screen.queryByText(/提升为交付物/)).toBeNull()
    rerender(
      <ToolCard
        message={tool({
          status: 'running',
          tool: 'mcp__trylo-browser__browser_take_screenshot',
          outputText: SCREENSHOT_RESULT,
        })}
        onPromoteRuntimeArtifact={async () => ({ ok: true })}
      />,
    )
    expect(screen.queryByText(/提升为交付物/)).toBeNull()
  })
})

// ── PR-4 偏差②收口: resource 「打开」 affordance ─────────────────────────

const CACHED_REF = {
  id: 'bin-abc',
  storage: 'ephemeral-tool-cache' as const,
  path: 'C:/Users/x/AppData/roaming/trylo/tool-cache/ab/abc.png',
  mimeType: 'image/png',
  size: 12,
  sha256: 'a'.repeat(64),
}

describe('resource open affordance (PR-4 收口, §7.2)', () => {
  it('renders 打开 on a binary-backed resource block and reports failures inline', async () => {
    const { container } = render(
      <ToolCard
        message={tool({
          status: 'done',
          tool: 'mcp__trylo-browser__browser_take_screenshot',
          outputContent: [
            {
              type: 'resource',
              uri: 'file:///tmp/shot.png',
              mimeType: 'image/png',
              ref: CACHED_REF,
            },
          ],
        })}
        onOpenCachedResource={async () => ({ ok: false, error: '路径不在临时资源区内' })}
      />,
    )
    fireEvent.click(container.querySelector('.tool__head')!)
    fireEvent.click(screen.getByRole('button', { name: '打开' }))
    await screen.findByText('路径不在临时资源区内')
  })

  it('stays silent for text-only resources and when no handler is wired', () => {
    const { container } = render(
      <ToolCard
        message={tool({
          status: 'done',
          outputContent: [{ type: 'resource', uri: 'file:///tmp/notes.txt', text: 'hello' }],
        })}
      />,
    )
    fireEvent.click(container.querySelector('.tool__head')!)
    expect(screen.queryByRole('button', { name: '打开' })).toBeNull()
  })
})

describe('WCC-P2-02: target facts row (dispatch vs effect)', () => {
  const factsBlock = {
    type: 'text',
    text:
      'trylo-target:' +
      JSON.stringify({
        window: {
          hwnd: 42,
          pid: 4242,
          processStartedAt100ns: 133000000000000000,
          digest: 'win-a',
          title: '记事本',
        },
        foregroundDigest: 'win-a',
        dispatch: 'accepted',
        effect: 'confirmed_success',
        channel: 'uia.invoke',
      }),
  }

  it('shows the target window and separates dispatch from effect', () => {
    render(
      <ToolCard
        message={tool({
          status: 'done',
          tool: 'mcp__trylo-windows__Click',
          outputText: 'Confirmed action effect on click.\n' + factsBlock.text,
        })}
      />,
    )
    fireEvent.click(
      screen.getByRole('button', { name: /mcp__trylo-windows__Click|read a\.ts|已确认/ }),
    )
    expect(screen.getByText(/记事本 · PID 4242 · 前台一致/)).toBeInTheDocument()
    // The row mixes text nodes and a nested span; match on the row's full
    // textContent via a function matcher (testing-library only inspects an
    // element's DIRECT text nodes by default).
    const row = screen.getByText(
      (_, element) =>
        element?.classList.contains('tool__muted') === true &&
        element.textContent === '已受理 / 已确认生效 · 通道 uia.invoke',
    )
    expect(row).toBeInTheDocument()
  })

  it('hides the raw trylo-target block from the output text', () => {
    render(
      <ToolCard
        message={tool({
          status: 'done',
          tool: 'mcp__trylo-windows__Click',
          outputText: 'Confirmed action effect on click.\n' + factsBlock.text,
        })}
      />,
    )
    fireEvent.click(screen.getAllByRole('button')[0]!)
    expect(screen.queryByText(factsBlock.text)).not.toBeInTheDocument()
    expect(screen.getByText(/Confirmed action effect on click\./)).toBeInTheDocument()
  })

  it('renders no target row for non-windows tools or results without facts', () => {
    render(
      <ToolCard
        message={tool({
          status: 'done',
          tool: 'mcp__trylo-windows__Click',
          outputText: 'Single left clicked at (1,2).',
        })}
      />,
    )
    fireEvent.click(screen.getAllByRole('button')[0]!)
    expect(screen.queryByText(/目标窗口/)).not.toBeInTheDocument()
  })
})

// ── WCC-P2-03: provider routing display (read-only) ─────────────────────

describe('WCC-P2-03: provider routing display row', () => {
  it('shows the browser-cdp provider row for pinned CDP tools', () => {
    render(
      <ToolCard
        message={tool({
          status: 'done',
          tool: 'mcp__trylo-chrome__list_pages',
          outputText: 'Pages: 1',
        })}
      />,
    )
    fireEvent.click(screen.getAllByRole('button')[0]!)
    expect(screen.getByText(/browser-cdp provider/)).toBeInTheDocument()
    expect(screen.getByText(/审批策略不变/)).toBeInTheDocument()
  })

  it('marks non-pinned CDP tools as un-routed (evaluate_script never attributed)', () => {
    render(
      <ToolCard
        message={tool({
          status: 'done',
          tool: 'mcp__trylo-chrome__evaluate_script',
          outputText: '{}',
        })}
      />,
    )
    fireEvent.click(screen.getAllByRole('button')[0]!)
    expect(screen.getByText(/不受 provider 路由/)).toBeInTheDocument()
    expect(screen.queryByText(/browser-cdp provider/)).not.toBeInTheDocument()
  })

  it('renders no routing row for other surfaces', () => {
    render(
      <ToolCard
        message={tool({
          status: 'done',
          tool: 'mcp__trylo-windows__Snapshot',
          outputText: 'snapshot',
        })}
      />,
    )
    fireEvent.click(screen.getAllByRole('button')[0]!)
    expect(screen.queryByText(/应用级路由/)).not.toBeInTheDocument()
  })
})
