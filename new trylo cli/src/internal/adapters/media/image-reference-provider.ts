import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { ImageReference } from "../../protocol/image-reference.js";
import { isImageReferences } from "../../protocol/image-reference.js";
import type { ProviderImageAttachment } from "../../ports/media.js";
import { MAX_IMAGE_BYTES } from "../../ports/media.js";
import type { ProviderMessage, ProviderPort } from "../../ports/provider.js";
import { resolveInsideWorkspace } from "../tools/shared/workspace.js";
import { checkImageBytes } from "./image-guard.js";
import type { ImageReferenceAccess } from "../../ports/image-reference-access.js";

class ImageReferenceFailure extends Error {
  constructor(readonly code: string) { super(code); }
}

/** Rehydrate only the exact workspace bytes validated by view_image. Reading
 * through a bounded handle and real paths prevents a saved reference becoming
 * an arbitrary-file reader. Bytes never enter the journal or diagnostics.
 */
async function loadImage(root: string, reference: ImageReference, signal: AbortSignal, access?: ImageReferenceAccess): Promise<ProviderImageAttachment> {
  const approvedPath = access?.resolve(reference);
  const resolved = approvedPath === undefined ? resolveInsideWorkspace(root, reference.path) : { ok: true as const, absolutePath: approvedPath };
  if (!resolved.ok) throw new ImageReferenceFailure(access === undefined ? "image_reference_outside_workspace" : "image_reference_approval_required");
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(resolved.absolutePath)]);
  const within = relative(realRoot, realFile);
  if (approvedPath === undefined && (isAbsolute(within) || within === ".." || within.startsWith("../") || within.startsWith("..\\"))) {
    throw new ImageReferenceFailure("image_reference_outside_workspace");
  }
  const handle = await open(realFile, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== reference.bytes || stat.size > MAX_IMAGE_BYTES) throw new ImageReferenceFailure("image_reference_changed");
    signal.throwIfAborted();
    const bytes = Buffer.alloc(reference.bytes + 1);
    let read = 0;
    while (read < bytes.length) {
      signal.throwIfAborted();
      const step = await handle.read(bytes, read, bytes.length - read, read);
      if (step.bytesRead === 0) break;
      read += step.bytesRead;
    }
    const content = bytes.subarray(0, read);
    if (read !== reference.bytes || createHash("sha256").update(content).digest("hex") !== reference.sha256) {
      throw new ImageReferenceFailure("image_reference_changed");
    }
    const validated = checkImageBytes({ bytes: content, path: reference.path });
    if (!validated.ok) throw new ImageReferenceFailure("image_reference_invalid");
    return { ...validated.attachment, detail: reference.detail };
  } finally {
    await handle.close();
  }
}

type HydratedMessage = { readonly message: ProviderMessage; readonly missing: ReadonlyArray<string> };

function historicalFailure(error: unknown): string | undefined {
  if (error instanceof ImageReferenceFailure && (error.code === "image_reference_approval_required" || error.code === "image_reference_outside_workspace")) return "image_reference_approval_required";
  if (error instanceof ImageReferenceFailure && error.code === "image_reference_changed") return error.code;
  if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "EACCES")) return "image_reference_unavailable";
  return undefined;
}

async function hydrate(root: string, message: ProviderMessage, signal: AbortSignal, delivery: "current" | "historical", access?: ImageReferenceAccess): Promise<HydratedMessage> {
  if (message.imageReferences === undefined) return { message, missing: [] };
  if (!isImageReferences(message.imageReferences)) throw new ImageReferenceFailure("image_reference_invalid");
  const attachments = [...message.attachments ?? []];
  const missing = new Set<string>();
  for (const reference of message.imageReferences) {
    try { attachments.push(await loadImage(root, reference, signal, access)); }
    catch (error) {
      const code = historicalFailure(error);
      if (delivery === "current" || signal.aborted || code === undefined) throw error;
      missing.add(code);
    }
  }
  const { imageReferences: _references, ...plain } = message;
  const notice = missing.size === 0 ? "" : `\n[Historical image unavailable (${[...missing].join(", ")}). Use view_image to inspect the current file.]`;
  return { message: { ...plain, content: plain.content + notice, ...(attachments.length === 0 ? {} : { attachments }) }, missing: [...missing] };
}

/** Composition-only adapter: all wire families receive their existing image
 * attachment contract. Text-only requests and native continuation ownership
 * remain with the underlying provider.
 */
export function withImageReferences(provider: ProviderPort, workspaceRoot: string, access?: ImageReferenceAccess): ProviderPort {
  let notice: { readonly scope: string; readonly codes: Set<string> } | undefined;
  return {
    ...(provider.continuation === undefined ? {} : { continuation: provider.continuation }),
    async *stream(request, signal) {
      const scope = request.continuationScope ?? request.attemptId;
      if (notice?.scope !== scope) notice = { scope, codes: new Set() };
      const notices = notice.codes;
      let messages: ProviderMessage[];
      try {
        messages = [];
        let newest = request.messages.length - 1;
        while (request.messages[newest]?.role === "system") newest--;
        for (const [index, message] of request.messages.entries()) {
          const hydrated = await hydrate(workspaceRoot, message, signal, index === newest ? "current" : "historical", access);
          messages.push(hydrated.message);
          for (const code of hydrated.missing) if (!notices.has(code)) {
            notices.add(code);
            yield { type: "warning", code, message: "A historical image snapshot is unavailable; use view_image to inspect the current file." };
          }
        }
      } catch (error) {
        yield { type: "error", class: signal.aborted ? "cancelled" : "invalid_request", retryable: false,
          phase: "before_headers", message: error instanceof ImageReferenceFailure ? error.code : "image_reference_unavailable" };
        return;
      }
      yield* provider.stream({ ...request, messages }, signal);
    },
  };
}
