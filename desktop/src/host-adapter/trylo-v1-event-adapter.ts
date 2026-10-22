// Trylo Desktop — trylo-v1 CLI stream → Desktop LoopEvent adapter.
//
// P08 §5. Deliberately a SEPARATE class from `StreamTranslator`: the
// legacy translator already carries the CC-CLI's raw-Anthropic slow
// path, its own seq/ts policy and its own throttling. Merging the v1
// vocabulary into it is how `tool_use` / `tool_result` started
// masquerading as legacy frames (see `trylo-v1-contract.test.ts`).
//
// The three invariants this class owns (spec §4.3):
//
//   1. AT MOST ONE authoritative terminal per run. A second
//      `run_result` is ignored, not merged.
//   2. A run that ends WITHOUT `run_result` is `unknown` / `failed` /
//      `cancelled` — never `completed`. Exit code 0 with no terminal
//      event is `unknown`, because "the process exited cleanly" is not
//      evidence that the run did what the user asked.
//   3. Optional tool input is projected when present. Old streams without
//      it still work; missing duration and tool lists are never guessed.

import type { LoopEvent } from './loop-events';
import { FILE_MUTATION_SCHEMA } from '../tooling/file-mutation-facts';
import { parseCliV1Event, type CliV1Event, type CliV1Rejected, type CliV1Usage } from './trylo-v1-protocol';
import { desktopV1Tool } from './trylo-v1-tool';
import { ThinkScrubber } from './think-scrubber';
import { thinkingSummary } from './thinking-summary';
import { summarizeStderr, describeV1Rejections } from './trylo-v1-diagnostics';
export { summarizeStderr } from './trylo-v1-diagnostics';

/** Why a run ended. `unknown` is the honest answer when we can't tell. */
export type TryloV1Outcome = 'completed' | 'failed' | 'cancelled' | 'unknown';

export interface TryloV1ExitInfo {
  /** Process exit code; null when the wait failed / was signalled. */
  readonly exitCode: number | null;
  /** stderr lines captured on the separate channel (spec §4.2). */
  readonly stderr: readonly string[];
  /** True when THIS app asked for the stop (as opposed to a crash). */
  readonly cancelled: boolean;
}

/** Everything the adapter learned, for diagnostics and for the runner. */
export interface TryloV1RunSummary {
  readonly sessionId: string | null;
  readonly turnId: string | null;
  readonly providerId: string | null;
  readonly model: string | null;
  readonly usage: CliV1Usage | null;
  /** Null until an authoritative `run_result` was consumed. */
  readonly outcome: TryloV1Outcome | null;
}

export class TryloV1EventAdapter {
  private seq = 0;
  private textBuffer = '';
  /** Round-3 P2: providers that put chain-of-thought in `message_delta`
   *  leak the literal tag; scrub it before it reaches the transcript. One
   *  instance per message — see `message_start`. */
  private textScrubber = new ThinkScrubber();
  private reasoningBuffer = '';
  private textBlockId: string | undefined;
  private reasoningBlockId: string | undefined;
  private settledToolCallIds = new Set<string>();
  private reasoningRedacted = false;
  /** Per-request usage during streaming; aggregate billing only after run_result.
   * Current context has its own reading and is never replaced by that aggregate. */
  private latestUsage: CliV1Usage | null = null;
  private contextTokens: number | undefined;
  private contextWindow: number | undefined;
  private maintenance = false;
  private compactionPending = false;
  private outcome: TryloV1Outcome | null = null;
  private sessionId: string | null = null;
  private turnId: string | null = null;
  private providerId: string | null = null;
  private model: string | null = null;
  /** toolCallId → emit time, so `durationMs` is measured, not invented. */
  private toolStartMs = new Map<string, number>();
  private toolNames = new Map<string, string>();
  private activeSubagents = new Set<string>();
  /** Rejected lines, newest last. Surfaced by the runner; never swallowed. */
  private rejections: CliV1Rejected[] = [];

  private next(): { seq: number; ts: number } {
    return { seq: this.seq++, ts: Date.now() };
  }

  /** What the adapter knows about the run so far. */
  summary(): TryloV1RunSummary {
    return {
      sessionId: this.sessionId,
      turnId: this.turnId,
      providerId: this.providerId,
      model: this.model,
      usage: this.latestUsage,
      outcome: this.outcome,
    };
  }

