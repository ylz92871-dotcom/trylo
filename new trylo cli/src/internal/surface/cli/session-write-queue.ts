import type { SessionPort } from "../../ports/session.js";

type AppendResult = Awaited<ReturnType<SessionPort["append"]>>;

const MAX_PENDING_APPENDS = 128;
const APPEND_SYSTEM_CODES = new Set(["ENOMEM", "EMFILE", "ENFILE", "EIO", "EACCES", "EPERM", "ENOENT", "EBUSY",
  "ENOSPC", "ERR_FS_FILE_TOO_LARGE", "ERR_STRING_TOO_LONG", "ERR_BUFFER_TOO_LARGE", "ERR_OUT_OF_RANGE"]);

/** Preserve a bounded cause without leaking exception messages, paths or data. */
function appendFailureCode(error: unknown): string {
  try {
    if (typeof error === "object" && error !== null && "code" in error) {
      const code = (error as { readonly code?: unknown }).code;
      if (typeof code === "string" && APPEND_SYSTEM_CODES.has(code)) return `session_append_threw:${code}`;
    }
    if (error instanceof RangeError) return "session_append_threw:RangeError";
    if (error instanceof TypeError) return "session_append_threw:TypeError";
  } catch { /* A diagnostic must not replace the original durability failure. */ }
  return "session_append_threw";
}

/** One bounded append lane for loop and subagent facts, with a sticky failure. */
export function serializeSessionWrites(base: SessionPort): SessionPort {
  let tail = Promise.resolve();
  let pending = 0;
  let failure: { readonly ok: false; readonly code: string } | undefined;

  return {
    start: input => base.start(input),
    attach: () => base.attach(),

    async append(record): Promise<AppendResult> {
      if (pending >= MAX_PENDING_APPENDS) {
        failure ??= { ok: false, code: "session_write_queue_full" };
        return failure;
      }

      pending++;
      const operation = tail.then(async (): Promise<AppendResult> => {
        // Later events cannot overtake an append whose durability is already lost.
        if (failure !== undefined) return failure;
        try {
          const outcome = await base.append(record);
          if (!outcome.ok) failure = outcome;
          return outcome;
        } catch (error) {
          failure = { ok: false, code: appendFailureCode(error) };
          return failure;
        }
      });

      tail = operation.then(() => { pending--; });

      return operation;
    },

    async read() {
      await tail;
      return base.read();
    },

    async readRecords() {
      await tail;
      return base.readRecords();
    },

    async repairTornTail() {
      await tail;
      return base.repairTornTail();
    },

    async release() {
      await tail;
      await base.release();
    },
  };
}
