import type { CliContext } from "./context.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";

/** First interrupt drains the ordinary cancellation path; a second forces exit. */
export function observeRunCancellation(ctx: CliContext): { readonly signal: AbortSignal; readonly close: () => void } {
  const controller = new AbortController();
  let active = true;
  const handler = () => {
    if (!active) return;
    if (controller.signal.aborted) ctx.interrupts?.exit(EXIT_CODES.CANCELLED);
    else controller.abort();
  };

  ctx.interrupts?.observe(handler);

  return {
    signal: controller.signal,

    close: () => {
      active = false;
      ctx.interrupts?.unobserve?.(handler);
    },
  };
}
