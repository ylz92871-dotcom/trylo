// Trylo Desktop — control protocol tests (spec §6.4 Code path).
// Shapes verified against the CLI bundle; the translator hook test pins
// that control frames bypass the LoopEvent vocabulary.

import { describe, expect, it } from 'vitest';

import { buildControlResponse, buildStopTaskRequest, parseControlFrame } from './control-protocol';
import { StreamTranslator } from './stream-translator';

describe('parseControlFrame', () => {
  it('parses a can_use_tool control_request', () => {
    const frame = parseControlFrame({
      type: 'control_request',
      request_id: 'req-1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, title: 'Run ls' },
    });
    expect(frame).toEqual({
      kind: 'permission',
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'ls' },
      title: 'Run ls',
    });
  });

  it('accepts a permission without title and normalizes missing input', () => {
    const frame = parseControlFrame({
      type: 'control_request',
      request_id: 'req-2',
      request: { subtype: 'can_use_tool', tool_name: 'Read' },
    });
    expect(frame).toMatchObject({ kind: 'permission', requestId: 'req-2', toolName: 'Read', input: {} });
    expect('title' in (frame as object)).toBe(false);
  });

  it('returns null for other control subtypes and malformed frames', () => {
    expect(parseControlFrame({ type: 'control_request', request_id: 'r', request: { subtype: 'set_model' } })).toBeNull();
    expect(parseControlFrame({ type: 'control_request', request: { subtype: 'can_use_tool', tool_name: 'Bash' } })).toBeNull();
    expect(parseControlFrame({ type: 'control_request', request_id: 'r' })).toBeNull();
    expect(parseControlFrame({ type: 'user' })).toBeNull();
    expect(parseControlFrame(null)).toBeNull();
    expect(parseControlFrame('string')).toBeNull();
  });

  it('parses a control_cancel_request and drops malformed ones', () => {
    expect(parseControlFrame({ type: 'control_cancel_request', request_id: 'req-3' })).toEqual({
      kind: 'cancel',
      requestId: 'req-3',
    });
    expect(parseControlFrame({ type: 'control_cancel_request' })).toBeNull();
  });
});

describe('buildStopTaskRequest', () => {
  it('is a stream-json control_request stop_task line', () => {
    const line = buildStopTaskRequest('tool-seat-w', 'req-stop-1');
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line.trim())).toEqual({
      type: 'control_request',
      request_id: 'req-stop-1',
      request: { subtype: 'stop_task', task_id: 'tool-seat-w' },
    });
  });
});

describe('buildControlResponse', () => {
  it('allow carries the original input as updatedInput', () => {
    const line = buildControlResponse('req-1', true, { command: 'ls' });
    expect(JSON.parse(line.trim())).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-1',
        response: { behavior: 'allow', updatedInput: { command: 'ls' } },
      },
    });
    expect(line.endsWith('\n')).toBe(true);
  });

  it('deny carries a message', () => {
    const parsed = JSON.parse(buildControlResponse('req-2', false).trim());
    expect(parsed.response.response).toMatchObject({ behavior: 'deny', message: expect.any(String) });
  });
});

describe('StreamTranslator control-frame hook', () => {
  it('routes control frames to the hook and emits no LoopEvents', () => {
    const translator = new StreamTranslator();
    const seen: unknown[] = [];
    translator.onControlFrame = (frame) => seen.push(frame);
    const events = translator.feed(
      '{"type":"control_request","request_id":"req-9","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"rm -rf /"}}}',
    );
    expect(events).toEqual([]);
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({ kind: 'permission', requestId: 'req-9', toolName: 'Bash' });
  });

  it('drops control frames silently when no hook is installed', () => {
    const translator = new StreamTranslator();
    expect(translator.feed('{"type":"control_request","request_id":"r","request":{"subtype":"can_use_tool","tool_name":"X"}}')).toEqual([]);
  });

  it('does not treat non-control control-ish lines as frames', () => {
    const translator = new StreamTranslator();
    const seen: unknown[] = [];
    translator.onControlFrame = (frame) => seen.push(frame);
    translator.feed('{"type":"control_response","response":{"subtype":"success"}}');
    expect(seen).toEqual([]);
  });
});