  /** Lines that failed the wire guard (for diagnostics, spec §5). */
  rejectedLines(): readonly CliV1Rejected[] {
    return this.rejections;
  }

  /**
   * Emit a HOST-side warning through the same channel as a CLI warning.
   *
   * Audit finding: a run whose stdout carried nothing parseable ended
   * with a generic "no terminal event", because the wire-guard
   * rejections only ever reached `rejectedLines()` — which has no
   * production consumer. A protocol mismatch is the real reason such a
   * run dies, so it has to reach the user.
   */
  warn(code: string, message: string): LoopEvent {
    const { seq, ts } = this.next();
    return this.warningEvent(seq, ts, code, message);
  }

  private warningEvent(
    seq: number,
    ts: number,
    code: string,
    message: string,
    diagnostic?: import('./trylo-v1-protocol').NativeContinuationDiagnostic,
  ): LoopEvent {
    const id = this.sessionId && this.turnId
      ? `warn:${this.sessionId}:${this.turnId}:${seq}`
      : `warn-${ts}-${seq}`;
    return { type: 'runtime_warning', id, seq, ts, code, message, ...(diagnostic === undefined ? {} : { diagnostic }) };
  }

  /** One sentence describing what the wire guard refused, if anything. */
  describeRejections(): string {
    return describeV1Rejections(this.rejections);
  }

  /** True once an authoritative terminal event was produced. */
  get hasTerminal(): boolean {
    return this.outcome !== null;
  }

  /** Feed one raw stdout line. Returns the LoopEvents it projects. */
  feed(line: string): LoopEvent[] {
    if (this.hasTerminal) return [];
    const parsed = parseCliV1Event(line);
    if (!parsed.ok) {
      // A blank line is normal framing noise; everything else is a real
      // protocol problem and must be visible.
      if (parsed.reason !== 'empty') {
        this.rejections.push(parsed);
      }
      return [];
    }
    const event = parsed.event;
    if ((event.type === 'run_start' || event.type === 'run_result') && this.sessionId !== null) {
      if (event.sessionId !== this.sessionId || event.turnId !== this.turnId ||
          (event.type === 'run_start' && (event.providerId !== this.providerId || event.model !== this.model))) {
        this.rejections.push({ ok: false, reason: 'identity_mismatch', raw: '' });
        return [];
      }
      if (event.type === 'run_start') return [];
    }
    const newTool = event.type === 'tool_use' && !this.toolNames.has(event.toolCallId) && !this.settledToolCallIds.has(event.toolCallId);
    const pending = event.type === 'message_start' || event.type === 'reasoning_start' || newTool
      ? this.closeBlocks() : [];
    return [...pending, ...this.project(event)];
  }

  /**
   * Synthesise the terminal events for a run whose process ended
   * WITHOUT an authoritative `run_result` (spec §4.3).
   *
   * This is the single place that decides "what happened" when the CLI
   * never said. The rules are deliberately conservative:
   *
   *   - we asked for the stop            → cancelled
   *   - non-zero exit                    → failed
   *   - exit 0 but no `run_result`       → unknown  (NOT completed)
   *
   * The last one matters most: golden trace
   * `04-prerun-config-failure` exits 52 with an empty stdout, and a
   * killed run can exit 0 on some platforms. Reporting either as
   * "completed" would be a lie the UI cannot detect.
   */
  finalizeExit(info: TryloV1ExitInfo): LoopEvent[] {
    if (this.outcome !== null) return [];
    const outcome: TryloV1Outcome = info.cancelled
      ? 'cancelled'
      : (info.exitCode ?? 0) !== 0
        ? 'failed'
        : 'unknown';
    const detail =
      summarizeStderr(info.stderr) ||
      (outcome === 'unknown'
        ? 'The run ended without a terminal event.'
        : `The run ended without a terminal event (exit ${String(info.exitCode)}).`);
    // The runner already surfaces rejected wire frames as one specific
    // protocol diagnostic. Do not append a second generic exit warning.
    const warnings = outcome === 'cancelled' || this.rejections.length > 0 ? []
      : [this.warn(outcome === 'failed' ? 'process_failed' : 'missing_terminal', detail)];
    return [...warnings, ...this.emitTerminal(outcome, detail, 'no_run_result')];
  }

