/**
 * The three ceilings WP12 declared in `ports/language-server.ts` but never
 * enforced: how many locations one answer may keep, how many bytes one
 * message may carry, and how long an unused connection may live.
 *
 * Two layering rules shape this file:
 *
 *   - no second JSON-RPC parser. Inbound framing stays the library's; this
 *     file only scans `Content-Length` declarations so a message that
 *     *declares* more than the cap never gets its body allocated. A message
 *     with no parseable headers passes through untouched and fails, if it
 *     fails, on the library's terms — exactly as before this file existed.
 *   - limit failures travel as named errors (`LspMessageTooLarge`), the same
 *     shape as the existing `LspServerExited`/`LspCancelled` markers, so the
 *     single error mapper in `lsp-request.ts` stays the only translator.
 *
 * Enforcement itself is a decorator over the port (`withQueryLimits`), not
 * code inside the lifecycle: the client owns starting, stopping and crash
 * settling, and this owns the ceilings. A ceiling that lived in the client
 * could only be tested by starting a process; on the port boundary every
 * rule below is assertable against a stub.
 */

import { PassThrough, type Readable } from "node:stream";
import type { LspAnswer, LspLimits, LspQuery, LanguageServerPort } from "../../ports/language-server.js";

const LIMIT_ERROR_NAME = "LspMessageTooLarge";

/** A limit refusal the error mapper recognises. Thrown, never returned. */
export function limitError(message: string): Error {
  const error = new Error(message);
  error.name = LIMIT_ERROR_NAME;
  return error;
}

export function isLimitError(error: unknown): boolean {
  return error instanceof Error && error.name === LIMIT_ERROR_NAME;
}

export type TruncatedAnswer = {
  readonly answer: LspAnswer;
  readonly truncated: boolean;
};

/**
 * Keep the first entries of an array answer. Hover carries one markdown
 * string rather than locations, so the inbound byte cap — not this function —
 * is its guard; `empty` has nothing to cut.
 */
export function truncateAnswer(answer: LspAnswer, maxLocations: number): TruncatedAnswer {
  const keep = Math.max(0, maxLocations);
  switch (answer.status) {
    case "answered":
      return answer.locations.length <= keep
        ? { answer, truncated: false }
        : { answer: { status: "answered", locations: answer.locations.slice(0, keep) }, truncated: true };
    case "symbols":
      return answer.symbols.length <= keep
        ? { answer, truncated: false }
        : { answer: { status: "symbols", symbols: answer.symbols.slice(0, keep) }, truncated: true };
    case "calls":
      return answer.items.length <= keep
        ? { answer, truncated: false }
        : { answer: { status: "calls", items: answer.items.slice(0, keep) }, truncated: true };
    case "hover":
    case "empty":
      return { answer, truncated: false };
  }
}

/**
 * Serialised outbound size, measured before anything is sent. `undefined`
 * when the value cannot be serialised at all — refusing to send what cannot
 * be measured is the fail-closed direction.
 */
export function outboundByteLength(params: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(params), "utf8");
  } catch {
    // Terminal branch (typed failure, fail-closed): what cannot be serialised
    // cannot be measured, so the caller refuses to send it instead of sending
    // an unbounded payload. No cleanup is owed — nothing was allocated.
    return undefined;
  }
}

/**
 * The one outbound question, asked the same way everywhere: does this payload
 * fit the cap, and if not, what do we tell the caller instead of sending it.
 * Returns the refusal message, or `undefined` when the payload may go.
 */
export function checkOutbound(params: unknown, maxBytes: number): string | undefined {
  const bytes = outboundByteLength(params);
  if (bytes === undefined) {
    return "parameters cannot be serialised, so their size cannot be bounded";
  }

  if (bytes > maxBytes) {
    return `parameters serialise to ${bytes} bytes, the configured maximum is ${maxBytes}`;
  }

  return undefined;
}

