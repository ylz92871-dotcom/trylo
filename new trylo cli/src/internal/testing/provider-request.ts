import type { ProviderEvent, ProviderPort, ProviderRequest } from "../ports/provider.js";

/** Test callers follow the same explicit preparation boundary as the execution loop. */
export async function* streamPreparedProvider(provider: ProviderPort, request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
  const preparation = await provider.prepareRequest?.(request, signal);
  yield* provider.stream(preparation?.apply(request) ?? request, signal);
}
