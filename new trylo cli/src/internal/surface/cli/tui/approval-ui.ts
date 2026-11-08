import { decision, type InteractivePermissionIo, type PermissionAction, type PermissionDecision } from "../permission.js";
import type { Painter } from "./painter.js";
import type { TuiIo } from "./io.js";
import { choose } from "./choose.js";
import { wrapLine } from "./frame.js";

/**
 * Structured approval UI for the TUI.
 *
 * The panel owns the terminal while a decision is waiting: it pauses the live
 * turn painter so the prompt is not erased by a stray repaint, prints the full
 * call, and reads one of the canonical choices. Cancelling the panel (EOF or an
 * explicit cancel) resolves the Promise with a `cancelled` decision so the
 * pending call can never dangle.
 */

const VALID_CHOICES = new Set(["y", "yes", "s", "session", "n", "no", "d", "c", "cancel"]);

export type ApprovalCallbacks = Pick<InteractivePermissionIo, "requestApproval" | "onApproval">;

export function tuiApprovalCallbacks(
  io: TuiIo,
  painterRef: { readonly current?: Painter | undefined },
): ApprovalCallbacks {
  const pending = new Set<PermissionAction>();
  return {
    requestApproval: (action) => readApprovalDecision(io, action),

    onApproval: (event) => {
      if (event.kind === "waiting") {
        pending.add(event.action);
        painterRef.current?.pause();
        return;
      }
      if (pending.delete(event.action) && pending.size === 0) painterRef.current?.resume();
    },
  };
}

async function readApprovalDecision(io: TuiIo, action: PermissionAction): Promise<PermissionDecision> {
  // The rule is a modal boundary, not a frame: it stops short of a wide
  // terminal and shrinks with a narrow one instead of wrapping.
  const rule = Math.max(10, Math.min(io.size().columns - 1, 60));

  io.write(`${"─".repeat(rule)}\n`);
  io.write(`approval required: ${action.name}\n`);
  const args = formatArguments(action.arguments);
  if (args.length > 0) {
    for (const row of wrapLine(`arguments: ${args}`, Math.max(10, io.size().columns - 1))) io.write(`${row}\n`);
  }

  io.write(`call id: ${action.toolCallId}\n`);

  if (io.choose !== undefined) {
    const answer = await choose(io, { title: "此操作尚未执行，请选择授权范围", items: [
      { id: "y", label: "允许一次" },
      { id: "s", label: "记住此次调用", detail: "仅记住当前参数的授权" },
      { id: "n", label: "拒绝一次" },
      { id: "d", label: "禁用此工具", detail: "本会话后续调用也会拒绝" },
      { id: "c", label: "取消", detail: "不执行此操作" },
    ] });
    if (answer === "y" || answer === "s") return decision("approved", answer === "y" ? "once" : "session");

    if (answer === "n" || answer === "d") return decision("denied", answer === "n" ? "once" : "session", "user_denied");

    return decision("cancelled", "once", "user_cancelled");
  }

  // Wrapped on purpose: a choice line folded by the terminal itself breaks
  // mid-token and reads as noise, so the panel folds it where there is room.
  for (const line of choiceLines(io.size().columns)) {
    io.write(`${line}\n`);
  }

  for (;;) {
    io.write("approval choice: ");
    const answer = await io.readLine();
    if (answer === undefined) {
      io.write("\n");
      return decision("cancelled", "once", "input_closed");
    }

    const normalized = answer.trim().toLowerCase();
    if (!VALID_CHOICES.has(normalized)) {
      io.write("choose y/s/n/d/c; the command has not run\n");
      continue;
    }

    if (normalized === "y" || normalized === "yes") {
      return decision("approved", "once");
    }

    if (normalized === "s" || normalized === "session") {
      return decision("approved", "session");
    }

    if (normalized === "n" || normalized === "no") {
      return decision("denied", "once", "user_denied");
    }

    if (normalized === "d") {
      return decision("denied", "session", "user_denied");
    }

    return decision("cancelled", "once", "user_cancelled");
  }
}

function formatArguments(arguments_: Record<string, unknown>): string {
  const entries = Object.entries(arguments_)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${summarize(value)}`);
  return entries.join(" ");
}

function summarize(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return "?";
  return text.replace(/\s+/g, " ");
}


/**
 * The five answers, wrapped to the terminal.
 *
 * Every option stays whole: "[s] remember exact call" cut in half is worse
 * than one option moved to the next line.
 */
function choiceLines(columns: number): ReadonlyArray<string> {
  const parts = ["[y] once", "[s] remember exact call", "[n] deny", "[d] disable tool", "[c] cancel"];
  const lines: string[] = [];
  let current = "";

  for (const part of parts) {
    const grown = current.length === 0 ? part.length : current.length + 2 + part.length;
    if (current.length > 0 && grown > columns) {
      lines.push(current);
      current = part;
    } else {
      current = current.length === 0 ? part : `${current}  ${part}`;
    }
  }

  if (current.length > 0) {
    lines.push(current);
  }

  return lines;
}
