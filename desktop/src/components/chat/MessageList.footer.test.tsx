// Round-3/4 jitter fix contract: the footer's indicator slot must keep its
// height for the whole live run. The dots show only in footer-primary states
// (thinking / preparing) but a workflow run flips thinking↔tool_running
// constantly; without the reserved slot, every flip changed the list's tail
// height, flipped Virtuoso's at-bottom state, and flashed the follow pill.
import { render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import { ListFooter, type FooterContext } from './MessageList';

function ctx(over: Partial<FooterContext>): FooterContext {
  return {
    showStreamingFooter: false,
    reserveFooterSlot: false,
    viewState: 'idle',
    ...over,
  };
}

function slot(el: HTMLElement): HTMLElement | null {
  return el.querySelector('.message-list__footer-slot');
}

describe('MessageList footer slot (round-3 jitter fix)', () => {
  it('reserves the slot while a run is live even when the dots are hidden', () => {
    // tool_running: no dots, but the run is live → the slot must stay
    // pinned so the next thinking delta cannot grow the tail.
    const { container } = render(
      <ListFooter context={ctx({ showStreamingFooter: false, reserveFooterSlot: true, viewState: 'tool_running' })} />,
    );
    const s = slot(container);
    expect(s).not.toBeNull();
    expect(s?.className).toContain('message-list__footer-slot--pinned');
    expect(s?.querySelector('.streaming-indicator')).toBeNull();
  });

  it('renders the dots inside the pinned slot without changing its class', () => {
    const pinned = render(
      <ListFooter context={ctx({ showStreamingFooter: true, reserveFooterSlot: true, viewState: 'thinking' })} />,
    );
    expect(slot(pinned.container)?.className).toContain('message-list__footer-slot--pinned');
    expect(slot(pinned.container)?.querySelector('.streaming-indicator')).not.toBeNull();
  });

  it('collapses the slot when idle (no run, no dots)', () => {
    const { container } = render(
      <ListFooter context={ctx({ showStreamingFooter: false, reserveFooterSlot: false, viewState: 'idle' })} />,
    );
    expect(slot(container)?.className).not.toContain('--pinned');
    expect(slot(container)?.querySelector('.streaming-indicator')).toBeNull();
  });

  it('keeps the breathing spacer outside the reserved slot', () => {
    const { container } = render(
      <ListFooter context={ctx({ showStreamingFooter: true, reserveFooterSlot: true, viewState: 'thinking' })} />,
    );
    const stack = container.querySelector('.message-list__footer-stack');
    const children = Array.from(stack?.children ?? []);
    expect(children).toHaveLength(2);
    expect(children[0]?.className).toContain('message-list__footer-slot');
    expect((children[1] as HTMLElement).style.height).toBe('120px');
  });
});
