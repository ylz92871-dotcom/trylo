/** Enforce only a supplied deadline. Timer segments avoid Node's 32-bit delay overflow. */
export function executionDeadline(delayMs: number | undefined, fire: () => void): { cancel(): void } | undefined {
  if (delayMs === undefined) return undefined;

  let remaining = delayMs;
  let timer: ReturnType<typeof setTimeout>;
  const arm = (): void => {
    const segment = Math.min(remaining, 2_147_483_647);
    remaining -= segment;
    timer = setTimeout(() => { if (remaining > 0) arm(); else fire(); }, segment);
  };

  arm();

  return { cancel: () => { clearTimeout(timer); } };
}
