export type WorkflowBoundedCompletion<T> = { readonly kind: "completed"; readonly value: T }
  | { readonly kind: "cancelled" } | { readonly kind: "failed" };

/** Late values and rejections are consumed without publication authority. */
export async function awaitWorkflowProposal<T>(run: () => Promise<T>, signal: AbortSignal): Promise<WorkflowBoundedCompletion<T>> {
  if (signal.aborted) return { kind: "cancelled" };
  return new Promise(resolve => {
    let pending = true;
    const complete = (result: WorkflowBoundedCompletion<T>) => {
      if (!pending) return;
      pending = false;
      signal.removeEventListener("abort", cancel);
      resolve(result);
    };
    const cancel = () => complete({ kind: "cancelled" });

    signal.addEventListener("abort", cancel, { once: true });
    Promise.resolve().then(() => signal.aborted ? undefined : run()).then(value => {
      if (value === undefined && signal.aborted) complete({ kind: "cancelled" });
      else complete({ kind: "completed", value: value as T });
    }, () => complete({ kind: "failed" }));
  });
}

/** Storage may be unavailable; unresolved reservations already retain their full charge. */
export async function workflowSettlementWithin(work: Promise<unknown>, graceMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), graceMs); })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
