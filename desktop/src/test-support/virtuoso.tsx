import { forwardRef, type ReactNode } from 'react';

/** jsdom has no layout measurements. Preserve the real row renderers. */
export const Virtuoso = forwardRef(function TestVirtuoso(props: {
  readonly data: readonly unknown[];
  readonly itemContent: (index: number, item: unknown) => ReactNode;
}, _ref) {
  return <div>{props.data.map((item, index) => <div key={index}>{props.itemContent(index, item)}</div>)}</div>;
});
