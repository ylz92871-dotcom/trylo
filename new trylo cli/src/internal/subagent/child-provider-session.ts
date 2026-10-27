import type { ProviderContinuationPort, ProviderMessage, ProviderPort } from "../ports/provider.js";
import { SubagentGovernanceError } from "./governance.js";

export type ChildProviderSession = {
  readonly provider: ProviderPort;
  readonly close: () => void;
};

/** One isolated adapter and native scope for a logical task, across physical
 * executions and rounds. Adapter-owned bounded state remains authoritative;
 * canonical display reasoning never seeds it, and sibling tasks never share it.
 */
export function createChildProviderSession(source: ProviderPort, history?: ReadonlyArray<ProviderMessage>): ChildProviderSession {
  let transport: ProviderPort | undefined = source.fork?.(history) ?? source;
  if (source.fork === undefined && source.continuation !== undefined) {
    throw new SubagentGovernanceError("subagent_provider_isolation_unavailable", "A stateful child provider must support independent fork instances");
  }
  let taskScope: string | undefined;
  const native = transport.continuation;
  const continuation: ProviderContinuationPort | undefined = native === undefined ? undefined : {
    bindCanonicalResponse: input => { if (taskScope !== undefined) native.bindCanonicalResponse?.({ ...input, scope: taskScope }); },
    capture: () => taskScope === undefined ? undefined : native.capture(taskScope),
    acknowledgeNotice: id => { native.acknowledgeNotice?.(id); },
    ...(native.estimateOverheadTokens === undefined ? {} : { estimateOverheadTokens: native.estimateOverheadTokens }),
    restore: input => { native.restore(input); },
  };
  return {
    provider: {
      ...(continuation === undefined ? {} : { continuation }),
      async *stream(request, signal) {
        if (transport === undefined) throw new SubagentGovernanceError("agent_closed", "The retained child provider session has been released");
        taskScope ??= request.continuationScope;
        yield* transport.stream({ ...request, ...(taskScope === undefined ? {} : { continuationScope: taskScope }) }, signal);
      },
    },
    close: () => {
      // Release bounded native payloads even when a retained alias still points
      // at this now-closed session. No transcript/display content is restored.
      native?.restore({ sessionId: "released-child", turnId: "released", records: [] });
      transport = undefined; taskScope = undefined;
    },
  };
}