  private project(event: CliV1Event): LoopEvent[] {
    const { seq, ts } = this.next();
    switch (event.type) {
      case 'subagent': {
        if (event.kind === 'spawn') {
          if (this.activeSubagents.has(event.id)) return [];
          this.activeSubagents.add(event.id);
        } else if (!this.activeSubagents.has(event.id)) return [];
        if (event.kind === 'end') this.activeSubagents.delete(event.id);
        return [{ ...event, seq, ts, source: 'trylo-v1' }];
      }
      case 'run_start':
        return this.onRunStart(event, seq, ts);
      case 'message_start':
        this.textBuffer = '';
        // A fresh scrubber per message: an unterminated `<think>` in one
        // message must not blank out the next one's answer.
        this.textScrubber = new ThinkScrubber();
        this.textBlockId = `text:${this.sessionId}:${this.turnId}:${seq}`;
        return [];
      case 'message_delta':
        this.textBuffer += this.textScrubber.push(event.text).text;
        return [
          {
            type: 'text', seq, ts, turn: 1, blockId: this.textBlockId,
            preview: this.textBuffer,
            fullText: this.textBuffer,
            partial: true,
          },
        ];
      case 'message_end':
        return this.onMessageEnd(seq, ts);
      case 'reasoning_start':
        this.reasoningBuffer = '';
        this.reasoningBlockId = `thinking:${this.sessionId}:${this.turnId}:${seq}`;
        this.reasoningRedacted = event.redacted;
        return [];
      case 'reasoning_delta':
        if (this.reasoningRedacted) return [];
        this.reasoningBuffer += event.text;
        return [
          {
            type: 'thinking', seq, ts, turn: 1, blockId: this.reasoningBlockId,
            summary: thinkingSummary(this.reasoningBuffer),
            preview: this.reasoningBuffer,
            fullLength: this.reasoningBuffer.length,
            partial: true,
          },
        ];
      case 'reasoning_end':
        return this.onReasoningEnd(seq, ts);
      case 'tool_use': {
        if (this.toolNames.has(event.toolCallId) || this.settledToolCallIds.has(event.toolCallId)) return [];
        const tool = desktopV1Tool(event.name, event.input);
        this.toolStartMs.set(event.toolCallId, ts);
        this.toolNames.set(event.toolCallId, tool.name);
        return [
          {
            type: 'tool_use', seq, ts, turn: 1,
            id: event.toolCallId,
            tool: tool.name,
            input: tool.input,
          },
        ];
      }
      case 'tool_result':
        return this.onToolResult(event, seq, ts);
      case 'warning':
        // Never an assistant message: a warning is host evidence about
        // the run, not something the model said (spec §5).
        return [
          this.warningEvent(seq, ts, event.code, event.message, event.diagnostic),
        ];
      case 'usage':
        this.latestUsage = event.usage;
        // A reading is not a turn boundary; publish hidden measurement metadata.
        if (event.usage.inputTokens > 0) {
          this.contextTokens = event.usage.inputTokens;
          return [{ type: 'context_usage', seq, ts, tokens: this.contextTokens, contextWindow: this.contextWindow }];
        }
        return [];
      case 'compact':
        if (event.status === 'started') {
          this.compactionPending = true;
          return [{ type: 'compaction_trigger', seq, ts, trigger: event.reason === 'manual' ? 'manual' : 'auto', preTokens: event.tokensBefore ?? 0, postTokens: 0 }];
        }
        this.compactionPending = false;
        if (event.status === 'completed' && event.tokensAfter !== undefined) this.contextTokens = event.tokensAfter;
        return [{ type: 'compact', seq, ts, kind: 'after', reason: event.reason, requestContext: true,
          ...(event.status === 'failed' ? { status: 'failed' as const } : {}),
          tokensBefore: event.tokensBefore, tokensAfter: event.tokensAfter }];
      case 'run_result':
        return this.onRunResult(event, ts);
      default:
        return [];
    }
  }

  private closeBlocks(): LoopEvent[] {
    const events: LoopEvent[] = [];
    if (this.textBlockId !== undefined || this.textBuffer !== '') {
      const { seq, ts } = this.next();
      events.push(...this.onMessageEnd(seq, ts));
    }
    if (this.reasoningBlockId !== undefined || this.reasoningBuffer !== '') {
      const { seq, ts } = this.next();
      events.push(...this.onReasoningEnd(seq, ts));
    }
    return events;
  }

