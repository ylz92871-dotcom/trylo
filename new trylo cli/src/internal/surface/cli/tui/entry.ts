import type { LearningSwitch } from "../args.js";
import type { SessionLearningOptions } from "../session-learning-options.js";
import { EXIT_CODES, type ExitCode } from "../../../protocol/cli-stream.js";
import type { CliContext } from "../context.js";
import { handleRepl } from "../repl.js";
import { reportFailure, runOneTurn, type RunScaffold } from "../run-command.js";
import type { CliSink } from "../render.js";
import { parseSlash } from "../slash.js";
import { newTuiSessionOptions, openTuiSession, tuiSlash } from "./slash-actions.js";
import { readMultiLine } from "../multiline.js";
import type { TuiIo } from "./io.js";
import type { Painter } from "./painter.js";
import { interruptHubOf, type InterruptHub } from "./interrupt-hub.js";
import { statusBar } from "./status-bar.js";
import { runConnectionStartup } from "./connection-ui.js";
import { emptyTuiState, pushUserLine, type TuiFacts } from "./state.js";
import { prepareInput } from "../mention.js";
import { createIdleDispatch, type IdleDispatchSource } from "../queued-dispatch.js";
import { createMidRunInput, type MidRunInputFactory } from "./mid-run-input.js";
import { wireComposer } from "./composer-wiring.js";
import { answerQuestionInput } from "../question-input.js";
import { tuiTurn, type TuiTurnRunner } from "./turn.js";
import { colorPaint, colorsEnabled, noPaint, type TuiPaint } from "./theme.js";
import { fitText, projectName } from "./text.js";

// The runner contract moved to `turn.ts` with the per-turn execution itself; the
// entry re-exports it because the shell's callers have always named it here.
export type { TuiTurnRunner } from "./turn.js";

/**
 * The TUI entry (work package T2).
 *
 * The dispatch contract: a bare `trylo` reaches this entry where `{ kind:
 * "repl" }` is handled today. When stdin is not a terminal this function IS
 * the old line REPL — the same `handleRepl` call, so the non-TTY behavior is
 * byte-identical by construction, not by reimplementation (contract #2, the
 * hard gate). On a terminal the TUI shell runs instead.
 *
 * The shell owns no loop of its own in the forbidden sense: every turn goes
 * through the one run host (`runOneTurn`), the slash table is the shared
 * one, and the only state it keeps is frame state fed by surface events.
 * What it deliberately does not do is call providers, touch permission
 * ports, or schedule tools — `tui/discipline.test.ts` scans for exactly
 * that.
 *
 * Turn events reach the shell through the `stream-json` wire contract: the
 * runner forces `format: "stream-json"` so the sink receives one JSON event
 * per line, and the collector parses them back into `CliStreamEvent`s. The
 * TUI is therefore just another consumer of the same event stream a parent
 * process would read — no second projection is built anywhere.
 *
 * Interrupts arrive through one capability bit (`ctx.interrupts`), built by the
 * composition root; the pure machine in `interrupt.ts` decides and this file
 * acts. The first Ctrl-C cancels the turn in flight — a state transition inside
 * the loop, ending `cancelled` — and the second leaves the process with 130,
 * the cancellation exit code the table already had.
 */

export async function handleReplEntry(
  ctx: CliContext,
  sink: CliSink,
  learning?: LearningSwitch,
  learningOptions: SessionLearningOptions = {},
): Promise<ExitCode> {
  if (!ctx.stdinIsTty) {
    return handleRepl(ctx, sink, learning, learningOptions);
  }

  const painterRef: { current?: Painter | undefined } = {};
  const wired = wireComposer(ctx, painterRef);

  // One reader for the whole session: a terminal line source has no cancel, so
  // a second reader that came and went with each turn would leave a read parked
  // that the prompt could never be served from (see the probe noted in
  // `mid-run-input.ts`).
  return handleTui(
    wired.ctx,
    wired.io,
    realTurnRunner(wired.ctx),
    learning,
    painterRef,
    () => createMidRunInput(wired.composer === undefined ? { io: wired.io } : { io: wired.io, composer: wired.composer }),
    createIdleDispatch(wired.ctx),
    wired.hubRef,
    learningOptions,
  );
}

