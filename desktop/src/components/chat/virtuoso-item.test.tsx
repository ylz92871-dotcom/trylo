// The Virtuoso item wrapper is the round-3 jitter root-cause fix: Virtuoso
// measures rows through this wrapper, and its default plain-block version
// lets the row roots' vertical margins collapse through it — every row
// measured short, offsets drifting, scroll correcting forever. This locks
// the wrapper contract: BFC established, Virtuoso's measurement attributes
// and styles preserved, bookkeeping props kept out of the DOM.
import { createRef } from 'react';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import { VirtuosoItem } from './virtuoso-item';
import type { ChatMessage } from './types';
import type { FooterContext, ListItem } from './MessageList';

const row: ChatMessage = {
  id: 'a1',
  kind: 'text',
  role: 'assistant',
  createdAt: 200,
  text: 'row content',
};

const ctx: FooterContext = {
  showStreamingFooter: false,
  reserveFooterSlot: false,
  viewState: 'idle',
};

describe('VirtuosoItem wrapper contract', () => {
  it('establishes a BFC while preserving Virtuoso style and attributes', () => {
    const ref = createRef<HTMLDivElement>();
    const { container } = render(
      <VirtuosoItem
        ref={ref}
        item={row as unknown as ListItem}
        context={ctx}
        style={{ overflowAnchor: 'none', zIndex: 1 }}
        data-index={3}
        data-item-index={3}
        data-known-size={120}
      >
        <div className="message">row content</div>
      </VirtuosoItem>,
    );
    const el = container.firstElementChild as HTMLElement;
    // The BFC: child margins are contained inside the measured box.
    expect(el.style.display).toBe('flow-root');
    // Virtuoso's own wrapper style survives the merge.
    expect(el.style.overflowAnchor).toBe('none');
    expect(el.style.zIndex).toBe('1');
    // The measurement walk identifies rows by these attributes.
    expect(el.dataset.index).toBe('3');
    expect(el.dataset.itemIndex).toBe('3');
    expect(el.dataset.knownSize).toBe('120');
    // Children render inside.
    expect(el.textContent).toBe('row content');
    // Ref forwarding works (whatever Virtuoso attaches lands on the element).
    expect(ref.current).toBe(el);
  });

  it('keeps Virtuoso bookkeeping props out of the DOM', () => {
    const { container } = render(
      <VirtuosoItem
        item={row as unknown as ListItem}
        context={{ ...ctx, reserveFooterSlot: true }}
        data-index={0}
        data-item-index={0}
        data-known-size={0}
      />,
    );
    const el = container.firstElementChild as HTMLElement;
    expect(el.hasAttribute('context')).toBe(false);
    expect(el.hasAttribute('item')).toBe(false);
    // [object Object] leaking into a class/attribute would break the walk.
    expect(el.outerHTML).not.toContain('[object Object]');
  });
});