  private onRunStart(
    event: Extract<CliV1Event, { type: 'run_start' }>,
    seq: number,
    ts: number,
  ): LoopEvent[] {
    this.maintenance = event.operation === 'compact';
    this.contextWindow = event.contextWindow;
    this.sessionId = event.sessionId;
    this.turnId = event.turnId;
    this.providerId = event.providerId;
    this.model = event.model;
    return [
      {
        type: 'loop_start', seq, ts,
        sessionId: event.sessionId,
        model: event.model,
        promptSummary: '',
        // The v1 stream does not declare a tool list. An empty list is
        // the truth; a plausible-looking one would be a fabrication
        // that downstream drift detection would then trust.
        tools: [],
      },
      { type: 'turn_start', seq: this.seq++, ts, turn: 1, depth: 0, agentId: null },
    ];
  }

  private onMessageEnd(seq: number, ts: number): LoopEvent[] {
    this.textBuffer += this.textScrubber.flush();
    const text = this.textBuffer;
    const blockId = this.textBlockId;
    this.textBuffer = '';
    this.textBlockId = undefined;
    // Empty/tool-only messages create no bubble, including terminal cleanup.
    if (text.trim() === '') return [];
    return [{ type: 'text', seq, ts, turn: 1, blockId, preview: text, fullText: text }];
  }

  private onReasoningEnd(seq: number, ts: number): LoopEvent[] {
    const blockId = this.reasoningBlockId;
    if (blockId === undefined && this.reasoningBuffer === '') return [];
    this.reasoningBlockId = undefined;
    if (this.reasoningRedacted) {
      // Redacted reasoning: say that it happened, project no content
      // (spec §5). An empty preview keeps the card honest.
      this.reasoningBuffer = '';
      return [
        {
          type: 'thinking', seq, ts, turn: 1, blockId,
          summary: 'Reasoning was redacted',
          preview: '',
          fullLength: 0,
          partial: false,
        },
      ];
    }
    if (this.reasoningBuffer.trim() === '') return [];
    const out: LoopEvent[] = [
      {
        type: 'thinking', seq, ts, turn: 1, blockId,
        summary: thinkingSummary(this.reasoningBuffer),
        preview: this.reasoningBuffer,
        fullLength: this.reasoningBuffer.length,
        partial: false,
      },
    ];
    this.reasoningBuffer = '';
    return out;
  }

  private onToolResult(
    event: Extract<CliV1Event, { type: 'tool_result' }>,
    seq: number,
    ts: number,
  ): LoopEvent[] {
    if (this.settledToolCallIds.has(event.toolCallId)) return [];
    this.settledToolCallIds.add(event.toolCallId);
    const ok = event.status === 'succeeded';
    const startedAt = this.toolStartMs.get(event.toolCallId);
    this.toolStartMs.delete(event.toolCallId);
    const name = this.toolNames.get(event.toolCallId) ?? (event.name ? desktopV1Tool(event.name, undefined).name : '');
    this.toolNames.delete(event.toolCallId);
    return [
      {
        type: 'tool_result', seq, ts, turn: 1,
        id: event.toolCallId,
        tool: name,
        ok,
        output: event.output,
        ...(event.fileChanges === undefined ? {} : { content: [{ type: 'structured' as const, schema: FILE_MUTATION_SCHEMA, value: event.fileChanges }] }),
        truncated: event.truncated,
        ...(ok ? {} : { error: event.message || event.code || event.output || `tool failed (${event.status})` }),
        // Measured when we saw the matching tool_use; 0 when we didn't
        // (a result whose call was never projected must not fake a
        // duration).
        durationMs: event.durationMs ?? (startedAt === undefined ? 0 : Math.max(0, ts - startedAt)),
      },
    ];
  }

