// Trylo Work — task / conversation message contract
// (M4-E, architecture doc §6.6 / §14; 2026-08-28 chat-mode split).
//
// One Work conversation = ONE durable daemon thread. Every
// message the renderer sends goes through `task.create`
// (first turn) or `task.sendMessage` (every later turn) —
// the vendor protocol has no "chat-only" switch, so the
// INTENT is carried in the message wrapper:
//
//   - conversation message (the DEFAULT send): wrapped by
//     `buildWorkChatMessage`. The agent must answer in the
//     conversation and must NOT run tools / write files —
//     this is the fix for the user-reported "sent 你好 and
//     it reflexively started working" defect.
//   - task message (the explicit 任务 button or an accepted
//     suggestion chip): wrapped by `buildWorkspaceTaskPrompt`
//     (first turn) / `buildWorkTaskFollowUp` (later turns).
//     Tool use and `.trylo/out/` deliverables are allowed.
//
// The vendor `task.sendMessage` also gave us the ENOENT
// double-path bug (agent prepended the workspace root to an
// already-absolute path). Both task wrappers therefore carry
// the path-hygiene rule: build a file path ONCE from the
// root, never re-prepend it.
//
// `looksLikeTaskIntent` is the renderer's heuristic for the
// inline suggestion chip ("this looks like a task — run it
// as one?"). It is deliberately cheap (no LLM call) and
// conservative: only clear work orders match.

/** A workspace-relative attachment descriptor projected into
 *  the Work prompt. `relativePath` is ALWAYS a path inside
 *  the workspace's `.trylo/attachments/<conversation>/<id>/`
 *  staging area — the host stages external files there via
 *  the Rust `stage_attachment` command before projecting. */
export interface WorkAttachmentDescriptor {
  readonly id: string;
  /** Original display name (may carry Unicode). */
  readonly name: string;
  /** Workspace-relative staged path (never absolute). */
  readonly relativePath: string;
  readonly mediaType: string;
  readonly size: number;
}

/** Collapse the workspace root to a readable label.
 *  Kept internal so path formatting never leaks into the
 *  prompt contract's public signature. */
function trimTrailingSlashes(root: string): string {
  return root.replace(/[\\/]+$/, "");
}

/**
 * Format a user message plus its attachment descriptors into
 * the single wire string handed to the daemon. Shared by
 * every wrapper below so all of them project attachments
 * identically. Zero noise when there are no attachments
 * (returns `userText` verbatim).
 *
 * The `<trylo_attachments>` block is internal protocol — the
 * renderer never shows it in a message bubble; only the
 * user's own text goes into the visible bubble.
 */
export function formatWorkMessage(args: {
  userText: string;
  attachments?: readonly WorkAttachmentDescriptor[];
}): string {
  const attachments = args.attachments ?? [];
  if (attachments.length === 0) return args.userText;
  const lines: string[] = ["<trylo_attachments>"];
  for (const a of attachments) {
    lines.push(`- id: ${a.id}`);
    lines.push(`  name: ${a.name}`);
    lines.push(`  path: ${a.relativePath}`);
    lines.push(`  media_type: ${a.mediaType}`);
    lines.push(`  size: ${a.size}`);
  }
  lines.push("</trylo_attachments>");
  return `${args.userText}\n\n${lines.join("\n")}`;
}

/** Shared path-hygiene rule (task wrappers only). The
 *  ENOENT double-path bug: the agent prefixed the workspace
 *  root onto a path that already contained it. */
const PATH_RULE =
  "Path rule: the workspace root above is already absolute. " +
  "Build any file path exactly ONCE from it (join root + " +
  "relative segments). NEVER prepend the root to a path that " +
  "already starts with it, and never embed the root inside " +
  "itself.";

/** Product identity for the reused Work runtime. Kept in every wrapper because
 * follow-up messages may be replayed independently during recovery. */
export const TRYLO_WORK_IDENTITY =
  "You are Trylo Work, the work agent built into Trylo Desktop. " +
  "Identify yourself only as Trylo Work or Trylo in user-facing replies. " +
  "Never claim that you are Cowork, Claude Code, Claude, Anthropic, or another product. " +
  "The underlying runtime and model provider are implementation details. " +
  "For work that creates or changes files, finish with a concise section titled 交付结果. " +
  "Name every important deliverable, put each exact workspace-relative path in backticks, " +
  "and summarize the delivered result and validation; never end with only a generic success sentence.";

/**
 * Wrap a CONVERSATION message (the default ⏎ send). The
 * agent answers in the conversation; tool use is forbidden
 * except reading the staged attachments the user attached
 * to THIS message (the user may attach a file and ask a
 * question about it — reading it is answering, not working).
 * Never writes files, never creates artifacts.
 */
export function buildWorkChatMessage(args: {
  userText: string;
  attachments?: readonly WorkAttachmentDescriptor[];
}): string {
  const body = formatWorkMessage(args);
  const readRule =
    (args.attachments?.length ?? 0) > 0
      ? " The ONLY exception: you MAY read the staged " +
        "attachment files listed below when the user's " +
        "question is about them."
      : "";
  return (
    "<trylo_conversation>\n" +
    "This is a CONVERSATION message, not a work order. " +
    "Reply directly in the conversation like a normal " +
    "assistant. Do not use any tools. Do not create any " +
    "files. Do not edit or modify any files. Do not make " +
    "any changes. Do not read workspace files, run " +
    "commands, or download anything." +
    readRule +
    " If the user later wants real work done, they will " +
    "send a task.\n" +
    "</trylo_conversation>\n\n" +
    body +
    "\n\n<trylo_identity>\n" +
    TRYLO_WORK_IDENTITY +
    "\n</trylo_identity>"
  );
}

