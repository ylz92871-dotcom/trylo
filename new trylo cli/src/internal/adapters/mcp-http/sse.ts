/**
 * Incremental Server-Sent Events parsing, for the two remote MCP transports.
 *
 * Streamable HTTP may answer a POST with an `text/event-stream` body, and the
 * legacy `sse` transport is one long-lived event stream, so both need the same
 * reader. The parser is a pure state machine — text in, events out, state
 * carried over — exactly like `scanFrames` in `mcp/jsonrpc.ts`, for the same
 * reason: every hostile shape (a split event, a comment, a multi-line data
 * field, a missing event name) is a unit test that needs no socket.
 *
 * The carried state matters: an event whose terminator lands in a later chunk
 * must survive the call boundary, or a perfectly legal stream is silently
 * truncated at a TCP segment line. That is what {@link SseOpenState} is for —
 * callers thread it back in on the next call.
 *
 * Only what the MCP wire uses is honored: `event`, `data` and comments.
 * `id`/`retry` and unknown fields are accepted and ignored — this client does
 * not reconnect, so a last-event id has nothing to resume from.
 */

export type SseEvent = {
  /** The `event:` field, empty when the stream used the default (`message`). */
  readonly event: string;
  /** The `data:` payload, multi-line data joined with `\n`. */
  readonly data: string;
};

/** An event that has been opened but not yet terminated by a blank line. */
export type SseOpenState = {
  readonly event: string | undefined;
  readonly dataLines: ReadonlyArray<string>;
};

export const freshSseOpen: SseOpenState = { event: undefined, dataLines: [] };

export type SseScanResult = {
  readonly events: ReadonlyArray<SseEvent>;
  /** Text carried over: at most one partial line. */
  readonly rest: string;
  /** The possibly-still-open event, to be passed back in on the next call. */
  readonly open: SseOpenState;
};

export function scanSse(buffer: string, open: SseOpenState = freshSseOpen): SseScanResult {
  const events: SseEvent[] = [];
  let rest = buffer;
  let current = open;

  for (;;) {
    const newline = rest.indexOf("\n");
    if (newline === -1) {
      break;
    }

    let line = rest.slice(0, newline);

    rest = rest.slice(newline + 1);

    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }

    if (line.length === 0) {
      const dispatched = dispatch(current);
      if (dispatched !== undefined) {
        events.push(dispatched);
      }
      current = freshSseOpen;
      continue;
    }

    if (line.startsWith(":")) {
      // A comment (often a keep-alive). Produces nothing.
      continue;
    }

    current = addField(current, line);
  }

  return { events, rest, open: current };
}

/**
 * A blank line dispatches the open event — but only if it carries data. An
 * event with a name and no payload cannot become a JSON-RPC message anyway,
 * and dispatching it would invent an empty frame the decoder then has to
 * reject.
 */
function dispatch(open: SseOpenState): SseEvent | undefined {
  if (open.dataLines.length === 0) {
    return undefined;
  }
  return { event: open.event ?? "message", data: open.dataLines.join("\n") };
}

function addField(open: SseOpenState, line: string): SseOpenState {
  const colon = line.indexOf(":");
  const field = colon === -1 ? line : line.slice(0, colon);
  // One optional space after the colon is stripped per the SSE specification.
  let value = colon === -1 ? "" : line.slice(colon + 1);
  if (value.startsWith(" ")) {
    value = value.slice(1);
  }

  if (field === "event") {
    return { event: value, dataLines: open.dataLines };
  }

  if (field === "data") {
    return { event: open.event, dataLines: [...open.dataLines, value] };
  }

  return open;
}