  private onRunResult(
    event: Extract<CliV1Event, { type: 'run_result' }>,
    ts: number,
  ): LoopEvent[] {
    if (this.outcome !== null) {
      // Second terminal frame: ignored. There is exactly one truth per
      // run, and the first one to arrive owns it (spec §4.3).
      return [];
    }
    this.sessionId = event.sessionId;
    this.turnId = event.turnId;
    this.latestUsage = event.usage;
    if (this.contextTokens === undefined && event.iterations === 1 && event.usage.inputTokens > 0) this.contextTokens = event.usage.inputTokens;
    const incomplete = event.status === 'completed' && (this.rejections.length > 0 || this.toolNames.size > 0 || this.activeSubagents.size > 0);
    const warnings = this.rejections.length > 0
      ? [this.warn('protocol_rejected', this.describeRejections())]
      : incomplete ? [this.activeSubagents.size > 0
        ? this.warn('incomplete_subagent_stream', 'CLI reported completion before every child lifecycle was settled.')
        : this.warn('incomplete_tool_stream', 'CLI reported completion without a result for every tool call.')] : [];
    return [...warnings, ...this.emitTerminal(
      incomplete ? 'unknown' : event.status,
      event.lastMessage,
      event.finishReason || event.status,
      { ts, iterations: event.iterations, durationMs: event.durationMs },
    )];
  }

  private emitTerminal(
    outcome: TryloV1Outcome,
    finalResult: string,
    reason: string,
    meta?: { ts: number; iterations: number; durationMs: number },
  ): LoopEvent[] {
    this.outcome = outcome;
    const ts = meta?.ts ?? Date.now();
    const usage = this.latestUsage;
    const isError = outcome !== 'completed';
    const unfinishedCompaction: LoopEvent[] = this.compactionPending ? [{ type: 'compact', seq: this.seq++, ts,
      kind: 'after', status: 'failed', reason: `interrupted (${outcome})` }] : [];
    this.compactionPending = false;
    // A killed stream may never send its block-end frames. Settle only the
    // bytes already delivered, preserving block ids and terminal truth.
    const pendingMessages: LoopEvent[] = [];
    if (this.textBlockId !== undefined || this.textBuffer !== '') {
      pendingMessages.push(...this.onMessageEnd(this.seq++, ts));
    }
    if (this.reasoningBlockId !== undefined || this.reasoningBuffer !== '') {
      pendingMessages.push(...this.onReasoningEnd(this.seq++, ts));
    }
    // Denial/stop can end a run without tool_result. Settle the host card
    // from terminal evidence; an empty output never claims execution.
    const pendingTools: LoopEvent[] = [...this.toolNames].map(([id, tool]) => ({
      type: 'tool_result', seq: this.seq++, ts, turn: 1, id, tool,
      ok: false, output: '', truncated: false,
      error: `Tool did not report completion before the run ended (${outcome}). ${finalResult}`.trim(),
      durationMs: Math.max(0, ts - (this.toolStartMs.get(id) ?? ts)),
    }));
    this.toolNames.clear();
    this.toolStartMs.clear();
    const pendingAgents: LoopEvent[] = [...this.activeSubagents].map(id => ({
      type: 'subagent', kind: 'end', id, seq: this.seq++, ts, source: 'trylo-v1',
      status: outcome === 'cancelled' ? 'cancelled' : 'failed',
      error: '运行结束前未收到该智能体的完成结果。',
    }));
    this.activeSubagents.clear();
    return [
      ...pendingMessages,
      ...pendingTools,
      ...pendingAgents,
      ...unfinishedCompaction,
      ...(!this.maintenance ? [{
        type: 'turn_end',
        seq: this.seq++,
        ts,
        turn: 1,
        usageScope: 'run' as const,
        ...(this.contextWindow === undefined ? {} : { contextWindow: this.contextWindow }),
        ...(this.contextTokens === undefined ? {} : { contextTokens: this.contextTokens }),
        // P1-11: a non-completed run is `failed`, NOT `tool_use`. The old
        // encoding made every provider refusal look like a tool-calling turn,
        // and `applyTurnEnd` only treats `max_tokens` as failure — so a 0-token
        // failure was recorded as `status: "done"`. Truth beats taxonomy here:
        // the caller learns the run failed from `failed`, and the transcript
        // can say so.
        stopReason: outcome === 'completed' ? 'end_turn' : 'failed',
        // Omitted rather than zeroed when the stream never reported
        // usage: a missing value and a literal 0 mean different things
        // to the context-window ring.
        ...(usage
          ? {
              usage: {
                input_tokens: usage.inputTokens,
                output_tokens: usage.outputTokens,
              },
            }
          : {}),
      } as LoopEvent] : []),
      {
        type: 'loop_end',
        seq: this.seq++,
        ts,
        reason,
        numTurns: meta?.iterations ?? 0,
        totalCost: 0,
        durationMs: meta?.durationMs ?? 0,
        finalResult,
        isError,
      },
    ];
  }
}
