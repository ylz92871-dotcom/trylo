// Trylo Desktop — CodeReasoningTranscript takeover badge (§11.3 / WCC-P2-04).
//
// The transcript is the LIVE aggregate surface for both Code and Work runs
// (the old work_activity_group message kind is no longer produced). While a
// segment is collapsed, the per-card takeover facts (trylo-target block) are
// hidden with their cards — the header badge keeps the one fact the user
// must always be able to see: the user grabbed the desktop mid-run, and
// subsequent actions are now per-call approvals. No new event, no new store:
// the badge is a pure projection of the entries the card already holds.

import { act, fireEvent, render } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { describe, expect, it, vi } from 'vitest'
import { CodeReasoningTranscript } from './CodeReasoningTranscript'
import type { ThinkingMessage, ToolMessage } from './types'

describe('approved event flow disclosure', () => {
  it('compacts a delivered mixed phase after completion and can reopen the original reasoning', () => {
    vi.useFakeTimers();
    try {
      const note = { ...thinking(), preview: '先核对文件内容，再验证修改结果。' };
      const view = render(<CodeReasoningTranscript entries={[note, tool({ status: 'running' })]} active turnId="u1" phaseId="p1" />);
      view.rerender(<CodeReasoningTranscript entries={[note, tool({ status: 'done' })]} active={false} turnId="u1" phaseId="p1" />);
      act(() => { vi.advanceTimersByTime(1000); });
      expect(view.container.querySelector('.code-reasoning__head')).toHaveAttribute('aria-expanded', 'false');
      expect(view.container.querySelector('.disclosure')).not.toHaveClass('disclosure--open');
      fireEvent.click(view.container.querySelector('.code-reasoning__head')!);
      expect(view.container.querySelector('.disclosure')).toHaveClass('disclosure--open');
      expect(view.getByText(note.preview)).toBeVisible();
    } finally { vi.useRealTimers(); }
  });

  it('loads saved reasoning compactly and respects a manual collapse across updates', () => {
    const entries = [thinking(), tool({ status: 'done' })];
    const view = render(<CodeReasoningTranscript entries={entries} active={false} turnId="u1" phaseId="p1" />);
    const head = view.container.querySelector('.code-reasoning__head')!;
    expect(head).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(head);
    expect(head).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(head);
    view.rerender(<CodeReasoningTranscript entries={[...entries, { ...thinking(), id: 'th2' }]} active={false} turnId="u1" phaseId="p1" />);
    expect(head).toHaveAttribute('aria-expanded', 'false');
  });

  it('offers one disclosure for a saved reasoning-only entry without removing its full text', () => {
    const raw = '原始思考保留标点和换行。\n第二段也原样保留。';
    const view = render(<CodeReasoningTranscript entries={[
      { ...thinking(), summary: 'An internal reasoning summary.', preview: raw, fullLength: raw.length },
    ]} active={false} turnId="u1" phaseId="p1" />);
    const head = view.container.querySelector('.code-reasoning__head')!;
    expect(head).toHaveAttribute('aria-expanded', 'false');
    expect(head).toHaveTextContent('思考过程');
    expect(view.container.querySelector('.disclosure')).not.toHaveClass('disclosure--open');
    fireEvent.click(head);
    expect(view.container.querySelector('.disclosure')).toHaveClass('disclosure--open');
    expect(view.container.querySelector('.code-reasoning__passage-text')?.textContent).toBe(raw);
  });

  it('streams raw reasoning openly then compacts it after the phase ends', () => {
    vi.useFakeTimers();
    try {
      const note = { ...thinking(), partial: true, preview: '第一段原始思考。' };
      const view = render(<CodeReasoningTranscript entries={[note]} active turnId="u1" phaseId="p1" />);
      const head = view.container.querySelector('.code-reasoning__head')!;
      expect(head).toHaveAttribute('aria-expanded', 'true');
      view.rerender(<CodeReasoningTranscript entries={[{ ...note, preview: '第一段原始思考。第二段。' }]} active turnId="u1" phaseId="p1" />);
      expect(view.container.querySelector('.code-reasoning__passage-text')).toHaveTextContent('第一段原始思考。第二段。');
      expect(head).toHaveAttribute('aria-expanded', 'true');
      view.rerender(<CodeReasoningTranscript entries={[{ ...note, partial: false }]} active={false} turnId="u1" phaseId="p1" />);
      act(() => { vi.advanceTimersByTime(500); });
      expect(head).toHaveAttribute('aria-expanded', 'false');
    } finally { vi.useRealTimers(); }
  });

  it('uses the real finding after the last action and preserves the original note text', () => {
    const raw = 'Qoder processes are gone again (count 0).';
    const view = render(<CodeReasoningTranscript entries={[
      thinking(),
      tool({ tool: 'mcp__trylo-windows__Wait', input: { duration: 10 }, summary: '{"duration":10}' }),
      { ...thinking(), id: 'finding', summary: '复查时 Qoder 进程数为 0', preview: raw, fullLength: raw.length },
    ]} active={false} turnId="u1" phaseId="p1" />);
    expect(view.container.querySelector('.code-reasoning__summary')).toHaveTextContent('复查时 Qoder 进程数为 0');
    expect(view.container.querySelector('.code-reasoning__passage-text')).toBeNull();
    fireEvent.click(view.container.querySelector('.code-reasoning__head')!);
    expect(view.getByText(raw)).toBeInTheDocument();
    expect(view.container.querySelector('.code-reasoning__head')).not.toHaveTextContent('duration');
  });

  it('does not turn an earlier intention or raw parameters into a completed result', () => {
    const entries = [
      { ...thinking(), summary: '准备打开 Qoder 窗口', preview: '准备打开 Qoder 窗口' },
      tool({ tool: 'mcp__trylo-windows__Wait', input: { duration: 10 }, summary: '{"duration":10}' }),
    ];
    const view = render(<CodeReasoningTranscript entries={entries} active={false} turnId="u1" phaseId="p1" />);
    expect(view.container.querySelector('.code-reasoning__summary')).toHaveTextContent('等待结束');
    expect(view.container.querySelector('.code-reasoning__head')).not.toHaveTextContent('准备打开');
    view.rerender(<CodeReasoningTranscript entries={[entries[0]!, { ...entries[1]!, status: 'running' } as ToolMessage]} active turnId="u1" phaseId="p1" />);
    expect(view.container.querySelector('.code-reasoning__summary')).toHaveTextContent('正在等待');
    expect(view.container.querySelector('.code-reasoning__head')).not.toHaveTextContent('duration');
  });

  it('keeps a manually opened process visible when the task completes', () => {
    vi.useFakeTimers();
    try {
      const entries = [thinking(), tool({ status: 'running' })];
      const view = render(<CodeReasoningTranscript entries={entries} active turnId="u1" phaseId="p1" />);
      const head = view.container.querySelector('.code-reasoning__head')!;
      fireEvent.click(head);
      fireEvent.click(head);
      view.rerender(<CodeReasoningTranscript entries={[entries[0]!, tool({ status: 'done' })]} active={false} turnId="u1" phaseId="p1" />);
      act(() => { vi.advanceTimersByTime(500); });
      expect(head).toHaveAttribute('aria-expanded', 'true');
    } finally { vi.useRealTimers(); }
  });

  it('shows failed output by default and never marks an interrupted phase successful', () => {
    const view = render(<CodeReasoningTranscript entries={[tool({status:'error'})]} active={false} turnId="u1" phaseId="p1" />);
    expect(view.container.querySelector('.code-reasoning__head')).toHaveAttribute('aria-expanded', 'true');
    expect(view.container.querySelector('.code-reasoning')).not.toHaveClass('code-reasoning--done');
    view.rerender(<CodeReasoningTranscript entries={[tool({status:'interrupted'})]} active={false} turnId="u1" phaseId="p1" />);
    expect(view.container.querySelector('.code-reasoning')).not.toHaveClass('code-reasoning--done');
    expect(view.container.querySelector('.code-reasoning__summary')).toHaveTextContent('本次执行已中断');
  });
});

