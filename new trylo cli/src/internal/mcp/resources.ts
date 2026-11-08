import type { JsonObject, JsonValue } from "../protocol/envelope.js";
import { readAnnotations } from "./annotations.js";
import { paramsAsObject, type JsonRpcResponse } from "./jsonrpc.js";
import type {
  McpResource,
  McpResourceContent,
  McpResourceFailure,
  McpResourceListResult,
  McpResourceReadResult,
  McpResourceTemplate,
  McpResourceTemplatesResult,
} from "../ports/mcp-client.js";

/**
 * MCP resource interpretation, shared by the stdio and remote clients.
 *
 * The reuse model is Codex's `core/src/tools/handlers/mcp_resource.rs`
 * (`ListMcpResourcesHandler`, `ListMcpResourceTemplatesHandler`,
 * `ReadMcpResourceHandler`): resources are listed per server (or across all
 * servers at the runtime layer) and read by verbatim URI. What is *not*
 * reused is the rmcp transport — the JSON-RPC shape here is interpreted
 * against the same NDJSON/POST wire the tool verbs already use, so the two
 * clients share these pure helpers instead of growing a second dialect.
 *
 * Everything here is pure: no process is touched, no clock is read, and no
 * state survives the call. A hostile reply (an error object, a resource
 * without a URI, content that is neither text nor blob) is a unit test that
 * needs neither a spawned child nor a socket.
 *
 * Two load-bearing refusals, mirroring the tool verbs:
 *
 *  - An entry without a usable URI is dropped, not repaired. A resource that
 *    cannot be addressed cannot become readable, and the rest of the server
 *    keeps working.
 *  - A URI is never resolved, expanded or checked against the workspace. It
 *    is the publishing server's authority — including `file://` — and reading
 *    it is approval-gated at the runtime layer, never implicitly trusted.
 */

const fail = (code: McpResourceFailure["code"], detail: string): McpResourceFailure => ({
  ok: false,
  code,
  detail,
});

function baseResourceFields(raw: JsonValue):
  | { readonly name: string; readonly title?: string; readonly description?: string; readonly mimeType?: string }
  | undefined {
  const record = paramsAsObject(raw);
  if (record === undefined) {
    return undefined;
  }

  const name = record["name"];
  if (typeof name !== "string" || name.length === 0) {
    return undefined;
  }

  const title = record["title"];
  const description = record["description"];
  const mimeType = record["mimeType"];

  return {
    name,
    ...(typeof title === "string" ? { title } : {}),
    ...(typeof description === "string" ? { description } : {}),
    ...(typeof mimeType === "string" ? { mimeType } : {}),
  };
}

/**
 * One published resource, or `undefined` when it cannot be addressed.
 *
 * Annotations travel as untrusted hints, exactly like tool annotations: the
 * server that published them is not a party Trylo trusts.
 */
export function toResource(raw: JsonValue): McpResource | undefined {
  const record = paramsAsObject(raw);
  if (record === undefined) {
    return undefined;
  }

  const uri = record["uri"];
  if (typeof uri !== "string" || uri.length === 0) {
    return undefined;
  }

  const base = baseResourceFields(raw);
  if (base === undefined) {
    return undefined;
  }

  return {
    uri,
    ...base,
    annotations: readAnnotations(record["annotations"]),
    annotationsTrust: "untrusted",
  };
}

/** One published template, or `undefined` when it cannot be addressed. */
export function toResourceTemplate(raw: JsonValue): McpResourceTemplate | undefined {
  const record = paramsAsObject(raw);
  if (record === undefined) {
    return undefined;
  }

  const uriTemplate = record["uriTemplate"];
  if (typeof uriTemplate !== "string" || uriTemplate.length === 0) {
    return undefined;
  }

  const base = baseResourceFields(raw);
  if (base === undefined) {
    return undefined;
  }

  return {
    uriTemplate,
    ...base,
    annotations: readAnnotations(record["annotations"]),
    annotationsTrust: "untrusted",
  };
}

function readCursor(result: JsonObject | undefined): { readonly nextCursor?: string } {
  const cursor = result?.["nextCursor"];
  return typeof cursor === "string" && cursor.length > 0 ? { nextCursor: cursor } : {};
}

