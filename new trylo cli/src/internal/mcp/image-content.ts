import type { JsonValue } from "../protocol/envelope.js";
import type { McpInlineImage, McpToolOutcome } from "../ports/mcp-client.js";
import { MAX_IMAGE_BYTES } from "../protocol/media.js";

/** Preserve image blocks separately from text; bound allocation before decode. */
export function extractMcpImages(content: JsonValue | undefined): ReadonlyArray<McpInlineImage> {
  if (!Array.isArray(content)) return [];
  const images: McpInlineImage[] = [];
  let encodedBytes = 0;
  for (const item of content) {
    if (typeof item !== "object" || item === null || Array.isArray(item) || item["type"] !== "image") continue;
    const mimeType = item["mimeType"];
    const data = item["data"];
    if (typeof mimeType !== "string" || typeof data !== "string") throw new Error("mcp_image_invalid: missing image MIME type or bytes");
    encodedBytes += data.length;
    if (images.length >= 16 || encodedBytes > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error("mcp_image_invalid: image payload exceeds the delivery limit");
    images.push({ mimeType, data });
  }
  return images;
}

export function attachMcpImages(result: Extract<McpToolOutcome, { outcome: "result" }>, content: JsonValue | undefined): McpToolOutcome {
  try {
    const inlineImages = extractMcpImages(content);
    return { ...result, ...(inlineImages.length === 0 ? {} : { inlineImages }) };
  } catch (error) {
    return { outcome: "error", code: "mcp_image_invalid", message: error instanceof Error ? error.message : "invalid MCP image" };
  }
}