// Render probe: the transcript's children are the expensive part it must
// stop re-rendering. Counting ToolCard renders through a mock observes the
// memo bail directly — a Profiler cannot, because it counts its own update
// even when every memoized child below it bails.
const transcriptProbe = vi.hoisted(() => ({ renders: 0 }))
vi.mock('./ToolCard', () => ({
  ToolCard: (props: { readonly message: { readonly id: string } }) => {
    transcriptProbe.renders += 1
    return <div data-testid={`toolcard-${props.message.id}`} />
  },
}))

function tool(over: Partial<ToolMessage>): ToolMessage {
  return {
    id: 't1',
    kind: 'tool',
    role: 'assistant',
    createdAt: 1000,
    turnId: 'u1',
    tool: 'mcp__trylo-windows__Click',
    summary: 'click Send',
    status: 'done',
    ...over,
  }
}

function thinking(): ThinkingMessage {
  return {
    id: 'th1',
    kind: 'thinking',
    role: 'assistant',
    createdAt: 900,
    turnId: 'u1',
    turn: 1,
    summary: '考虑下一步',
    preview: '考虑下一步',
    fullLength: 5,
    partial: false,
  }
}

describe('CodeReasoningTranscript takeover badge (§11.3)', () => {
  it('shows the takeover badge when a tool result carries takeover facts', () => {
    render(
      <CodeReasoningTranscript
        entries={[
          thinking(),
          tool({
            outputText: 'clicked.\ntrylo-target:{"window":{"hwnd":10,"pid":20,"digest":"d","title":"Notepad"},"dispatch":"accepted","effect":"confirmed_success","takeover":"safe_release"}',
          }),
        ]}
        active={false}
        turnId="u1"
        phaseId="p1"
      />,
    )
    const badge = document.querySelector('.code-reasoning__takeover-badge')
    expect(badge).not.toBeNull()
    expect(badge?.textContent).toContain('用户接管 · 已安全释放')
  })

  it('no badge when no tool result reports a takeover', () => {
    render(
      <CodeReasoningTranscript
        entries={[
          tool({
            outputText: 'clicked.\ntrylo-target:{"window":{"hwnd":10,"pid":20,"digest":"d","title":"Notepad"},"dispatch":"accepted"}',
          }),
        ]}
        active={false}
        turnId="u1"
        phaseId="p1"
      />,
    )
    expect(document.querySelector('.code-reasoning__takeover-badge')).toBeNull()
  })

  it('no badge for non-computer tools or results without the facts block', () => {
    render(
      <CodeReasoningTranscript
        entries={[
          tool({ tool: 'Bash', outputText: 'ok\ntrylo-target:{"takeover":"yielded"}' }),
        ]}
        active={false}
        turnId="u1"
        phaseId="p1"
      />,
    )
    // Even with the marker present, the parse is only consulted for the
    // managed computer tools — a Bash echo must not fabricate a takeover.
    expect(document.querySelector('.code-reasoning__takeover-badge')).toBeNull()
  })

  it('picks the most severe takeover state across several tool results', () => {
    render(
      <CodeReasoningTranscript
        entries={[
          tool({
            id: 't2',
            outputText: 'trylo-target:{"window":{"hwnd":1,"pid":2,"digest":"d","title":"A"},"takeover":"verifying"}',
          }),
          tool({
            outputText: 'trylo-target:{"window":{"hwnd":3,"pid":4,"digest":"e","title":"B"},"takeover":"safe_release"}',
          }),
        ]}
        active={false}
        turnId="u1"
        phaseId="p1"
      />,
    )
    // safe_release outranks verifying in the severity order.
    const badge = document.querySelector('.code-reasoning__takeover-badge')
    expect(badge?.textContent).toContain('用户接管 · 已安全释放')
  })
})

