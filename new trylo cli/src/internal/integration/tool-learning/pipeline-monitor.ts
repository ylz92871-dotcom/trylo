import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";

/** Board owns cancellation. A detached worker must stop if its claim is no longer current. */
export function monitorToolJob(input: { readonly boardRoot: string; readonly jobId: string; readonly attempt: number; readonly signal: AbortSignal }) {
  const controller = new AbortController(), forward = () => controller.abort();
  input.signal.addEventListener("abort", forward, { once: true });
  if (input.signal.aborted) forward();
  let reading = false, closed = false;
  const check = async () => {
    if (reading || closed || controller.signal.aborted) return;
    reading = true;
    try {
      const loaded = await createBoardReader(input.boardRoot).load();
      const job = loaded.ok ? loaded.state.jobs.find(item => item.jobId === input.jobId) : undefined;
      if (!loaded.ok || job?.state !== "running" || job.attempt !== input.attempt) controller.abort();
    } catch {
      // Lost ownership is fail-closed; do not keep spending model/execution budget.
      controller.abort();
    } finally { reading = false; }
  };
  const timer = setInterval(() => { void check(); }, 1_000);
  return { signal: controller.signal, check, close() { closed = true; clearInterval(timer); input.signal.removeEventListener("abort", forward); } };
}
