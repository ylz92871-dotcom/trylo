import { runCliCommand } from '../host-adapter/cli-command';
import type { ToolLearningRuntime } from '../tool-learning/cli-status';
import type { AgentLearningDomain, AgentLearningDocument, AgentLearningEntry } from '../../../new trylo cli/src/internal/protocol/agent-learning-read';

export type { AgentLearningDomain, AgentLearningDocument, AgentLearningEntry };
export class AgentLearningReadError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'AgentLearningReadError'; }
}
const row = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
function isDocument(value: unknown, domain: AgentLearningDomain): value is AgentLearningDocument {
  if (!row(value) || value.domain !== domain || !text(value.id) || value.id !== value.versionId
    || !text(value.title) || typeof value.summary !== 'string' || !text(value.status) || !text(value.source) || !text(value.scope)
    || !row(value.content) || typeof value.markdown !== 'string' || typeof value.raw !== 'string'
    || (value.createdAt !== undefined && !text(value.createdAt))) return false;
  return value.related === undefined || Array.isArray(value.related) && value.related.every(row);
}

/** A malformed or older CLI response is a failure, never an empty list. */
export function parseAgentLearningReply(stdout: string, domain: AgentLearningDomain): readonly AgentLearningDocument[] {
  if (stdout.length > 1_048_576) throw new AgentLearningReadError('output_limit');
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw new AgentLearningReadError('invalid_json'); }
  if (row(value) && value.ok === false && text(value.reason)) throw new AgentLearningReadError(value.reason);
  if (!row(value) || value.schemaVersion !== 1 || value.ok !== true || value.domain !== domain || !Array.isArray(value.entries)
    || !value.entries.every(entry => isDocument(entry, domain)) || new Set(value.entries.map(entry => entry.id)).size !== value.entries.length) {
    throw new AgentLearningReadError('invalid_learning_read_reply');
  }
  return value.entries;
}

export interface AgentLearningClient {
  list(domain: AgentLearningDomain, signal: AbortSignal): Promise<readonly AgentLearningEntry[]>;
  detail(domain: AgentLearningDomain, versionId: string, signal: AbortSignal): Promise<AgentLearningDocument>;
}
export function createAgentLearningClient(runtime: ToolLearningRuntime): AgentLearningClient {
  const read = async (domain: AgentLearningDomain, signal: AbortSignal, versionId?: string) => {
    if (versionId !== undefined && (!text(versionId) || versionId.length > 512 || /[\0\r\n]/.test(versionId) || versionId.startsWith('-'))) {
      throw new AgentLearningReadError('invalid_version_identity');
    }
    const result = await runCliCommand({ ...runtime, signal, args: ['learn', 'inspect', domain, ...(versionId === undefined ? [] : [versionId])] });
    if (!result.ok) throw new AgentLearningReadError(result.reason);
    signal.throwIfAborted();
    return parseAgentLearningReply(result.stdout, domain);
  };
  return {
    list: (domain, signal) => read(domain, signal),
    async detail(domain, versionId, signal) {
      const entries = await read(domain, signal, versionId);
      if (entries.length !== 1 || entries[0]?.versionId !== versionId) throw new AgentLearningReadError('learning_version_not_found');
      return entries[0];
    },
  };
}
