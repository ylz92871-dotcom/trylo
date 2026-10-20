import type { JsonObject } from "../../../protocol/envelope.js";
import { createHash } from "node:crypto";
import type { FileAccessMode, ToolCallRequest, ToolOutcome } from "../../../ports/tools.js";
import type { ValidatedImageReferenceSink } from "../../../ports/image-reference-access.js";
import {
  checkImageBytes,
  checkImageDetail,
  describeImageForLog,
} from "../../media/image-guard.js";
import { readStringArg } from "./args.js";
import type { FileSystemReader } from "./limits.js";
import { resolveInsideWorkspace } from "./workspace.js";

export const VIEW_IMAGE_TOOL = "view_image";

export type ViewImageConfig = {
  readonly onImageValidated?: ValidatedImageReferenceSink;
  readonly workspaceRoot: string;
  readonly fileAccess?: FileAccessMode;
  readonly workspaceAlias?: string;
  readonly reader: FileSystemReader;
};

/**
 * Local image viewing as a read-only tool (WP19.1: C25, L10).
 *
 * Reuse: Codex `ViewImageHandler` (path resolution against the turn
 * environment, model-capability and detail gating, invalid-image rejection
 * before bytes travel further) and the legacy `FileReadTool` image branch
 * (MIME allowlist, size budget, dimension metadata). The Trylo shape differs
 * in one deliberate place: output/value carry metadata only. Byte-free images
 * references reach the request composition, which revalidates the file before
 * attaching it. Tool values also enter durable envelopes, so a data URL must
 * never be put there even when the transcript itself only stores a summary.
 */
export async function executeViewImage(
  config: ViewImageConfig,
  call: ToolCallRequest,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  const requested = readStringArg(call.arguments, "path");
  if (requested === undefined) {
    return { outcome: "error", code: "invalid_arguments", message: "view_image requires path" };
  }
  // Rejected before the file is touched: a bad `detail` must not cost a read,
  // the same rule `read_file` applies to a bad `offset`.
  const detail = checkImageDetail(readStringArg(call.arguments, "detail"));
  if (!detail.ok) {
    return { outcome: "error", code: "invalid_arguments", message: `view_image: ${detail.message}` };
  }
  if (signal.aborted) {
    return { outcome: "cancelled" };
  }
  const verdict = resolveInsideWorkspace(config.workspaceRoot, requested, config.fileAccess, config.workspaceAlias);
  if (!verdict.ok) {
    return { outcome: "error", code: verdict.code, message: verdict.code };
  }
  const readBytes = config.reader.readFileBytes;
  if (readBytes === undefined) {
    return {
      outcome: "error",
      code: "bytes_unavailable",
      message: "bytes_unavailable: this filesystem reader serves text only",
    };
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBytes(verdict.absolutePath, signal);
  } catch (error) {
    if (signal.aborted) {
      return { outcome: "cancelled" };
    }
    const detailMessage = error instanceof Error ? error.message : "read_error";
    return { outcome: "error", code: "read_failed", message: `read_failed:${detailMessage}` };
  }
  if (signal.aborted) {
    return { outcome: "cancelled" };
  }
  const validation = checkImageBytes({ bytes, path: requested });
  if (!validation.ok) {
    return { outcome: "error", code: validation.code, message: validation.message };
  }
  const attachment = { ...validation.attachment, detail: detail.detail };
  const summary = describeImageForLog(attachment);
  const value: JsonObject = {
    path: requested,
    mediaType: attachment.mediaType,
    bytes: attachment.bytes,
    detail: attachment.detail,
    ...(attachment.width === undefined ? {} : { width: attachment.width }),
    ...(attachment.height === undefined ? {} : { height: attachment.height }),
  };
  // Freeze alias-backed paths to their physical target so later rehydration
  // does not follow a retargeted workspace junction or reject its valid alias.
  const reference = { path: config.workspaceAlias === undefined ? requested : verdict.absolutePath,
    sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, detail: detail.detail };
  config.onImageValidated?.(reference, verdict.absolutePath);
  return {
    outcome: "result",
    value,
    output: `${summary} path=${JSON.stringify(requested)}`,
    truncated: false,
    images: [reference],
  };
}
