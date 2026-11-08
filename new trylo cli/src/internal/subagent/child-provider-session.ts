import type { ProviderContinuationPort, ProviderMessage, ProviderPort, ProviderRequest } from "../ports/provider.js";
import { SubagentGovernanceError } from "./governance.js";

export type ChildProviderSession = {
  readonly provider: ProviderPort;
  readonly close: () => void;
};

/** One isolated adapter and native scope for a logical task, across physical
 * executions and rounds. Adapter-owned bounded state remains authoritative;
 * canonical display reasoning never seeds it, and sibling tasks never share it.
 */
export function createChildProviderSession(source: ProviderPort, history?: ReadonlyArray<ProviderMessage>, model?: string): ChildProviderSession {
  let transport: ProviderPort | undefined = source.fork?.(history, model === undefined ? undefined : { model }) ?? source;

  if (source.fork === undefined && source.continuation !== undefined) {
    throw new SubagentGovernanceError("subagent_provider_isolation_unavailable", "A stateful child provider must support independent fork instances");
  }

  let taskScope: string | undefined;
  const activeTransport = (): ProviderPort => {
    if (transport === undefined) throw new SubagentGovernanceError("agent_closed", "The retained child provider session has been released");
    return transport;
  };
  const scopedRequest = (request: ProviderRequest): ProviderRequest => {
    const scope = taskScope ?? request.continuationScope;
    return { ...request, ...(scope === undefined ? {} : { continuationScope: scope }) };
  };
  const native = transport.continuation;
  const continuation: ProviderContinuationPort | undefined = native === undefined ? undefined : {
    bindCanonicalResponse: input => { if (taskScope !== undefined) native.bindCanonicalResponse?.({ ...input, scope: taskScope }); },
    capture: () => taskScope === undefined ? undefined : native.capture(taskScope),
    acknowledgeNotice: id => { native.acknowledgeNotice?.(id); },
    ...(native.estimateOverheadTokens === undefined ? {} : { estimateOverheadTokens: native.estimateOverheadTokens }),
    ...(native.measureRequestIdentity === undefined ? {} : { measureRequestIdentity: request => {
      activeTransport();
      return native.measureRequestIdentity!(scopedRequest(request));
    } }),
    restore: input => { native.restore(input); },
  };

  return {
    provider: {
      ...(transport.inputBindingDigest === undefined ? {} : { inputBindingDigest: request => transport?.inputBindingDigest?.(request) }),
      ...(transport.prepareRequest === undefined ? {} : { async prepareRequest(request, signal) {
        const prepared = await activeTransport().prepareRequest!(scopedRequest(request), signal);
        activeTransport();
        return { apply: current => {
          activeTransport();
          return scopedRequest(prepared.apply(scopedRequest(current)));
        } };
      } }),
      ...(continuation === undefined ? {} : { continuation }),
      async *stream(request, signal) {
        const current = activeTransport();
        taskScope ??= request.continuationScope;
        yield* current.stream(scopedRequest(request), signal);
      },
    },
    close: () => {
      // Release bounded native payloads even when a retained alias still points
      // at this now-closed session. No transcript/display content is restored.
      native?.restore({ sessionId: "released-child", turnId: "released", records: [] });
      transport = undefined;
      taskScope = undefined;
    },
  };
}
