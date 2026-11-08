import type {
  CapabilityDemand,
  CapabilityRequest,
  CapabilityResponse,
  LibraryResult,
  ToolLibraryCatalog,
  ToolLibraryContext,
  ToolRuntimeReference,
} from '../../../new trylo cli/src/internal/tooling/library/contracts'
import {
  decodeLibraryResult,
  isCapabilityRequest,
  isCapabilityResponse,
  isToolLibraryCatalog,
  isToolRuntimeReferences,
} from '../../../new trylo cli/src/internal/tooling/library/wire'
export type {
  ToolLibraryCatalog,
  ToolLibraryContext,
  ToolLibraryItem,
} from '../../../new trylo cli/src/internal/tooling/library/contracts'

export type ToolLibraryClient = {
  query(
    context: ToolLibraryContext,
    signal: AbortSignal,
  ): Promise<LibraryResult<ToolLibraryCatalog>>
  configure(
    context: ToolLibraryContext,
    ids: readonly string[],
    signal: AbortSignal,
  ): Promise<LibraryResult<readonly ToolRuntimeReference[]>>
  requestCapability(
    context: ToolLibraryContext,
    demand: CapabilityDemand,
    signal: AbortSignal,
  ): Promise<LibraryResult<CapabilityResponse>>
  getRequest(
    context: ToolLibraryContext,
    id: string,
    signal: AbortSignal,
  ): Promise<LibraryResult<CapabilityRequest>>
}
/** Shared protocol owner supplies transport; payloads are checked before the UI uses them. */
export function createToolLibraryClient(
  invoke: (context: ToolLibraryContext, command: unknown, signal: AbortSignal) => Promise<unknown>,
): ToolLibraryClient {
  async function run<T>(
    context: ToolLibraryContext,
    command: unknown,
    signal: AbortSignal,
    accepts: (raw: unknown) => raw is T,
  ): Promise<LibraryResult<T>> {
    try {
      return decodeLibraryResult(await invoke(context, command, signal), accepts)
    } catch (error) {
      return {
        ok: false,
        code: signal.aborted ? 'cancelled' : 'transport_failed',
        message: error instanceof Error ? error.message : '工具库连接失败。',
      }
    }
  }
  return {
    query: (context, signal) =>
      run(context, { operation: 'query', filter: { limit: 256 } }, signal, isToolLibraryCatalog),
    configure: (context, toolIds, signal) =>
      run(context, { operation: 'configure', toolIds }, signal, isToolRuntimeReferences),
    requestCapability: (context, demand, signal) =>
      run(context, { operation: 'request', demand }, signal, isCapabilityResponse),
    getRequest: (context, requestId, signal) =>
      run(context, { operation: 'get-request', requestId }, signal, isCapabilityRequest),
  }
}
