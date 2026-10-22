import { cutTailToBytes, cutToBytes } from "../../../protocol/text-cut.js";
import { truncateOutput } from "./output-limits.js";

/** Bounded while collecting, rather than only when the process eventually exits. */
export class OutputCapture {
  private head = "";
  private tail = "";
  private produced = 0;
  private dropped = false;
  private readonly budget: number;

  constructor(maxBytes: number) { this.budget = Math.max(0, Math.trunc(maxBytes)); }

  get retainedBytes(): number { return Buffer.byteLength(this.head) + Buffer.byteLength(this.tail); }
  get producedBytes(): number { return this.produced; }

  write(chunk: string): void {
    this.produced += Buffer.byteLength(chunk);
    if (!this.dropped && this.produced <= this.budget) { this.head += chunk; return; }
    const tailBudget = Math.floor(this.budget / 2);
    if (!this.dropped) {
      this.tail = cutTailToBytes(this.head + chunk, tailBudget);
      this.head = cutToBytes(this.head + chunk, this.budget - tailBudget);
      this.dropped = true;
    } else {
      this.tail = cutTailToBytes(this.tail + chunk, tailBudget);
    }
  }

  read(maxLines: number): { readonly text: string; readonly truncated: boolean } {
    if (!this.dropped) {
      const result = truncateOutput(this.head, { maxBytes: this.budget, maxLines });
      return { text: result.text, truncated: result.truncated };
    }
    const marker = `[…output omitted; ${this.produced} bytes produced…]`;
    const available = this.budget - Buffer.byteLength(marker);
    const head = cutToBytes(this.head, Math.ceil(available / 2));
    const tail = cutTailToBytes(this.tail, available - Buffer.byteLength(head));
    const text = available < 0 ? cutToBytes("omitted", this.budget) : head + marker + tail;
    return { text: truncateOutput(text, { maxBytes: this.budget, maxLines }).text, truncated: true };
  }
}
