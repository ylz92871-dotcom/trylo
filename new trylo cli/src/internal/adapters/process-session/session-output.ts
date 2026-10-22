import type { ChildProcess } from "node:child_process";
import type { BoundedBuffer } from "./output-buffer.js";
import { createUtf8OutputSink } from "./utf8-output.js";

/** One stream owner per session, independent UTF-8 carry per channel. Durable
 * publication keeps the original bytes; the polling buffer gets complete text. */
export function attachSessionOutput(record: {
  readonly child: ChildProcess;
  readonly buffer: BoundedBuffer;
  readonly waiters: ReadonlySet<() => void>;
}, publish: (chunk: Buffer) => void): void {
  const wake = (): void => { for (const waiter of [...record.waiters]) waiter(); };
  const streams = [record.child.stdout, record.child.stderr].filter(stream => stream !== null);
  let open = streams.length;
  const closers: Array<() => void> = [];
  for (const stream of streams) {
    const decoder = createUtf8OutputSink(bytes => record.buffer.write(bytes));
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      decoder.end();
      if (--open === 0) record.buffer.end();
      wake();
    };
    closers.push(close);
    stream.on("data", (chunk: Buffer) => { decoder.write(chunk); publish(chunk); wake(); });
    stream.once("end", close);
    stream.once("close", close);
  }
  record.child.once("close", () => { for (const close of closers) close(); });
}
