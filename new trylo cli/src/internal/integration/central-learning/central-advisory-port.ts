import type { CentralRuntimeMaterial } from "../../learning/central/runtime/contracts.js";
import type { createRuntimeCentralAdvisoryPublisher } from "./runtime-central-advisory-publication.js";

/** The original applied checkpoint grants this publisher its decision identity.
 * Neither the caller nor a source adapter supplies a replacement knowledge body. */
export type CentralRuntimeAdvisoryPort = Pick<ReturnType<typeof createRuntimeCentralAdvisoryPublisher>,
  "recordDecision" | "recoverApplied"> & {
    recall?(input: { readonly scope: string; readonly boardSequence: number }, signal: AbortSignal): Promise<readonly CentralRuntimeMaterial[]>;
  };
