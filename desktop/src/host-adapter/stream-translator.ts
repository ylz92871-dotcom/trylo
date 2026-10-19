// Trylo Desktop — dual-format event translator.
//
// v1.15.7: the Trylo CLI's "loop events" file has been
// in two different formats over the past few days:
//   1. RAW Anthropic stream JSON (system/init,
//      stream_event, assistant, result) — what the CLI
//      emits when its loop-events translator is OFF.
//   2. High-level LoopEvent JSON (session_start,
//      turn_start, text, thinking, loop_end, …) — what
//      the CLI emits when the translator is ON (still
//      incomplete in v2.1.88-trylo — only session_start
//      lands in the file; the rest is dropped).
//
// We don't know which one we'll get on any given run,
// so this translator accepts BOTH:
//
//   - If `type` is one of our known LoopEvent types
//     (session_start, turn_start, text, thinking, …),
//     we pass the event through, filling in seq / ts
//     if the CLI didn't.
//
//   - If `type` is `system` / `stream_event` / `result`
//     / `assistant` / `user`, we treat it as raw
//     Anthropic stream and translate to LoopEvent by
//     accumulating text / thinking deltas across
//     content_block_* events.
//
//   - Anything else is dropped (Phase 3 will add more).

import type { LoopEvent, LoopEventType } from './loop-events';
import { FILE_MUTATION_SCHEMA, normalizeFileMutationFacts } from '../tooling/file-mutation-facts';
import { parseControlFrame, type ControlFrame } from './control-protocol';
import {
  parseMcpMetaStructured,
  parseMcpPreview,
  parseToolResultBlock,
  summarizeToolResultContent,
  type AnyToolResultContent,
} from '../tooling/tool-result-content';
import { ThinkScrubber } from './think-scrubber';
import { thinkingSummary } from './thinking-summary';

type BlockType = 'text' | 'thinking' | 'tool_use' | null;

interface ActiveToolUse {
  id: string;
  name: string;
  /** Raw JSON input, accumulated from input_json_delta
   *  events. Parsed to an object on stop. */
  inputJson: string;
}

interface ActiveBlock {
  type: BlockType;
  text: string;
  blockId?: string;
  /** Set when type === 'tool_use'. */
  tool?: ActiveToolUse;
}

// v1.15.7: pruned. We only pass through events that
// the UI actually renders. Everything else (api_*, every
// turn boundary, etc.) is dropped here so the reducer
// never even sees them.
const KNOWN_LOOP_TYPES: ReadonlySet<LoopEventType> = new Set<LoopEventType>([
  'session_start', 'loop_start', 'session_end', 'loop_end',
  'turn_start', 'turn_end',
  'thinking', 'text', 'tool_use', 'tool_result',
  'subagent', 'compaction_trigger', 'compact',
  'model_fallback', 'permission_denied',
  'aborted', 'budget_breached', 'loop_finished',
  'plan_mode_transition',
]);

/** Build a human-readable failure text from an error `result`. The CLI reports
 *  the root cause in `errors[]` (the first entry is the top-level error); when
 *  that's absent it falls back to the subtype so the run never ends with an
 *  unexplained silence. */
function buildResultErrorText(parsed: Record<string, unknown>): string {
  const errors = parsed['errors'];
  if (Array.isArray(errors)) {
    const lines = errors
      .map((e) => (typeof e === 'string' && e.trim() !== '' ? e.trim() : null))
      .filter((e): e is string => e !== null);
    if (lines.length > 0) return lines.join('\n');
  }
  return `Run ended with an error (${String(parsed['subtype'] ?? 'execution error')}).`;
}

export class StreamTranslator {
  private active: ActiveBlock = { type: null, text: '' };
  /** Round-3 P2: the legacy path has the same leak as the v1 adapter — an
   *  OpenAI-compatible endpoint can put `<think>…</think>` on the text
   *  channel. Reset per `content_block_start`, flushed at the stop. */
  private textScrubber = new ThinkScrubber();
  private nextSeq = 0;
  /** v1.15.7: throttle text-delta → reducer emits so
   *  the UI doesn't render 200 times a second. */
  private lastEmitMs = 0;
  /** v1.15.9.b: tool_id → start_time (ms). Stamped at
   *  tool_use emit, looked up at tool_result emit to
   *  compute durationMs. Cleared on loop_end. */
  private toolStartTimes = new Map<string, number>();
  /** Permission-prompt-tool stdio hook (migration spec §6.4): control
   *  frames are NOT loop events — they are answered on stdin. When set,
   *  parseable control frames are routed here and dropped from the
   *  LoopEvent stream. */
  onControlFrame: ((frame: ControlFrame) => void) | null = null;

