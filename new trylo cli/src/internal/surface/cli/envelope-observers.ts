import type { Envelope } from "../../protocol/envelope.js";

type EnvelopeObserver = (event: Envelope) => void;

/** Preserve render/learning/host order at the single CLI event fan-out seam. */
export function combineEnvelopeObservers(...observers: readonly (EnvelopeObserver | undefined)[]): EnvelopeObserver {
  const active = observers.filter((observer): observer is EnvelopeObserver => observer !== undefined);
  if (active.length === 1) return active[0]!;
  return event => { for (const observer of active) observer(event); };
}
