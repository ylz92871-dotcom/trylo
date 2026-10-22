import { createUtf8OutputSink } from "./utf8-output.js";

/**
 * A bounded, cursor-driven buffer for one session's output.
 *
 * Two properties matter more than speed here:
 *
 *  - **It says when it dropped something.** Output that vanishes silently reads
 *    as "the program printed nothing", which is a different fact from "the
 *    program printed more than we kept". Only `dropped` tells them apart, and
 *    callers surface it.
 *  - **Reads are cursors, not replays.** Every read returns what arrived since
 *    the last one, so polling a live session cannot cost more than the output
 *    itself. A caller that wants the beginning keeps it, or asks again after a
 *    restart, rather than silently getting the tail forever.
 *
 * UTF-8 packets are decoded before retention, with at most three pending bytes
 * carried separately. Read caps and eviction boundaries never split a character.
 */

export type BufferRead = {
  readonly text: string;
  /** Bytes were discarded to stay inside the cap. */
  readonly dropped: boolean;
  /** Bytes still held that this read did not return (the cap cut the read). */
  readonly heldBack: number;
};

export type BoundedBuffer = {
  write(chunk: Buffer): void;
  /** Transport ended: publish any genuinely incomplete final UTF-8 fragment. */
  end(): void;
  /** Complete characters within maxReadBytes; a smaller-than-character budget
   * leaves it held back. Production readers have a four-byte minimum. */
  read(maxReadBytes: number): BufferRead;
  readonly byteLength: number;
  readonly dropped: boolean;
  /** Forget the cursor and everything before it. */
  reset(): void;
};

export function createBoundedBuffer(maxBytes: number): BoundedBuffer {
  const cap = Math.max(1, Math.trunc(maxBytes));
  // One growing buffer plus one compacted copy. A long session that never reads
  // would otherwise keep shifting bytes forever inside a single array.
  let held: Buffer = Buffer.alloc(0);
  let cursor = 0;
  let dropped = false;

  const compact = (): void => {
    if (cursor === 0) {
      return;
    }
    held = held.subarray(cursor);
    cursor = 0;
  };

  const continuation = (byte: number | undefined): boolean => byte !== undefined && (byte & 0xC0) === 0x80;
  const append = (chunk: Buffer): void => {
    if (chunk.length === 0) {
      return;
    }
    held = held.length === 0 ? Buffer.from(chunk) : Buffer.concat([held, chunk]);
    if (held.length <= cap) {
      return;
    }
    // Drop from the front. The oldest bytes are the ones a late reader is
    // least likely to want and the ones that keep the buffer bounded.
    let excess = held.length - cap;
    while (excess < held.length && continuation(held[excess])) excess += 1;
    held = held.subarray(excess);
    cursor = 0;
    dropped = true;
  };
  let decoder = createUtf8OutputSink(append);
  return {
    write: chunk => decoder.write(chunk),
    end: () => decoder.end(),
    read(maxReadBytes: number): BufferRead {
      const limit = Math.max(0, Math.trunc(maxReadBytes));
      const unread = held.length - cursor;
      if (unread <= 0) {
        return { text: "", dropped, heldBack: 0 };
      }
      const take = Math.min(unread, limit);
      let end = cursor + take;
      while (end > cursor && end < held.length && continuation(held[end])) end -= 1;
      const text = held.subarray(cursor, end).toString("utf8");
      cursor = end;
      compact();
      return { text, dropped, heldBack: held.length - cursor };
    },
    get byteLength(): number {
      return held.length - cursor;
    },
    get dropped(): boolean {
      return dropped;
    },
    reset(): void {
      held = Buffer.alloc(0);
      cursor = 0;
      dropped = false;
      decoder = createUtf8OutputSink(append);
    },
  };
}
