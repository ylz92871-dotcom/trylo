import type { ImageReferenceAccess, ValidatedImageReferenceSink } from "../../ports/image-reference-access.js";
import type { FileAccessMode } from "../../ports/tools.js";
import type { RunExecution } from "./run-execution-wiring.js";
import { createImageReferenceRegistry } from "../../adapters/media/image-reference-access.js";

type ImageScope = { readonly read: ImageReferenceAccess; readonly record: ValidatedImageReferenceSink; close(): void };

/** A prepared session lends its snapshots; library turns own only their own. */
export function imageReferencesFor(input: { readonly execution?: RunExecution; readonly fileAccess?: FileAccessMode }): ImageScope | undefined {
  const lent = input.execution?.imageReferences;
  if (lent === undefined && (input.fileAccess === undefined || input.fileAccess === "workspace")) return undefined;
  const references = lent ?? createImageReferenceRegistry();
  return {
    read: { resolve: references.resolve },
    record: references.register,
    close() {
      // Borrowed snapshots belong to the prepared session, not this turn.
      if (lent === undefined) references.clear();
    },
  };
}
