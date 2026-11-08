import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import type { ChatMessage } from './types';
import type { ListItem } from './MessageList';
import { readFileSync } from 'node:fs';
const bookshelfCss = readFileSync('src/styles/components/conversation-bookshelf.css', 'utf8');

const state = vi.hoisted(() => ({ scroll: vi.fn(), data: [] as readonly ListItem[] }));
vi.mock('react-virtuoso', () => ({
  Virtuoso: forwardRef(function FakeVirtuoso(props: Record<string, unknown>, ref) {
    const data = props.data as readonly ListItem[];
    state.data = data;
    const [index, setIndex] = useState(Math.max(0, data.length - 1));
    const node = useRef<HTMLDivElement>(null);
    useImperativeHandle(ref, () => ({
      scrollToIndex: (value: { index: number }) => {
        state.scroll(value);
        setIndex(value.index);
      },
    }));
    useLayoutEffect(() => {
      (props.scrollerRef as (node: HTMLElement | null) => void)(node.current);
      return () => {
        (props.scrollerRef as (node: null) => void)(null);
      };
    }, [props.scrollerRef]);
    const Item = (props.components as { Item: React.ElementType }).Item;
    return (
      <div ref={node} data-virtuoso-scroller="true">
        {data.slice(index, index + 2).map((item, offset) => (
          <Item
            key={'id' in item ? item.id : item.key}
            item={item}
            data-index={index + offset}
            data-item-index={index + offset}
            data-known-size={80}
          >
            {(props.itemContent as (index: number, item: ListItem) => ReactElement)(
              index + offset,
              item,
            )}
          </Item>
        ))}
      </div>
    );
  }),
}));
vi.mock('./Message', () => ({
  Message: ({ message }: { message: ChatMessage }) => (
    <div>{message.kind === 'text' ? message.text : message.kind}</div>
  ),
}));
import { MessageList } from './MessageList';

const messages: ChatMessage[] = [
  { id: 'q-first', kind: 'text', role: 'user', text: 'First question', createdAt: 1 },
  {
    id: 'a-first',
    kind: 'text',
    role: 'assistant',
    text: 'First answer',
    createdAt: 2,
    turnId: 'q-first',
  },
  { id: 'q-last', kind: 'text', role: 'user', text: 'Last question', createdAt: 3 },
  {
    id: 'a-last',
    kind: 'text',
    role: 'assistant',
    text: 'Last answer',
    createdAt: 4,
    turnId: 'q-last',
  },
];
let style: HTMLStyleElement;
beforeEach(() => {
  state.scroll.mockClear();
  style = document.createElement('style');
  style.textContent = bookshelfCss;
  document.head.append(style);
});
afterEach(() => {
  cleanup();
  style.remove();
});

describe('MessageList bookshelf wiring', () => {
  it.each(['code', 'work'] as const)(
    'locates a virtualized-away question by stable identity on %s, then preserves history reading during streaming',
    async (surface) => {
      const view = render(<MessageList messages={messages} surface={surface} running />);
      expect(screen.queryByText('First question')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /展开对话书架/ }));
      const trigger = screen.getByRole('button', { name: '第 1 次提问：First question' });
      fireEvent.click(trigger);
      await waitFor(() =>
        expect(view.container.querySelector('.conversation-row[data-conversation-question="q-first"]')).toHaveTextContent('First question'),
      );
      const last = state.scroll.mock.calls.at(-1)?.[0] as { index: number };
      expect(state.data[last.index]).toMatchObject({ id: 'q-first' });
      await waitFor(() =>
        expect(document.activeElement?.getAttribute('data-conversation-question')).toBe('q-first'),
      );
      const calls = state.scroll.mock.calls.length;
      view.rerender(
        <MessageList
          messages={[
            ...messages.slice(0, -1),
            {
              ...messages[3]!,
              kind: 'text',
              role: 'assistant',
              text: 'streaming update',
              partial: true,
            },
          ]}
          surface={surface}
          running
        />,
      );
      await waitFor(() => expect(state.scroll).toHaveBeenCalledTimes(calls));
      expect(
        view.container.querySelector('.conversation-bookshelf')?.getAttribute('data-expanded'),
      ).toBe('false');
    },
  );
  it('patches the open shelf on a new assistant snapshot and clears transient state on a session remount', () => {
    const view = render(<MessageList key="A" messages={messages} />);
    fireEvent.click(screen.getByRole('button', { name: /展开对话书架/ }));
    const first = screen.getByRole('button', { name: '第 1 次提问：First question' });
    view.rerender(
      <MessageList
        key="A"
        messages={[
          ...messages,
          {
            id: 'a-next',
            kind: 'text',
            role: 'assistant',
            text: 'new received output',
            turnId: 'q-last',
            createdAt: 5,
          },
        ]}
      />,
    );
    expect(screen.getByRole('button', { name: '第 1 次提问：First question' })).toBe(first);
    view.rerender(
      <MessageList
        key="B"
        messages={messages.map((message) => ({ ...message, id: 'B-' + message.id }))}
      />,
    );
    expect(
      view.container.querySelector('.conversation-bookshelf')?.getAttribute('data-expanded'),
    ).toBe('false');
    expect(view.container.querySelector('[data-book]')).toBeNull();
  });
});