export type IdleWatch = {
  /** A server interaction happened; the silence starts over. */
  activity(): void;
  /** Stop watching. Cancels the pending timer only; a firing that already started cannot be retracted. */
  dispose(): void;
};

/**
 * Tear down a connection nobody has used for `ttlMs`.
 *
 * Idle means no activity since the last successful `ensureStarted`,
 * `openDocument`, or `query` (failures never reset the silence — a refused
 * call is not proof the server is alive). Expiry goes through the port's own
 * `close`, never around it. The timer is unref'd so an idle server never
 * holds the event loop open on its own.
 *
 * `dispose` cancels a pending timer only. Once the callback has started,
 * `clearTimeout` is a no-op and `dispose` cannot retract the firing — so a
 * close that races the timeout must be idempotent, and `withQueryLimits`
 * below shares one guarded close between idle expiry and explicit `close`.
 * There is deliberately no unified event bus: each decorated port owns its
 * own watch, so dropping the port drops its timer with it.
 */
export function createIdleWatch(ttlMs: number, onIdle: () => void): IdleWatch {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const arm = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }

    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      timer = undefined;
      return;
    }

    timer = setTimeout(() => {
      timer = undefined;
      if (!disposed) {
        onIdle();
      }
    }, ttlMs);
    timer.unref?.();
  };

  arm();

  return {
    activity(): void {
      if (!disposed) {
        arm();
      }
    },
    dispose(): void {
      disposed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

const HEADER_END = Buffer.from("\r\n\r\n", "utf8");

/**
 * A stdout that refuses messages by declaration size.
 *
 * Bytes flow through untouched while each message's headers are scanned for
 * `Content-Length`. A declaration above `maxBytes` destroys the stream with a
 * limit error *before the body is allocated* — that ordering is the whole
 * point: a cap checked after the full message arrived bounds nothing.
 *
 * What this is not: a second parser. Bodies are never interpreted, split
 * headers are reassembled only to find the declaration, and anything without
 * parseable headers passes through for the library to judge.
 */
export function createBoundedStdout(source: Readable, maxBytes: number): Readable {
  const out = new PassThrough();
  let pending = Buffer.alloc(0);
  let bodyRemaining = 0;
  let failed = false;

  const violation = (declared: number): void => {
    if (failed) {
      return;
    }
    failed = true;
    out.destroy(limitError(`language server message declares ${declared} bytes, the configured maximum is ${maxBytes}`));
    source.destroy();
  };

  const consume = (chunk: Buffer): void => {
    if (failed) {
      return;
    }

    pending = Buffer.concat([pending, chunk]);

    for (;;) {
      if (bodyRemaining > 0) {
        const take = Math.min(bodyRemaining, pending.length);

        out.write(pending.subarray(0, take));
        pending = pending.subarray(take);
        bodyRemaining -= take;

        if (pending.length === 0) {
          return;
        }

        continue;
      }

      const end = pending.indexOf(HEADER_END);
      if (end < 0) {
        // No complete headers yet. If the header block itself already exceeds
        // the cap, no message behind it can be legal either.
        if (pending.length > maxBytes + HEADER_END.length) {
          violation(pending.length);
          return;
        }
        // Hold the bytes: forwarding a partial header would hand the library
        // a framing it cannot parse yet, and it buffers anyway.
        return;
      }

      const declared = parseDeclaredLength(pending.subarray(0, end));
      const total = end + HEADER_END.length;

      if (declared === undefined) {
        // Not our verdict to give: forward everything and let the library's
        // own header check fail on its own terms from here on.
        out.write(pending);
        pending = Buffer.alloc(0);
        return;
      }

      if (declared > maxBytes) {
        violation(declared);
        return;
      }

      out.write(pending.subarray(0, total));
      pending = pending.subarray(total);
      bodyRemaining = declared;

      if (pending.length === 0) {
        return;
      }
    }
  };

  source.on("data", (chunk: Buffer | string) => {
    consume(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  });
  source.on("error", (error: Error) => {
    if (!failed) {
      out.destroy(error);
    }
  });
  source.on("end", () => {
    if (pending.length > 0 && !failed) {
      // A trailing fragment with no headers is not ours to judge either.
      out.write(pending);
      pending = Buffer.alloc(0);
    }
    out.end();
  });

  return out;
}

function parseDeclaredLength(headerBlock: Buffer): number | undefined {
  const text = headerBlock.toString("utf8");
  const lines = text.split("\r\n");

  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator < 0) {
      continue;
    }

    if (line.slice(0, separator).trim().toLowerCase() !== "content-length") {
      continue;
    }

    const value = Number.parseInt(line.slice(separator + 1).trim(), 10);
    if (Number.isInteger(value) && value >= 0) {
      return value;
    }

    return undefined;
  }

  return undefined;
}

function limitRefusal(serverName: string, what: string, bytes: number | undefined, maxBytes: number): { readonly ok: false; readonly code: "lsp_limit_exceeded"; readonly message: string } {
  const size = bytes === undefined ? "an unmeasurable size" : `${bytes} bytes`;
  return { ok: false, code: "lsp_limit_exceeded", message: `${serverName} refused ${what}: ${size} against a maximum of ${maxBytes}` };
}

/**
 * The ceilings as seen by every consumer of a connection.
 *
 * Applied by the pool the moment a connection is created, so the tool layer
 * and any future caller share one enforcement rather than each re-checking.
 * Refusals happen before the delegate runs: an oversize document never
 * starts a server for a push that would be refused, and an idle expiry closes
 * through the port's own `close` rather than around it. Only a successful
 * `ensureStarted`/`openDocument`/`query` re-arms the idle watch; a failure
 * leaves the silence running.
 *
 * Close is idempotent per generation: idle expiry and explicit `close` share
 * one guarded delegate call, so a firing that already started plus an
 * explicit `close` — or two explicit closes — settle the same promise instead
 * of tearing down twice. A later successful start re-arms a new generation.
 */
export function withQueryLimits(port: LanguageServerPort, limits: LspLimits): LanguageServerPort {
  let idle: IdleWatch | undefined;
  let closeDone = false;
  let lastClose: Promise<void> | undefined;
  const guardedClose = async (): Promise<void> => {
    idle?.dispose();
    idle = undefined;

    if (closeDone) {
      await lastClose;
      return;
    }

    closeDone = true;
    lastClose = port.close();
    await lastClose;
  };
  const arm = (): void => {
    closeDone = false;
    lastClose = undefined;
    idle?.dispose();
    idle = createIdleWatch(limits.idleTtlMs, () => {
      void guardedClose();
    });
  };

  return {
    serverName: port.serverName,
    workspaceRoot: port.workspaceRoot,
    ensureStarted: async () => {
      const started = await port.ensureStarted();
      if (started.ok) {
        arm();
      }
      return started;
    },
    openDocument: async (document) => {
      const oversized = checkOutbound(document.text, limits.maxMessageBytes);
      if (oversized !== undefined) {
        return limitRefusal(port.serverName, `open of ${document.path}`, outboundByteLength(document.text), limits.maxMessageBytes);
      }

      const opened = await port.openDocument(document);
      if (opened.ok) {
        arm();
      }

      return opened;
    },
    query: async (query: LspQuery, signal: AbortSignal) => {
      const oversized = checkOutbound(query.path, limits.maxMessageBytes);
      if (oversized !== undefined) {
        return limitRefusal(port.serverName, "query path", outboundByteLength(query.path), limits.maxMessageBytes);
      }

      const result = await port.query(query, signal);
      if (result.ok) {
        arm();
        const kept = truncateAnswer(result.answer, limits.maxLocationsPerAnswer);
        return { ok: true, operation: result.operation, answer: kept.answer, truncated: kept.truncated };
      }

      return result;
    },
    isRunning: () => port.isRunning(),
    close: guardedClose,
  };
}
