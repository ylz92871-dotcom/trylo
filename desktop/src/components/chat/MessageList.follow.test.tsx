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
import { act, cleanup, render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from './types';
import { MessageList } from './MessageList';
afterEach(cleanup);

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
    // NOTE: with the real Virtuoso, jsdom has no layout engine — no item
    // wrappers render at all until a real measurement pass runs (see the
    // diag: the item list stays empty and `visibility: hidden`). The
    // valuable assertion is "mounts and renders the shell without
    // throwing"; content assertions belong to MessageList.test.tsx,
    // which mocks Virtuoso for exactly that reason. The BFC wrapper
    // contract is unit-tested in virtuoso-item.test.tsx.
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

// ── Round-3 (P1-6 → P0): the run-end pin and the live-only pill ────────────
//
// jsdom has no layout, but it DOES persist `scrollTop` and lets a test pin
// `scrollHeight`/`clientHeight`, so the geometry the pin reads can be faked
// and the resulting write observed. That is what these cases do — they drive
// the REAL component (real Virtuoso, real scroll listener), not a mock.
//
// The window defect they lock down: a turn had already produced a complete
// summary on disk, yet the view sat where it was two screenshots earlier and
// the only cue was the ↓ pill. A successful delivery must not be able to look
// like a silent failure.

/** Fake the scroller geometry jsdom refuses to compute, and return the el. */
function fakeLayout(scroller: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: clientHeight });
}

/** Move the view and fire the scroll event the component listens to. */
function userScroll(scroller: HTMLElement, scrollTop: number): void {
  act(() => {
    scroller.dispatchEvent(new KeyboardEvent('keydown', { key: scrollTop < scroller.scrollTop ? 'PageUp' : 'PageDown', bubbles: true }));
    scroller.scrollTop = scrollTop;
    scroller.dispatchEvent(new Event('scroll'));
  });
}

function LiveHarness(): ReactElement {
  const [running, setRunning] = useState(true);
  (globalThis as unknown as { __stop: () => void }).__stop = () => setRunning(false);
  return (
    <div style={{ height: 400 }}>
      <MessageList
        messages={[user('u1', '做一个总结', 100), assistant('a1', '这是完整的总结', 200)]}
        running={running}
        surface="code"
      />
    </div>
  );
}

describe('MessageList respects history reading at completion', () => {
  it('lets End explicitly resume follow from history', () => {
    const { container } = render(<LiveHarness />);
    const scroller = container.querySelector('[data-virtuoso-scroller]') as HTMLElement;
    fakeLayout(scroller, 3000, 600);
    userScroll(scroller, 2400);
    userScroll(scroller, 400);
    act(() => { scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })); });
    expect(scroller.scrollTop).toBe(3000);
    expect(container.querySelector('.message-list__scroll-btn--show')).toBeNull();
  });

  it('preserves the reading position and return button on completion', () => {
    const { container } = render(<LiveHarness />);
    const scroller = container.querySelector('[data-virtuoso-scroller]') as HTMLElement;
    fakeLayout(scroller, 3000, 600);
    // Seed the geometry (the first observation can only establish a baseline),
    // then the reader scrolls up mid-run: follow disarms, the view sits 2500px
    // above the ending and the live-run pill appears.
    userScroll(scroller, 2900);
    userScroll(scroller, 400);
    expect(container.querySelector('.message-list__scroll-btn--show')).not.toBeNull();

    const stop = (globalThis as unknown as { __stop: () => void }).__stop;
    act(() => stop());

    // Completion preserves the reader's position and return action.
    expect(scroller.scrollTop).toBe(400);
    expect(container.querySelector('.message-list__scroll-btn--show')).not.toBeNull();
  });

  it('offers a return button when scrolling up after completion', () => {
    const { container } = render(<LiveHarness />);
    const scroller = container.querySelector('[data-virtuoso-scroller]') as HTMLElement;
    fakeLayout(scroller, 3000, 600);
    const stop2 = (globalThis as unknown as { __stop: () => void }).__stop;
    act(() => stop2());
    // History reading still offers an explicit path back to the final answer.
    userScroll(scroller, 2400);
    userScroll(scroller, 200);
    expect(container.querySelector('.message-list__scroll-btn--show')).not.toBeNull();
  });
});
