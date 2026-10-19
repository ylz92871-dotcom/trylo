import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { McpInlineImage, McpToolOutcome } from "../../ports/mcp-client.js";
import type { ImageReference } from "../../protocol/image-reference.js";
import { MAX_IMAGE_BYTES } from "../../protocol/media.js";
import { checkImageBytes } from "../media/image-guard.js";
import { resolveWriteTarget } from "../tools/shared/workspace.js";

/** No server-provided path is trusted. Only validated, bounded image bytes
 * enter this workspace-owned content cache, through the same path guard as
 * other writes. The existing provider adapter rechecks their digest on read. */
async function storeImage(root: string, image: McpInlineImage, signal: AbortSignal): Promise<ImageReference> {
  if (image.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || image.data.length % 4 !== 0) throw new Error("mcp_image_invalid: invalid image size");
  const bytes = Buffer.from(image.data, "base64");
  if (bytes.toString("base64") !== image.data) throw new Error("mcp_image_invalid: malformed base64");
  const checked = checkImageBytes({ bytes });
  if (!checked.ok || checked.attachment.mediaType !== image.mimeType) throw new Error("mcp_image_invalid: image bytes or MIME type are invalid");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const extension = image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.slice("image/".length);
  const path = `.trylo/tmp/mcp-images/${sha256}.${extension}`;
  const target = resolveWriteTarget(root, path);
  if (!target.ok) throw new Error(`mcp_image_cache_unavailable:${target.code}`);
  signal.throwIfAborted();
  await mkdir(dirname(target.absolutePath), { recursive: true });
  // Revalidate after directory creation; a redirected cache is never usable.
  const verified = resolveWriteTarget(root, path);
  if (!verified.ok) throw new Error(`mcp_image_cache_unavailable:${verified.code}`);
  try { await writeFile(verified.absolutePath, bytes, { flag: "wx", signal }); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || (error.code !== "EEXIST" && error.code !== "EACCES")) throw error;
    // Existing immutable entries may report EACCES rather than EEXIST on Windows.
    const stat = await lstat(verified.absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== bytes.length
      || createHash("sha256").update(await readFile(verified.absolutePath)).digest("hex") !== sha256) throw new Error("mcp_image_cache_invalid: cached image was changed or redirected");
  }
  return { path, sha256, bytes: bytes.length, detail: "high" };
}

type DeliveredMcpOutcome = McpToolOutcome & { readonly images?: ReadonlyArray<ImageReference> };

export async function deliverMcpImages(outcome: McpToolOutcome, root: string | undefined, signal: AbortSignal): Promise<DeliveredMcpOutcome> {
  if (outcome.outcome !== "result") return outcome;
  const { inlineImages, ...plain } = outcome;
  if (inlineImages === undefined || inlineImages.length === 0) return plain;
  if (root === undefined) return { outcome: "error", code: "mcp_image_delivery_unavailable", message: "MCP images require a workspace image cache; no image was delivered. Do not retry Screenshot with unsupported filePath arguments." };
  try {
    const images: ImageReference[] = [];
    for (const image of inlineImages) images.push(await storeImage(root, image, signal));
    return { ...plain, images, output: `${plain.output}\n[${images.length} image(s) attached for visual inspection. Use the attached images directly; no shell copy or additional screenshot is needed.]` };
  } catch (error) {
    if (signal.aborted) return { outcome: "cancelled" };
    return { outcome: "error", code: "mcp_image_delivery_failed", message: error instanceof Error ? error.message : "MCP image delivery failed" };
  }
}
