import type { Transcript } from "../protocol/transcript.js";

/** Ephemeral retrieval cue, never asserted business facts or a persisted
 * learning observation. Disabled method learning does not request it. */
export function methodContextCue(transcript: Transcript | undefined): { readonly retrievalCue: string; readonly retrievalSequence: number } | undefined {
  if (transcript === undefined) return undefined;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    if (item?.kind === "user") return { retrievalCue: item.text.slice(0, 1000), retrievalSequence: item.sequence };
  }
  return undefined;
}