export function interpretResourceList(
  response: JsonRpcResponse,
): { readonly ok: true; readonly value: McpResourceListResult } | McpResourceFailure {
  if ("error" in response) {
    return fail("protocol_error", `resources/list failed: ${response.error.code} ${response.error.message}`);
  }

  const result = paramsAsObject(response.result);
  const resources = result?.["resources"];
  if (!Array.isArray(resources)) {
    return fail("invalid_resource", "resources/list result has no resources array");
  }

  const listed: McpResource[] = [];

  for (const raw of resources) {
    const resource = toResource(raw);
    if (resource !== undefined) {
      listed.push(resource);
    }
  }

  return { ok: true, value: { resources: listed, ...readCursor(result) } };
}

export function interpretResourceTemplates(
  response: JsonRpcResponse,
): { readonly ok: true; readonly value: McpResourceTemplatesResult } | McpResourceFailure {
  if ("error" in response) {
    return fail(
      "protocol_error",
      `resources/templates/list failed: ${response.error.code} ${response.error.message}`,
    );
  }

  const result = paramsAsObject(response.result);
  const templates = result?.["resourceTemplates"];
  if (!Array.isArray(templates)) {
    return fail("invalid_resource", "resources/templates/list result has no resourceTemplates array");
  }

  const listed: McpResourceTemplate[] = [];

  for (const raw of templates) {
    const template = toResourceTemplate(raw);
    if (template !== undefined) {
      listed.push(template);
    }
  }

  return { ok: true, value: { templates: listed, ...readCursor(result) } };
}

/**
 * One content item, or `undefined` when it is neither text nor blob.
 *
 * Binary (`blob`, base64) content is never decoded here: the tool envelope
 * carries text, so a blob is reported by presence and size rather than
 * smuggled in as decoded bytes. The placeholder says what was omitted, so a
 * missing blob is never mistaken for an empty resource.
 */
export function toResourceContent(raw: JsonValue): McpResourceContent | undefined {
  const record = paramsAsObject(raw);
  if (record === undefined) {
    return undefined;
  }

  const uri = record["uri"];
  if (typeof uri !== "string" || uri.length === 0) {
    return undefined;
  }

  const mimeType = record["mimeType"];
  const mime = typeof mimeType === "string" ? { mimeType } : {};
  const text = record["text"];
  if (typeof text === "string") {
    return { kind: "text", uri, ...mime, text };
  }

  const blob = record["blob"];
  if (typeof blob === "string") {
    // Base64 expands 3 bytes to 4 characters; the estimate is noted as such.
    return { kind: "binary", uri, ...mime, byteLength: Math.floor((blob.length * 3) / 4) };
  }

  return undefined;
}

export function interpretResourceRead(
  response: JsonRpcResponse,
): { readonly ok: true; readonly value: McpResourceReadResult } | McpResourceFailure {
  if ("error" in response) {
    return fail("protocol_error", `resources/read failed: ${response.error.code} ${response.error.message}`);
  }

  const result = paramsAsObject(response.result);
  const contents = result?.["contents"];
  if (!Array.isArray(contents)) {
    return fail("invalid_resource", "resources/read result has no contents array");
  }

  const read: McpResourceContent[] = [];

  for (const raw of contents) {
    const content = toResourceContent(raw);
    if (content !== undefined) {
      read.push(content);
    }
  }

  return { ok: true, value: { contents: read } };
}

/**
 * Renders read content as model-visible text, bounded by the caller's limits.
 *
 * Text parts are joined in order; each binary part contributes a one-line
 * placeholder (never decoded bytes). When `maxBytes` cuts the text, the cut
 * is reported via `truncated` rather than hidden — a silent cut would read
 * as a complete resource.
 */
export function renderResourceContents(
  contents: ReadonlyArray<McpResourceContent>,
  maxBytes: number,
): { readonly output: string; readonly truncated: boolean } {
  const parts: string[] = [];

  for (const content of contents) {
    if (content.kind === "text") {
      parts.push(content.text);
    } else {
      const mime = content.mimeType === undefined ? "unknown type" : content.mimeType;
      parts.push(`[binary content omitted: ${mime}, about ${content.byteLength} bytes]`);
    }
  }

  const output = parts.join("\n");
  if (Buffer.byteLength(output, "utf8") <= maxBytes) {
    return { output, truncated: false };
  }

  return { output: truncateUtf8(output, maxBytes), truncated: true };
}

function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) {
    return text;
  }

  // Walk back from the cut so no multi-byte character is split.
  let end = maxBytes;

  while (end > 0 && isUtf8Continuation(bytes[end])) {
    end -= 1;
  }

  return bytes.subarray(0, end).toString("utf8");
}

function isUtf8Continuation(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x80 && byte < 0xc0;
}