export async function handleTui(
  ctx: CliContext,
  io: TuiIo,
  runner: TuiTurnRunner,
  learning?: LearningSwitch,
  painterRef: { current?: Painter | undefined } = {},
  /**
   * The shell's reader (WP08). Absent — every caller that does not own a
   * terminal that keeps producing lines while a turn runs, which is every test
   * — means the shell reads only at its own prompt, exactly as it did before.
   *
   * Called at most once per session: the reader it returns owns every read from
   * then on.
   */
  midRun?: MidRunInputFactory,
  /**
   * 后台队列派发（WP08 / C41）。缺省 —— 每一个不带后台队列的调用方与全部
   * 测试 —— 表示这个会话不读队列，循环一个字都不多问。
   */
  idleDispatch?: IdleDispatchSource,
  /**
   * Where the shell registers its interrupt hub (WP23.2). Present, the
   * composer's raw-mode Ctrl-C reaches the same machine a SIGINT would.
   */
  hubRef?: { current?: InterruptHub | undefined },
  learningOptions: SessionLearningOptions = {},
): Promise<ExitCode> {
  const options = newTuiSessionOptions(ctx.newId("repl"), learning, learningOptions);
  const startup = await runConnectionStartup(ctx, io, options, (openOptions) =>
    openTuiSession(ctx, io, openOptions),
  );
  if (startup.kind === "stop") {
    return startup.exitCode;
  }

  const hub = interruptHubOf(io, ctx);

  if (hubRef !== undefined) {
    hubRef.current = hub;
  }

  const paint = paintFor(ctx);

  // Keep the opening compact; the prompt loop owns the live status beneath it.
  io.write(`${openingLines(startup.scaffold, io.size().columns, paint).join("\n")}\n`);
  let scaffold = startup.scaffold;

  try {
    const stop = await tuiLoop(ctx, io, runner, startup.scaffold, hub, paint, painterRef, midRun, idleDispatch);
    scaffold = stop.scaffold;
    return stop.exitCode;
  } finally {
    await scaffold.close();
  }
}

/**
 * How the shell paints a line: with colour on a terminal that wants it, and
 * with nothing at all anywhere else.
 *
 * The decision is made once, here, and handed down — the state machine and the
 * renderer never ask. That is what keeps the frame a pure function of the turn
 * rather than of the machine it happens to be running on.
 */
function paintFor(ctx: CliContext): TuiPaint {
  return colorsEnabled(ctx.env, ctx.stdinIsTty) ? colorPaint() : noPaint;
}

/** The project and model first, then the operations needed to start typing. */
function openingLines(
  scaffold: RunScaffold,
  columns: number,
  paint: TuiPaint,
): ReadonlyArray<string> {
  // What this session is, not just its id: a person who ran `trylo` in the
  // wrong directory or against the wrong provider should see that before they
  // type, not after the first answer comes back wrong.
  return [
    paint("user", fitText(`Trylo · ${projectName(scaffold.workspaceRoot)} · ${scaffold.providerId}/${scaffold.model}`, columns - 1)),
    paint("system", fitText("输入需求即可开始 · / 命令 · /models 模型 · /settings 设置", columns - 1)),
    paint("system", fitText("Enter 发送 · \\ + Enter 换行 · Ctrl+R 历史 · Ctrl+G 编辑 · /exit 退出", columns - 1)),
    "",
  ];
}

function realTurnRunner(ctx: CliContext): TuiTurnRunner {
  return (scaffold, text, sink, cancel, pendingInput) =>
    runOneTurn(
      ctx,
      { ...scaffold, format: "stream-json" },
      text,
      sink,
      "interactive",
      {},
      cancel,
      pendingInput,
    );
}

function factsOf(scaffold: RunScaffold): TuiFacts {
  return {
    workspaceRoot: scaffold.workspaceRoot,
    ...(scaffold.permissions === undefined ? {} : { permissionMode: scaffold.permissions.snapshot().mode }),
    sessionId: scaffold.sessionId,
    providerId: scaffold.providerId,
    model: scaffold.model,
    maxIterations: scaffold.maxIterations,
    contextTokenLimit: scaffold.contextTokenLimit,
  };
}

type TuiStop = { readonly exitCode: ExitCode; readonly scaffold: RunScaffold };

