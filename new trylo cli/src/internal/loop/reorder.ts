export const MAX_REORDER = 16;

export type ReorderPush<T> =
  | { readonly overflow: false; readonly ready: readonly T[] }
  | { readonly overflow: true; readonly ready: readonly [] };

export type ReorderBuffer<T> = {
  push(producerSequence: number, value: T): ReorderPush<T>;
};

export function createReorderBuffer<T>(max = MAX_REORDER): ReorderBuffer<T> {
  let next = 0;
  const pending = new Map<number, T>();

  return {
    push(producerSequence, value) {
      if (producerSequence < next) {
        return { overflow: false, ready: [] };
      }

      if (producerSequence === next) {
        const ready: T[] = [value];

        next += 1;

        while (pending.has(next)) {
          const item = pending.get(next);
          if (item !== undefined) {
            ready.push(item);
          }
          pending.delete(next);
          next += 1;
        }

        return { overflow: false, ready };
      }

      if (pending.size >= max) {
        return { overflow: true, ready: [] };
      }

      pending.set(producerSequence, value);

      return { overflow: false, ready: [] };
    },
  };
}
