import { parsePersonSeatOutput } from '../user-learning/team-access/person-output';

/** Same Person interpretation for live delivery and retained-output recovery. */
export function teamPersonFeedback(events: readonly unknown[], teamRunId: string) {
  let vetoActive = false; let vetoReason = '';
  let questions: readonly string[] = []; let unknown: readonly string[] = [];
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const e = event as { type?: unknown; kind?: unknown; agentType?: unknown; result?: unknown; source?: unknown; teamRunId?: unknown };
    if (e.source === 'trylo-v1' && e.teamRunId !== teamRunId) continue;
    if (e.type !== 'subagent' || (e.kind !== 'end' && e.kind !== 'update') || e.agentType !== 'person') continue;
    const parsed = parsePersonSeatOutput(typeof e.result === 'string' ? e.result : '');
    if (!parsed) continue;
    if (parsed.veto.active) { vetoActive = true; vetoReason = parsed.veto.reason; }
    if (parsed.userQuestions.length > 0) {
      questions = parsed.userQuestions;
      unknown = parsed.intent.unknown && !/^none/i.test(parsed.intent.unknown) ? [parsed.intent.unknown] : [];
    }
  }
  return { vetoActive, vetoReason, questions, unknown };
}