// Round-2 adversarial audit: MessageList rebuilds every `__code_process`
// item — with a fresh `entries` array — on each streaming delta. The memo's
// custom comparator must treat "same elements, new array" as unchanged, or
// every visible phase block re-renders per delta (the original scroll-jank
// class of bug, back through the Code projection).
describe('CodeReasoningTranscript memoization (round-2 audit)', () => {
  const TAKEOVER_TEXT =
    'clicked.\ntrylo-target:{"window":{"hwnd":10,"pid":20,"digest":"d","title":"Notepad"},"dispatch":"accepted","effect":"confirmed_success","takeover":"safe_release"}';

  function tree(entries: readonly (ThinkingMessage | ToolMessage)[]) {
    return (
      <CodeReasoningTranscript entries={entries} active={false} turnId="u1" phaseId="p1" />
    );
  }

  it('does not re-render when the projection rebuilds the entries array with identical elements', () => {
    const base = [
      thinking(),
      tool({ outputText: TAKEOVER_TEXT }),
    ];
    transcriptProbe.renders = 0;
    const { rerender, container } = render(tree(base));
    expect(transcriptProbe.renders).toBe(0);
    fireEvent.click(container.querySelector('.code-reasoning__head')!);
    const mounted = transcriptProbe.renders;
    expect(mounted).toBe(1);

    // Same message identities in a NEW array — exactly what MessageList's
    // items useMemo produces for untouched phases on every delta.
    rerender(tree([...base]));
    expect(transcriptProbe.renders).toBe(mounted);

    // A second rebuilt array (another delta) must also bail.
    rerender(tree(Array.from(base)));
    expect(transcriptProbe.renders).toBe(mounted);
  });

  it('re-renders when an entry object is replaced (status flip / append)', () => {
    const base = [thinking(), tool({ outputText: TAKEOVER_TEXT, status: 'running' })];
    transcriptProbe.renders = 0;
    const { rerender, container } = render(tree(base));
    expect(transcriptProbe.renders).toBe(0);
    fireEvent.click(container.querySelector('.code-reasoning__head')!);
    const mounted = transcriptProbe.renders;
    expect(mounted).toBe(1);

    // Tool result lands → events.ts replaces the tool message object.
    const completed = [
      base[0]!,
      tool({ outputText: TAKEOVER_TEXT, status: 'done' }),
    ];
    rerender(tree(completed));
    expect(transcriptProbe.renders).toBe(mounted + 1);

    // Append-only growth (new thinking delta arrives as a new message).
    const grown = [...completed, { ...thinking(), id: 'th2', partial: true }];
    rerender(tree(grown));
    expect(transcriptProbe.renders).toBe(mounted + 2);
  });

  it('serves identical takeover facts from the per-entry cache across mounts', () => {
    const entry = tool({ outputText: TAKEOVER_TEXT });
    const first = render(
      <CodeReasoningTranscript entries={[entry]} active={false} turnId="u1" phaseId="p1" />,
    );
    expect(document.querySelector('.code-reasoning__takeover-badge')?.textContent).toContain(
      '用户接管 · 已安全释放',
    );
    first.unmount();

    // The SAME entry object mounted again (scroll-away/scroll-back remount)
    // hits the WeakMap cache and must render the identical badge — not a
    // stale-absent or duplicated row.
    render(
      <CodeReasoningTranscript entries={[entry]} active={false} turnId="u1" phaseId="p2" />,
    );
    expect(document.querySelectorAll('.code-reasoning__takeover-badge')).toHaveLength(1);
    expect(document.querySelector('.code-reasoning__takeover-badge')?.textContent).toContain(
      '用户接管 · 已安全释放',
    );
  });
});
