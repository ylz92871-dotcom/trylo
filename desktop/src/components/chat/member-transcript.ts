import type { ChatMessage, SubagentMessage } from './types';

const taskText = (prompt: string): string => {
  const index = prompt.lastIndexOf('\nTask:\n');
  return (index < 0 ? prompt : prompt.slice(index + 7)).trim();
};

/** Adapt member facts into the same atomic messages the personal UI consumes. */
export function memberTranscript(agent: SubagentMessage): readonly ChatMessage[] {
  const messages: ChatMessage[] = [];
  const rounds = agent.conversation?.length ? agent.conversation : [{ round: agent.round ?? 1, prompt: agent.prompt, result: agent.result ?? agent.summary }];
  for (const round of rounds) {
    const events = agent.observations?.filter(item => item.round === round.round && item.kind !== 'report') ?? [];
    const turnId = `${agent.id}:round:${round.round}`;
    const base = { role: 'assistant' as const, turnId };
    if (round.prompt) messages.push({ ...base, id: turnId, kind: 'text', role: 'user', createdAt: events[0]?.at ?? agent.createdAt, text: taskText(round.prompt) });
    for (const event of events) {
      const id = `${turnId}:${event.id}`;
      const common = { ...base, id, createdAt: event.at };
      if (event.kind === 'report') continue;
      if (event.kind === 'thinking') messages.push({ ...common, kind: 'thinking', summary: event.text?.slice(0, 100) ?? '',
        preview: event.text ?? '', fullLength: event.text?.length ?? 0, partial: agent.status === 'running' && event === events.at(-1), turn: round.round });
      else if (event.kind === 'text') messages.push({ ...common, kind: 'text', text: event.text ?? '', partial: agent.status === 'running' && event === events.at(-1) });
      else if (event.kind === 'tool' || event.kind === 'result') messages.push({ ...common, kind: 'tool', tool: event.tool ?? 'tool',
        toolCallId: event.id, summary: String(event.input?.file_path ?? event.input?.path ?? event.input?.command ?? ''), input: event.input,
        status: event.kind === 'tool' ? agent.status === 'running' && event.round === (agent.round ?? 1) ? 'running' : 'interrupted' : event.ok === true ? 'done' : event.ok === false ? 'error' : 'interrupted',
        outputText: event.text, ...(event.completedAt === undefined ? {} : { completedAt: event.completedAt, durationMs: Math.max(0, event.completedAt - event.at) }) });
    }
    if (!events.some(item => item.kind === 'text') && round.result !== undefined) messages.push({ ...base,
      id: `${turnId}:answer`, kind: 'text', createdAt: events.at(-1)?.completedAt ?? events.at(-1)?.at ?? agent.createdAt, text: round.result });
  }
  return messages;
}