  /** Process one raw JSONL line from the events file. */
  feed(line: string): LoopEvent[] {
    const trimmed = line.trim();
    if (trimmed === '') return [];
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return [];
    }
    const type = parsed['type'];
    if (typeof type !== 'string') return [];
    if (type === 'api_retry' || (type === 'system' && parsed['subtype'] === 'api_retry')) {
      const seq = this.nextSeq++;
      const ts = Date.now();
      const status = Number(parsed['error_status'] ?? parsed['errorStatus']) || 0;
      const events: LoopEvent[] = [{ type: 'api_retry', seq, ts,
        attempt: Number(parsed['attempt']) || 1,
        maxRetries: Number(parsed['max_retries'] ?? parsed['maxRetries']) || 0,
        retryDelayMs: Math.max(0, Number(parsed['retry_delay_ms'] ?? parsed['retryDelayMs']) || 0),
        errorStatus: status,
        error: typeof parsed['error'] === 'string' ? parsed['error'] : '',
      }];
      // Desktop launches the legacy CLI in API-key-only --bare mode. Repeating
      // a rejected credential for minutes cannot repair it. The controller's
      // existing abort path stops only this child and settles its busy state.
      if (status === 401 || status === 403) {
        events.push({ type: 'runtime_warning', seq, ts, code: 'provider_auth_failed',
          message: `模型服务拒绝了当前连接（HTTP ${status}）。请检查此对话所选模型的 API 密钥、接口地址和认证请求头；本次已停止重试。` },
        { type: 'aborted', seq, ts, reason: 'error' });
      }
      return events;
    }
    const parentId = typeof parsed['parent_tool_use_id'] === 'string'
      && parsed['parent_tool_use_id'].length > 0
      ? parsed['parent_tool_use_id']
      : undefined;

    // Control frames bypass the loop-event vocabulary entirely.
    if (type === 'control_request' || type === 'control_cancel_request') {
      const frame = parseControlFrame(parsed);
      if (frame) this.onControlFrame?.(frame);
      return [];
    }

    // Fast path: the CLI's translator already gave us a
    // high-level LoopEvent. Just normalize seq / ts and
    // pass through.
    if (KNOWN_LOOP_TYPES.has(type as LoopEventType)) {
      const seq = typeof parsed['seq'] === 'number' ? parsed['seq'] : this.nextSeq++;
      const ts = typeof parsed['ts'] === 'number' ? parsed['ts'] : Date.now();
      parsed['seq'] = seq;
      parsed['ts'] = ts;
      return [parsed as unknown as LoopEvent];
    }

    // Slow path: raw Anthropic stream. Translate.
    const seq = this.nextSeq++;
    const ts = Date.now();

    if (type === 'system') {
      const sub = parsed['subtype'];
      if (sub === 'init') {
        return [{
          type: 'loop_start', seq, ts,
          sessionId: String(parsed['session_id'] ?? ''),
          model: String(parsed['model'] ?? ''),
          promptSummary: '',
          tools: Array.isArray(parsed['tools'])
            ? (parsed['tools'] as string[]).map(String)
            : [],
        }];
      }
      return [];
    }

