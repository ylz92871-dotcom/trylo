import type { RunScaffold } from "./run-command.js";
import type { StdioSession } from "./stdio-session.js";
import type { CliSink } from "./render.js";
import type { CliContext } from "./context.js";
import type { TurnOutcome } from "./host.js";
import type { RunFailure } from "./run-failure.js";
import { openGoalSession } from "./goal-session.js";
import { isCliRunResult } from "../../protocol/cli-stream.js";
import { createProjection } from "./render.js";

/** Hold the one terminal projection until goal persistence acknowledges it. */
export async function prepareGoalRun(scaffold: RunScaffold, control: Pick<StdioSession, "goalCommand" | "goalAction"> | undefined, sink: CliSink, ctx: Pick<CliContext, "newId" | "now">) {
  if (control?.goalCommand === undefined) return { kind: "run" as const, scaffold, sink, finish: async (_outcome: TurnOutcome | RunFailure): Promise<void> => undefined };

  if (scaffold.session === undefined) throw new Error("goal_requires_durable_session");

  const goal = await openGoalSession({ command: control.goalCommand, records: scaffold.resumeRecords ?? [], session: scaffold.session,
    sessionId: scaffold.sessionId, turnId: ctx.newId("turn"), now: ctx.now, emit: frame => sink.stdout(`${JSON.stringify(frame)}\n`) });

  if (control.goalCommand.action === "edit") {
    // The durable goal snapshot above acknowledges the edit. Maintenance has
    // no provider request, no execution iteration and no additional usage.
    const projection = createProjection(scaffold.format, sink);

    projection.onEvent({ type: "run_start", sessionId: scaffold.sessionId, turnId: goal.turnId, providerId: scaffold.providerId, model: scaffold.model });
    projection.onEvent({ type: "run_result", status: "completed", finishReason: "goal_edited", sessionId: scaffold.sessionId,
      turnId: goal.turnId, iterations: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, durationMs: 0, lastMessage: "" });

    return { kind: "updated" as const, scaffold, sink, finish: async (_outcome: TurnOutcome | RunFailure): Promise<void> => undefined };
  }

  let terminal: string | undefined;
  const held: CliSink = { stderr: sink.stderr, stdout(line) {
    let value: unknown;
    try { value = JSON.parse(line) as unknown; } catch { /* preserve non-JSON producer diagnostics */ }
    if (isCliRunResult(value)) terminal = line; else sink.stdout(line);
  } };

  return {
    kind: "run" as const,
    scaffold: { ...scaffold, goal,
      systemPromptAppend: [scaffold.systemPromptAppend, goal.reminder()].filter(Boolean).join("\n\n") },
    sink: held,

    async finish(outcome: TurnOutcome | RunFailure) {
      await goal.finish("result" in outcome ? outcome.result : { status: "failed", finishReason: outcome.message }, control.goalAction());
      if (terminal !== undefined) sink.stdout(terminal);
    },
  };
}
