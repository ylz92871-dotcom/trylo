/** A declared capacity bounds the working window; it does not select it. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

export function resolveContextWindow(preferred: number | undefined, ...capacities: readonly (number | undefined)[]): number {
  return Math.min(preferred ?? DEFAULT_CONTEXT_WINDOW, ...capacities.filter((value): value is number => value !== undefined));
}
