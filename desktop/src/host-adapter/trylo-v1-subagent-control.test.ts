import { afterEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ send: vi.fn(async (_id: string, _message: string) => {}) }));
vi.mock('./index', () => ({ hostAdapter: { process: { send: h.send } } }));
import { cancelSubagent, closeSubagentInputProcess, consumeSubagentInputResult, registerSubagentInputProcess, sendSubagentInput } from './trylo-v1-subagent-control';
afterEach(() => { closeSubagentInputProcess('p1'); closeSubagentInputProcess('p2'); h.send.mockClear(); vi.useRealTimers(); });
describe('child input transport receipts', () => {
  it('waits for the addressed cancellation receipt and carries no guidance text', async () => {
    registerSubagentInputProcess('p1');
    let settled = false;
    const cancelling = cancelSubagent('p1', 'agent-a').then(() => { settled = true; });
    const frame = JSON.parse(h.send.mock.calls[0]![1]);
    expect(frame).toMatchObject({ type: 'subagent_input', target: 'agent-a', action: 'cancel' });
    expect(frame).not.toHaveProperty('message');
    await Promise.resolve();
    expect(settled).toBe(false);
    consumeSubagentInputResult(JSON.stringify({ type: 'subagent_input_result', requestId: frame.requestId, accepted: true }), 'p1');
    await cancelling;
    expect(settled).toBe(true);
  });
  it('preserves the explicitly selected restart mode in the acknowledged frame', async () => {
    registerSubagentInputProcess('p1');
    const sending = sendSubagentInput('p1', 'task-a', '改为检查测试', 'restart');
    const frame = JSON.parse(h.send.mock.calls[0]![1]) as { requestId: string; mode: string };
    expect(frame.mode).toBe('restart');
    consumeSubagentInputResult(JSON.stringify({ type: 'subagent_input_result', requestId: frame.requestId, accepted: true }), 'p1');
    await sending;
  });
  it('does not treat a pipe write or another process ack as delivery', async () => {
    registerSubagentInputProcess('p1'); registerSubagentInputProcess('p2');
    let delivered = false;
    const sending = sendSubagentInput('p1', 'agent-a', '保留记录').then(() => { delivered = true; });
    await Promise.resolve();
    const frame = JSON.parse(h.send.mock.calls[0]![1]) as { requestId: string };
    expect(delivered).toBe(false);
    consumeSubagentInputResult(JSON.stringify({ type: 'subagent_input_result', requestId: frame.requestId, accepted: true }), 'p2');
    await Promise.resolve(); expect(delivered).toBe(false);
    consumeSubagentInputResult(JSON.stringify({ type: 'subagent_input_result', requestId: frame.requestId, accepted: true }), 'p1');
    await sending; expect(delivered).toBe(true);
  });
  it('reports explicit refusal and closes pending requests when the process exits', async () => {
    registerSubagentInputProcess('p1');
    const first = sendSubagentInput('p1', 'closed-agent', '继续');
    const refusal = expect(first).rejects.toThrow('agent_closed');
    const frame = JSON.parse(h.send.mock.calls[0]![1]) as { requestId: string };
    consumeSubagentInputResult(JSON.stringify({ type: 'subagent_input_result', requestId: frame.requestId, accepted: false, error: 'agent_closed' }), 'p1');
    await refusal;
    const second = sendSubagentInput('p1', 'active', '继续');
    const ended = expect(second).rejects.toThrow('未收到');
    closeSubagentInputProcess('p1'); await ended;
  });
  it('states the uncertainty on timeout and never retries the instruction', async () => {
    vi.useFakeTimers(); registerSubagentInputProcess('p1');
    const sending = sendSubagentInput('p1', 'agent', '继续');
    const timeout = expect(sending).rejects.toThrow('可能已经送达');
    await vi.advanceTimersByTimeAsync(20000); await timeout;
    expect(h.send).toHaveBeenCalledTimes(1);
  });
  it('refuses another submission to the same child while a receipt is pending', async () => {
    registerSubagentInputProcess('p1');
    const first = sendSubagentInput('p1', 'agent-a', '第一条');
    const ended = expect(first).rejects.toThrow('未收到');
    await expect(sendSubagentInput('p1', 'agent-a', '重复提交')).rejects.toThrow('等待接收确认');
    expect(h.send).toHaveBeenCalledTimes(1);
    closeSubagentInputProcess('p1'); await ended;
  });
});
