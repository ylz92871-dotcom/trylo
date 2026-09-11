// Regression guard for the v1.18 follow-mode rewrite.
//
// These tests deliberately do NOT mock react-virtuoso — the earlier
// implementation shipped with a render loop that only appeared when
// the real Virtuoso was mounted:
//
//   scrollToIndex → atBottomStateChange → setState → re-render
//     → Virtuoso re-invokes followOutput → returns true
//     → Virtuoso scrolls again → …
//
// The loop froze the main thread, so the whole app rendered black.
// Mocking Virtuoso hid it completely, which is why this file uses the
// real component with a fixed-height container.

import { Profiler, StrictMode, useState, type ReactElement } from 'react';
import { act, render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from './types';
import { MessageList } from './MessageList';

function user(id: string, text: string, createdAt: number): ChatMessage {
  return {
    id,
    kind: 'text',
    role: 'user',
    createdAt,
    text,
    turnStartedAt: createdAt,
  };
}

function assistant(id: string, text: string, createdAt: number): ChatMessage {
  return { id, kind: 'text', role: 'assistant', createdAt, text };
}

/** Drives `MessageList` through a simulated streaming run while
 *  counting how many times the subtree actually renders. A follow-mode
 *  feedback loop shows up as an unbounded (or "Maximum update depth")
 *  render count. */
function StreamingHarness(): ReactElement {
  const [messages, setMessages] = useState<readonly ChatMessage[]>([
    user('u1', 'first question', 100),
  ]);

  // Expose an imperative trigger the test can fire.
  (globalThis as unknown as { __push: (n: number) => void }).__push = (n: number) => {
    setMessages((prev) => [
      ...prev,
      assistant(`a${n}`, `chunk ${n}`, 200 + n),
    ]);
  };

  return (
    <div style={{ height: 400 }}>
      <MessageList
        messages={messages}
        running
        surface="code"
      />
    </div>
  );
}

describe('MessageList follow mode (real Virtuoso)', () => {
  it('mounts with the real Virtuoso without erroring', () => {
    // NOTE: with the real Virtuoso, jsdom renders the item list
    // `visibility: hidden` until a layout pass measures it — jsdom has
    // no layout engine, so item TEXT never becomes visible here. The
    // valuable assertion is "mounts and renders the shell without
    // throwing"; content assertions belong to MessageList.test.tsx,
    // which mocks Virtuoso for exactly that reason.
    const { container } = render(
      <div style={{ height: 400 }}>
        <MessageList
          messages={[user('u1', 'hello', 100), assistant('a1', 'hi', 200)]}
          running={false}
          surface="code"
        />
      </div>,
    );
    expect(container.querySelector('.message-list')).toBeTruthy();
    expect(container.querySelector('[data-virtuoso-scroller]')).toBeTruthy();
  });

  it('survives a burst of streaming updates without a render loop', () => {
    let renderCount = 0;
    const onRender = (): void => {
      renderCount += 1;
    };

    render(
      <StrictMode>
        <Profiler id="message-list" onRender={onRender}>
          <StreamingHarness />
        </Profiler>
      </StrictMode>,
    );

    const baseline = renderCount;
    expect(baseline).toBeGreaterThan(0);

    // Simulate a stream: 40 deltas, each producing a new `messages`
    // array identity (exactly what a live run does).
    const push = (globalThis as unknown as { __push: (n: number) => void }).__push;
    for (let i = 0; i < 40; i += 1) {
      act(() => push(i));
    }

    // The critical assertion: a follow-mode feedback loop would either
    // throw "Maximum update depth exceeded" (failing the test) or
    // render orders of magnitude more than the number of updates. We
    // allow generous headroom for StrictMode double-rendering plus
    // Virtuoso's own internal measurement passes, but an unbounded
    // loop blows straight past this.
    expect(renderCount).toBeLessThan(baseline + 400);
  });
});