async function tuiLoop(
  ctx: CliContext,
  io: TuiIo,
  runner: TuiTurnRunner,
  start: RunScaffold,
  hub: InterruptHub,
  paint: TuiPaint,
  painterRef: { current?: Painter | undefined },
  midRun?: MidRunInputFactory,
  idleDispatch?: IdleDispatchSource,
): Promise<TuiStop> {
  let scaffold = start;
  let state = emptyTuiState(factsOf(scaffold));
  // Empty input changes nothing, so the bar already on screen is still the
  // truth and re-writing it stacked a duplicate line for every plain Enter.
  let redrawBar = true;
  /**
   * Lines already spoken, waiting to be read at the prompt.
   *
   * Two ways a line gets here, and both are the same promise kept: a person who
   * said something while a turn was running hears it answered — either by that
   * turn, or by the next one. Before this list existed those words sat in the
   * terminal's own buffer and only came back at the next prompt, which is to
   * say the shell could not hear a redirection at all (WP08).
   */
  let pending: ReadonlyArray<string> = [];
  // One reader for the session, built before the first prompt and never rebuilt:
  // it is the only thing that calls `io.readLine` from here on, and the shell
  // takes its lines from it instead of reading the terminal itself. Absent, the
  // shell reads exactly as it always did.
  const mid = midRun?.();
  /**
   * 后台队列上一次报的读不到是什么（WP08 / C41）。只为去重：同一种反复出现
   * 不再刷屏，而换了种类要重新说一句——因为「队列读不到」和「队列空了」会
   * 让人得出相反的结论，沉默会让后者被当成前者。
   */
  let lastQueueProblem: string | undefined;

  for (;;) {
    if (hub.exitRequested) {
      return { exitCode: EXIT_CODES.CANCELLED, scaffold };
    }

    hub.phase = "idle";
    /**
     * Idle 派发（WP08 / C41）：只在真正空闲时问一次队首。
     *
     * 排在 `pending` 之后是刻意的：刚在这个终端里说出的话等了不到一秒，而
     * 队列里的消息已经等过至少一轮，让后者插到前者前面就是让会话先答旧的
     * 再说刚说的。人打字的顺序就是他的意思。
     *
     * 队列消息**不走斜杠表也不走 mention 展开**：它是另一个终端发来的一段
     * 文本，交给斜杠表就等于让一条后台消息能触发 `/exit`。想要 mention 的人
     * 在排队时就该把文件内容带上。
     */
    let queued: { readonly id: string; readonly text: string; readonly remaining: number } | undefined;

    if (idleDispatch !== undefined && pending.length === 0) {
      const dispatch = await idleDispatch(scaffold.sessionId);
      if (dispatch.kind === "turn") {
        queued = dispatch;
      } else if (dispatch.kind === "unknown") {
        if (dispatch.code !== lastQueueProblem) {
          lastQueueProblem = dispatch.code;
          io.write(`cannot read this session's queued messages (${dispatch.code}); they stay queued\n`);
        }
      } else {
        lastQueueProblem = undefined;
      }
    }

    if (redrawBar) {
      io.write(`${statusBar(state, io.size().columns)}\n`);
    }

    // The prompt must come from the line reader, not from us: `rl.question("")`
    // refreshes its own line and erased a hand-written "> " before it was ever
    // seen. Continuation lines keep the old empty prompt.
    let promptShown = false;
    const line =
      queued?.text ??
      (pending[0] ??
        (mid === undefined
          ? await readMultiLine(async () => {
              const prompt = promptShown ? "" : "> ";
              promptShown = true;
              return io.readLine(prompt);
            })
          : await mid.takeLine()));

    if (queued === undefined) {
      pending = pending.slice(1);
    }

    redrawBar = true;

    if (line === undefined) {
      return { exitCode: EXIT_CODES.OK, scaffold };
    }

    const input = line.trim();
    if (input.length === 0) {
      redrawBar = false;
      continue;
    }

    /**
     * What the run host receives. Usually the prepared text (mentions expanded,
     * the file's contents inlined) and only that; a queued message is already
     * the words to say, so it goes as typed.
     */
    let turnText = input;

    if (queued === undefined) {
      const slash = parseSlash(input);
      if (slash.kind === "unknown") {
        io.write(`unknown command ${slash.token}; /help for the list\n`);
        continue;
      }

      if (slash.kind === "known") {
        const step = await tuiSlash(ctx, io, scaffold, state, slash.invocation, factsOf);
        if (step.kind === "stop") {
          return { exitCode: step.exitCode, scaffold };
        }

        if (step.kind === "retry") {
          reportFailure(ctx, step.failure);
          continue;
        }

        scaffold = step.scaffold;
        state = step.state;
        continue;
      }

      const prepared = prepareInput(input, {
        cwd: ctx.cwd,
        readFile: ctx.readFile,
        isDirectory: ctx.isDirectory,
      });
      if (!prepared.ok) {
        // Refused rather than sent, and said on screen: a turn about a file that
        // never arrived would have the model answer confidently about something
        // it cannot see.
        io.write(`${prepared.problem}\n`);
        continue;
      }

      if (prepared.note !== undefined) {
        io.write(`${prepared.note}\n`);
      }

      turnText = prepared.text;
    } else {
      // Said so the queue is not invisible: a person who queued a message wants
      // to see it leave the queue, not to infer it from the reply.
      io.write(
        `answering queued message ${queued.id}` +
          (queued.remaining === 0 ? " (last one)\n" : ` (${queued.remaining} more waiting)\n`),
      );
    }

    state = pushUserLine(state, input);
    turnText = await answerQuestionInput(scaffold.questions, turnText, mid === undefined ? io.readLine : async prompt => {
      if (prompt !== undefined) io.write(prompt);
      return mid.takeLine();
    }, state.waiting?.kind === "question" ? state.waiting.requestId : undefined);

    if (turnText !== input && state.waiting?.kind === "question") state = { ...state, waiting: undefined };

    hub.phase = "running";
    const turn = await tuiTurn(
      io,
      runner,
      scaffold,
      state,
      turnText,
      hub,
      paint,
      painterRef,
      mid,
    );

    state = turn.state;
    scaffold = turn.scaffold;
    hub.phase = "idle";

    if (turn.kind === "stop") return { exitCode: turn.exitCode, scaffold };

    // What the turn never took, and what arrived too late for it, go back to the
    // prompt rather than nowhere: the person still hears them answered.
    pending = [...pending, ...turn.leftover];
  }
}
