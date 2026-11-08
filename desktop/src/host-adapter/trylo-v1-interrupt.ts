/** Shared cancellation policy for controller-owned and reconnected new CLI turns. */
export const CLI_INTERRUPT_GRACE_MS = 3000

export function cliInterruptFrame(processId: string): string {
  return `${JSON.stringify({
    type: 'control_request',
    request_id: `interrupt-${processId}`,
    request: { subtype: 'interrupt' },
  })}\n`
}

/** Releases only this waiter. A late IO receipt never changes process ownership. */
export async function completesWithin(
  completion: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      completion.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function requestCliInterrupt(input: {
  readonly processId: string
  readonly send: (id: string, frame: string) => Promise<void>
  readonly exited: Promise<void>
}): Promise<boolean> {
  try {
    const sent = Promise.resolve().then(() =>
      input.send(input.processId, cliInterruptFrame(input.processId)),
    )
    return await completesWithin(
      Promise.race([input.exited, sent.then(() => input.exited)]),
      CLI_INTERRUPT_GRACE_MS,
    )
  } catch {
    // A refused/broken input channel does not confirm exit. The owner must
    // retain its immutable native id and use its explicit force-stop fallback.
    return false
  }
}