    if (type === 'stream_event') {
      const ev = parsed['event'] as Record<string, unknown> | undefined;
      if (!ev) return [];
      const et = ev['type'];
      if (et === 'content_block_start') {
        this.lastEmitMs = 0;
        const cb = ev['content_block'] as Record<string, unknown> | undefined;
        const bt = (cb?.['type'] as BlockType) ?? null;
        this.textScrubber = new ThinkScrubber();
        if (bt === 'tool_use') {
          // v1.15.8: tool_use blocks carry the tool id +
          // name in content_block_start, then the input
          // JSON trickles in via input_json_delta. Capture
          // both at the start; the stop handler emits the
          // tool_use event with the parsed input.
          this.active = {
            type: 'tool_use',
            text: '',
            tool: {
              id: String(cb?.['id'] ?? ''),
              name: String(cb?.['name'] ?? ''),
              inputJson: '',
            },
          };
        } else {
          this.active = { type: bt, text: '', blockId: `block-${seq}` };
        }
        return [];
      }
      if (et === 'content_block_delta') {
        const delta = ev['delta'] as Record<string, unknown> | undefined;
        if (!delta) return [];
        const isTextDelta = delta['type'] === 'text_delta';
        const isThinkingDelta = delta['type'] === 'thinking_delta';
        const isInputJsonDelta = delta['type'] === 'input_json_delta';
        if (isTextDelta) {
          this.active.text += this.textScrubber.push(String(delta['text'] ?? '')).text;
        } else if (isThinkingDelta) {
          this.active.text += String(delta['thinking'] ?? '');
        } else if (isInputJsonDelta && this.active.tool) {
          this.active.tool.inputJson += String(delta['partial_json'] ?? '');
        }
        // v1.15.7: streaming. Emit a text/thinking event
        // for every delta so the UI sees the message grow
        // in real time. The reducer's applyText /
        // applyThinking update the existing bubble in
        // place rather than creating a new one. To avoid
        // flooding the reducer (one event per token), we
        // throttle to once every ~32ms.
        if (isTextDelta || isThinkingDelta) {
          const now = Date.now();
          if (now - this.lastEmitMs >= 32) {
            this.lastEmitMs = now;
            if (isTextDelta) {
              return [{
                type: 'text', seq, ts, turn: 1, blockId: this.active.blockId,
                preview: this.active.text,
                fullText: this.active.text,
                partial: true,
              }];
            }
            const buf = this.active.text;
            const summary = thinkingSummary(buf);
            return [{
              type: 'thinking', seq, ts, turn: 1, blockId: this.active.blockId,
              summary, preview: buf, fullLength: buf.length,
              partial: true,
            }];
          }
        }
        return [];
      }
      if (et === 'content_block_stop') {
        const tool = this.active.tool;
        const blockId = this.active.blockId;
        // A text block can end mid-think; the scrubber decides whether the
        // pending fragment is prose or a half-written tag.
        if (this.active.type === 'text') {
          this.active.text += this.textScrubber.flush();
        }
        const buf = this.active.text;
        const bt = this.active.type;
        this.active = { type: null, text: '' };
        if (bt === 'text' && buf) {
          return [{
            type: 'text', seq, ts, turn: 1, blockId,
            preview: buf, fullText: buf,
          }];
        }
        if (bt === 'thinking' && buf) {
          const summary = thinkingSummary(buf);
          return [{
            type: 'thinking', seq, ts, turn: 1, blockId,
            summary, preview: buf, fullLength: buf.length,
            partial: false,
          }];
        }
        if (bt === 'tool_use' && tool) {
          // v1.15.8: the input_json deltas have been
          // accumulated into tool.inputJson. Parse and
          // emit a tool_use event so the UI can render
          // the tool card.
          let parsedInput: unknown = {};
          try {
            parsedInput = tool.inputJson ? JSON.parse(tool.inputJson) : {};
          } catch {
            // Malformed JSON; fall back to the raw string.
            parsedInput = tool.inputJson;
          }
          // v1.15.9.b: stamp the tool's start time so we
          // can compute durationMs when the result lands.
          this.toolStartTimes.set(tool.id, ts);
          return [{
            type: 'tool_use', seq, ts, turn: 1,
            id: tool.id,
            tool: tool.name,
            input: parsedInput as Record<string, unknown>,
            ...(parentId ? { parentId } : {}),
          }];
        }
        return [];
      }
      return [];
    }

