import { describe, expect, it } from 'vitest';
import { buildBootstrapUserPrompt } from './trylo-v1-runner';
import { TryloV1EventAdapter } from './trylo-v1-event-adapter';
import { applyEvents } from '../components/chat/events';
const goal = { objective: '整理项目并验证', status: 'active', tokensUsed: 0, createdAtTurn: 't', updatedAtTurn: 't' };
describe('goal v1 transport', () => {
  it('carries explicit goal command outside prompt text and bootstrap history', () => {
    const command = { version: 1, action: 'create', objective: goal.objective, tokenBudget: 10000 };
    const frame = JSON.parse(Reflect.apply(buildBootstrapUserPrompt, undefined, [[], goal.objective, command]));
    expect(frame.goal).toEqual(command);
    expect(frame.message.content).toEqual([{ type: 'text', text: goal.objective }]);
  });
  it('projects a validated goal snapshot into persistent chat facts', () => {
    const adapter = new TryloV1EventAdapter();
    const events = adapter.feed(JSON.stringify({ type: 'goal_state', version: 1, goal }));
    expect(events).toHaveLength(1);
    const messages = applyEvents([], events);
    expect(messages).toEqual([expect.objectContaining({ kind: 'goal', goal })]);
  });
  it('rejects malformed goal snapshots instead of inventing a new goal', () => {
    const adapter = new TryloV1EventAdapter();
    expect(adapter.feed(JSON.stringify({ type: 'goal_state', version: 1, goal: { ...goal, tokensUsed: -1 } }))).toEqual([]);
    expect(adapter.rejectedLines()).toHaveLength(1);
  });
});
