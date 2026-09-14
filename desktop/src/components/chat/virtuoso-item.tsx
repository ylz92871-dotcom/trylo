// Trylo Desktop — the Virtuoso item wrapper (components.Item).
//
// The row roots (.message, .code-reasoning, .tool, …) carry vertical margins
// for inter-row spacing. Virtuoso measures every row through its wrapper,
// and the DEFAULT wrapper is a plain block: the child's margins collapse
// through it, so every row measures ~10px SHORT of what the layout actually
// renders. The error accumulates per row, and Virtuoso keeps correcting the
// scroll offset while scrolling — the classic virtualized "reverse scroll
// jitter" (virtuoso.dev troubleshooting calls margins on items the most
// common setup error; discussion #1083 names the same cause).
//
// Establishing a BFC on the wrapper (`display: flow-root`) contains the
// child's margins INSIDE the measured box: measurements match the layout,
// no component CSS has to change, and future row components cannot
// reintroduce the bug. `context` / `item` are Virtuoso bookkeeping, not DOM
// attributes, so they are stripped before the spread.
import { forwardRef, type ReactElement } from 'react';
import type { ContextProp, ItemProps } from 'react-virtuoso';
import type { FooterContext, ListItem } from './MessageList';

export const VirtuosoItem = forwardRef<
  HTMLDivElement,
  ItemProps<ListItem> & ContextProp<FooterContext>
>(function VirtuosoItem(props, ref): ReactElement {
  const { item: _item, context: _context, ...rest } = props;
  void _item;
  void _context;
  return <div {...rest} ref={ref} style={{ ...props.style, display: 'flow-root' }} />;
});