    // Nested sub-agent tools arrive as complete `assistant` frames with
    // `parent_tool_use_id` (progress → normalizeMessage). Without this
    // they never become tool_use events, so Team seat activity stays empty.
    if (type === 'assistant') {
      const message = parsed['message'] as Record<string, unknown> | undefined;
      const content = message?.['content'];
      if (!Array.isArray(content)) return [];
      const out: LoopEvent[] = [];
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b['type'] !== 'tool_use') continue;
        const id = String(b['id'] ?? '');
        const name = String(b['name'] ?? '');
        if (!id || !name) continue;
        this.toolStartTimes.set(id, ts);
        const input = (b['input'] && typeof b['input'] === 'object')
          ? b['input'] as Record<string, unknown>
          : {};
        out.push({
          type: 'tool_use', seq: this.nextSeq++, ts, turn: 1,
          id,
          tool: name,
          input,
          ...(parentId ? { parentId } : {}),
        });
      }
      return out;
    }

    // v1.15.8: parse `user` messages to find tool_result
    // content. The CLI emits these as a separate turn
    // after the tool finishes; without this, tool_result
    // events never reach the UI and tool cards never
    // transition from "running" to "done".
    //
    // PR-4 (spec §7, 缺口 A): the content array is no longer flattened
    // to its text blocks. image / audio / resource / resource_link
    // blocks are preserved as structured content (raw base64 blocks are
    // materialized into BinaryRefs by the trylo-runner pump BEFORE any
    // reducer / UI / history sees them), and the CLI's
    // `mcpMeta.structuredContent` ride-along (client.ts:1899-1905)
    // becomes a `structured` block. `output` stays the text summary.
    if (type === 'user') {
      const message = parsed['message'] as
        | Record<string, unknown>
        | undefined;
      if (!message) return [];
      const content = message['content'];
      if (!Array.isArray(content)) return [];
      const out: LoopEvent[] = [];
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b['type'] === 'tool_result') {
          const id = String(b['tool_use_id'] ?? '');
          const rawContent = b['content'];
          const blocks: AnyToolResultContent[] = [];
          if (typeof rawContent === 'string') {
            if (rawContent !== '') blocks.push({ type: 'text', text: rawContent });
          } else if (Array.isArray(rawContent)) {
            for (const item of rawContent) {
              const parsedBlock = parseToolResultBlock(item);
              if (parsedBlock) blocks.push(parsedBlock);
            }
          } else if (rawContent !== undefined && rawContent !== null) {
            blocks.push({ type: 'text', text: JSON.stringify(rawContent) });
          }
          const structured = parseMcpMetaStructured(message['mcpMeta']);
          if (structured) blocks.push(structured);
          const nativeResult = parsed['tool_use_result'];
          if (nativeResult && typeof nativeResult === 'object' && !Array.isArray(nativeResult)) {
            const facts = normalizeFileMutationFacts((nativeResult as Record<string, unknown>)['tryloFileChanges']);
            if (facts?.length) blocks.push({ type: 'structured', schema: FILE_MUTATION_SCHEMA, value: facts });
          }
          const preview = parseMcpPreview(message['mcpMeta']);
          if (preview && !blocks.some(block => block.type === 'image' && 'ref' in block && block.ref.sha256 === (preview.type === 'image' ? preview.ref.sha256 : ''))) blocks.push(preview);
          const textSummary = summarizeToolResultContent(blocks);
          const isErr = b['is_error'] === true;
          // v1.15.9.b: compute duration from the start
          // time recorded at tool_use emit. If we never
          // saw a matching tool_use (defensive), fall
          // back to 0 — same as the old hardcoded value.
          const startTime = this.toolStartTimes.get(id);
          // startTime is number | undefined (Map.get returns
          // T | undefined). Coalesce undefined → 0 so the
          // subtraction type-checks.
          const durationMs = startTime !== undefined ? Date.now() - startTime : 0;
          out.push({
            type: 'tool_result', seq: this.nextSeq++, ts,
            turn: 1,
            id,
            tool: '',
            ok: !isErr,
            output: textSummary,
            ...(blocks.length > 0 ? { content: blocks } : {}),
            error: isErr ? textSummary : undefined,
            durationMs,
            ...(parentId ? { parentId } : {}),
          });
        }
      }
      return out;
    }

    if (type === 'result') {
      const sub = parsed['subtype'];
      // The CLI signals an aborted / failed run with a `result` whose subtype
      // is one of the error variants (`error_during_execution`, `error_max_turns`,
      // `error_max_budget_usd`, `error_max_structured_output_retries`) — NOT a
      // plain `error`. Historically this translator only accepted `success` /
      // `error` and silently dropped every other terminal result. When the CLI
      // aborted mid-run (intermittent upstream/tool failure), the desktop never
      // saw a `loop_end`: `busy` stayed set, the run's terminal outcome was never
      // recorded, and the app only learned the run had died via the later process
      // exit — surfacing as an opaque "it just stopped" with the real reason lost.
      // Treat any non-success `result` (or one flagged `is_error: true`) as a
      // terminal error so the error reason reaches the UI and the run finalizes.
      const isErr =
        sub !== 'success' &&
        (parsed['is_error'] === true ||
          sub === 'error' ||
          sub === 'error_during_execution' ||
          sub === 'error_max_turns' ||
          sub === 'error_max_budget_usd' ||
          sub === 'error_max_structured_output_retries');
      if (sub === 'success' || isErr) {
        const finalText = isErr
          ? buildResultErrorText(parsed)
          : String(parsed['result'] ?? '');
        const events: LoopEvent[] = [{
          type: 'loop_end', seq, ts,
          reason: isErr
            ? String(parsed['subtype'] ?? 'error')
            : String(parsed['stop_reason'] ?? 'unknown'),
          numTurns: Number(parsed['num_turns'] ?? 0) || 0,
          totalCost: Number(parsed['total_cost_usd'] ?? 0) || 0,
          durationMs: Number(parsed['duration_ms'] ?? 0) || 0,
          finalResult: finalText,
          isError: isErr,
        }];
        // Surface the stop reason in the transcript as a visible assistant
        // message. For errors this runs even when a partial assistant text was
        // already emitted, so the user sees WHY the run stopped, never a
        // silent mid-run halt.
        if ((!isErr && finalText) || (isErr && !this.active.text)) {
          events.unshift({
            type: 'text', seq: this.nextSeq++, ts, turn: 1,
            preview: finalText, fullText: finalText,
          });
        }
        // v1.15.9.b: clear the start-time map so a
        // long-running session doesn't grow it unbounded
        // (one entry per tool call, cleared per loop).
        this.toolStartTimes.clear();
        return events;
      }
      return [];
    }

    // user, assistant, message_start/stop, etc. — dropped
    // for v1.15.7. Phase 3 will add turn boundaries.
    return [];
  }
}