/**
 * Build the task system prompt for a Work task's FIRST turn
 * (the explicit 任务 send on a fresh conversation). Tool use
 * is allowed; deliverables go to `.trylo/out/`.
 */
export function buildWorkspaceTaskPrompt(
  root: string,
  userRequest: string,
  attachments?: readonly WorkAttachmentDescriptor[],
): string {
  const workspace = trimTrailingSlashes(root);
  const body = formatWorkMessage({ userText: userRequest, attachments });
  return (
    `Execute a work task for the workspace at ` +
    `${workspace}.\n\n` +
    `${PATH_RULE}\n\n` +
    `${body}\n\n` +
    `Deliver a verifiable result. If the task requires a ` +
    `deliverable FILE (a report, spreadsheet, slide deck, or ` +
    `web page), save it to the workspace's .trylo/out/ ` +
    `directory so the Work sub-app can pick it up; otherwise ` +
    `just answer in the conversation. When you create a deliverable ` +
    `file, the final answer MUST name every delivered file and include ` +
    `its exact workspace-relative path under .trylo/out/.\n\n` +
    `<trylo_identity>\n${TRYLO_WORK_IDENTITY}\n</trylo_identity>`
  );
}

/**
 * Wrap an explicit TASK follow-up (任务 send on a thread that
 * already exists). Same contract as the first turn except
 * there is no root line — the thread's opening prompt
 * already carries it, which is exactly why the path rule
 * must travel with the message.
 */
export function buildWorkTaskFollowUp(args: {
  userText: string;
  attachments?: readonly WorkAttachmentDescriptor[];
}): string {
  const body = formatWorkMessage(args);
  return (
    "<trylo_task>\n" +
    "This is a WORK ORDER for the current task. Tools, " +
    "workspace reads, and commands are allowed as needed.\n" +
    `${PATH_RULE}\n` +
    "If this work order requires a deliverable FILE (a " +
    "report, spreadsheet, slide deck, or web page), save it " +
    "under the workspace's .trylo/out/ directory; otherwise " +
    "answer in the conversation. When you create a deliverable " +
    "file, the final answer MUST name every delivered file and include " +
    "its exact workspace-relative path under .trylo/out/.\n" +
    "</trylo_task>\n\n" +
    body +
    "\n\n<trylo_identity>\n" +
    TRYLO_WORK_IDENTITY +
    "\n</trylo_identity>"
  );
}

/**
 * Pure system contract for the P0 Work→Code single-send path.
 *
 * Unlike the legacy task/chat wrappers above, this is NOT a message wrapper —
 * it is the SYSTEM prompt handed to the Trylo Code CLI for one Work
 * conversation. It dresses the CLI as Trylo Work, pins the workspace, and
 * makes a single, stable rule: whether tools run this turn is decided by the
 * MODEL from the user's request, with no per-turn chat/task classification.
 * Deliverable files go to `.trylo/out/` so the Work ResultDock can pick them
 * up. The user's own text travels separately (via `formatWorkMessage`), not
 * inside this prompt.
 */
export function buildWorkProfilePrompt(root: string): string {
  const workspace = trimTrailingSlashes(root);
  return (
    `${TRYLO_WORK_IDENTITY}\n\n` +
    `Workspace root (already absolute): ${workspace}.\n` +
    `${PATH_RULE}\n\n` +
    `This is a single Work surface with no separate "task" mode. ` +
    `Decide from the user's request whether to use tools — answer a ` +
    `greeting or question directly; read files / run commands / edit when ` +
    `the user asks for work. Do not fabricate work the user did not request.` +
    `\n\n` +
    `Deliverable files: when a request needs a deliverable FILE (report, ` +
    `spreadsheet, slide deck, web page, etc.), save it under the workspace's ` +
    `.trylo/out/ directory so the Work sub-app can surface it. When you ` +
    `create a deliverable, the final answer MUST name every delivered file ` +
    `with its exact workspace-relative path under .trylo/out/ and summarize ` +
    `the result and validation; never end with only a generic success line.`
  );
}

/** Matched verb stems (zh + en) that signal a work order.
 *  Kept deliberately narrow — false positives annoy more
 *  than false negatives (the 任务 button is always there). */
const TASK_INTENT_PATTERNS: readonly RegExp[] = [
  /帮我|替我|给我|为我/,
  /整理|生成|制作|创建|建一[个份]|写一[个份]|做一[个份]|做份|导出|导入|转换|批量/,
  /统计|汇总|分析|总结|归纳|提取|筛选|排序/,
  /翻译|校对|排版|压缩|合并|拆分/,
  /下载|爬取|抓取|读取.{0,12}(文件|表格|清单|数据)/,
  /\b(create|generate|make|build|prepare|organis?ze|analyze|analyse|convert|export|download|summarize|extract|compile)\b/i,
];

/**
 * Renderer-side task-intent heuristic for the inline
 * suggestion chip. Pure, cheap, conservative: a plain
 * greeting or question never matches; a clear work order
 * ("帮我把教案整理成表格") does.
 */
export function looksLikeTaskIntent(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 4 || trimmed.length > 500) return false;
  return TASK_INTENT_PATTERNS.some((pattern) => pattern.test(trimmed));
}
