// Trylo Desktop — structured tool-result content vocabulary (PR-4, spec §7).
//
// MCP tool results may carry text, image, audio, embedded resource,
// resource_link and structured content side by side (§7). This module owns:
//
//   1. the persisted vocabulary (`ToolResultContent`) — binary payloads are
//      ALWAYS referenced through a `BinaryRef` (id/path/size/sha256), never
//      inline base64 (§7.1: base64 must not enter the session JSON);
//   2. the TRANSIENT vocabulary (`RawToolResultContent`) — what the stream
//      translator emits while raw base64 is still in memory, before the
//      BinaryRef store writes it to the ephemeral tool cache;
//   3. parsing of the block shapes the CLI actually emits in stream-json
//      (verified against `trylo cli/src/services/mcp/client.ts`
//      `transformResultContent` + PR-0 static evidence), defensively
//      accepting BOTH the Anthropic wire shape (`image.source.base64`) and
//      the flat MCP shape (`image.data`);
//   4. the persisted-shape guard (`toPersistedToolResultContent`) — the
//      last line of defence that strips any raw/base64-carrying block
//      before it can reach a `ToolMessage` and the conversation history.

/** §7: reference to binary bytes stored OUTSIDE the session JSON. The
 *  metadata (including the absolute cache path) is what gets persisted;
 *  the bytes live in the ephemeral tool cache with a 24 h TTL. */
export interface BinaryRef {
  readonly id: string;
  readonly storage: 'ephemeral-tool-cache' | 'workspace-artifact';
  readonly path: string;
  readonly mimeType: string;
  readonly size: number;
  readonly sha256: string;
}

/** Persisted, resolved content. Any binary payload is a `BinaryRef`. */
export type ToolResultContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly ref: BinaryRef; readonly alt?: string }
  | { readonly type: 'audio'; readonly ref: BinaryRef }
  | { readonly type: 'resource'; readonly uri: string; readonly mimeType?: string; readonly text?: string; readonly ref?: BinaryRef }
  | { readonly type: 'resource_link'; readonly uri: string; readonly name: string; readonly mimeType?: string }
  | { readonly type: 'structured'; readonly value: unknown; readonly schema?: string };

/** Transient content: raw base64 still in memory, pre-store. Emitted by
 *  the stream translator, materialized into `ToolResultContent` by the
 *  BinaryRef store pump in trylo-runner BEFORE any UI/persistence sees it. */
export type RawToolResultContent =
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string; readonly alt?: string }
  | { readonly type: 'audio'; readonly data: string; readonly mimeType: string }
  | { readonly type: 'resource'; readonly uri: string; readonly mimeType?: string; readonly blob: string };

export type AnyToolResultContent = ToolResultContent | RawToolResultContent;

/** §7.1 图片缩略图安全: MIME 白名单 + 大小上限。 */
export const RENDERABLE_IMAGE_MIME = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const);

export const RENDERABLE_AUDIO_MIME = Object.freeze([
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/webm',
] as const);

/** A single binary payload may not exceed this (screenshots are far below;
 *  anything above is dropped with a notice rather than cached). */
export const MAX_BINARY_BYTES = 20 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function looksLikeBase64(value: string): boolean {
  return value.length >= 512 && /^[A-Za-z0-9+/=\r\n]+$/.test(value.slice(0, 4096));
}

/** The Anthropic wire shape: `{type:'image', source:{type:'base64',
 *  media_type, data}}` (what the CLI emits for MCP images, see
 *  `trylo cli/src/services/mcp/client.ts transformResultContent`). */
function parseAnthropicImage(block: Record<string, unknown>): RawToolResultContent | null {
  const source = isRecord(block['source']) ? block['source'] : null;
  if (!source || source['type'] !== 'base64') return null;
  const data = source['data'];
  const mediaType = source['media_type'];
  if (typeof data !== 'string' || data === '') return null;
  return {
    type: 'image',
    data,
    mimeType: typeof mediaType === 'string' && mediaType !== '' ? mediaType : 'image/png',
  };
}

/** The flat MCP shape: `{type:'image', data, mimeType}`. Accepted
 *  defensively — the pinned CLI converts to the Anthropic shape today, but
 *  the MCP shape is what servers return and what future CLI paths may pass
 *  through verbatim (PR-0 contract 4: the real fixture is still pending). */
function parseFlatImage(block: Record<string, unknown>): RawToolResultContent | null {
  const data = block['data'];
  if (typeof data !== 'string' || data === '') return null;
  const mimeType = block['mimeType'] ?? block['mime_type'];
  return {
    type: 'image',
    data,
    mimeType: typeof mimeType === 'string' && mimeType !== '' ? mimeType : 'image/png',
  };
}

function parseFlatAudio(block: Record<string, unknown>): RawToolResultContent | null {
  const data = block['data'];
  if (typeof data !== 'string' || data === '') return null;
  const mimeType = block['mimeType'] ?? block['mime_type'];
  return {
    type: 'audio',
    data,
    mimeType: typeof mimeType === 'string' && mimeType !== '' ? mimeType : 'audio/mpeg',
  };
}

/** MCP embedded resource. `resource.text` stays text (no binary);
 *  `resource.blob` is raw base64 → transient resource block. Both the
 *  nested MCP shape (`{type:'resource', resource:{…}}`) and a flat shape
 *  (`{type:'resource', uri, …}`) are accepted. */
function parseResourceBlock(block: Record<string, unknown>): AnyToolResultContent | null {
  const nested = isRecord(block['resource']) ? block['resource'] : null;
  const uri = String((nested ?? block)['uri'] ?? '');
  if (uri === '') return null;
  const mimeTypeRaw = (nested ?? block)['mimeType'] ?? (nested ?? block)['mime_type'];
  const mimeType = typeof mimeTypeRaw === 'string' && mimeTypeRaw !== '' ? mimeTypeRaw : undefined;
  const text = (nested ?? block)['text'];
  const blob = (nested ?? block)['blob'];
  if (typeof blob === 'string' && blob !== '') {
    return { type: 'resource', uri, mimeType, blob };
  }
  if (typeof text === 'string') {
    return { type: 'resource', uri, mimeType, text };
  }
  // URI-only resource: metadata is still worth surfacing.
  return { type: 'resource', uri, mimeType };
}

/** Parse ONE block from a tool_result `content` array (or the
 *  `message.mcpMeta.structuredContent` ride-along) into the content
 *  vocabulary. Returns null for anything that carries no recoverable
 *  content (the text summary still describes it). */
export function parseToolResultBlock(block: unknown): AnyToolResultContent | null {
  if (!isRecord(block)) return null;
  switch (block['type']) {
    case 'text': {
      const text = block['text'];
      return typeof text === 'string' ? { type: 'text', text } : null;
    }
    case 'image':
      return parseAnthropicImage(block) ?? parseFlatImage(block);
    case 'audio':
      return parseFlatAudio(block);
    case 'resource':
      return parseResourceBlock(block);
    case 'resource_link': {
      const uri = block['uri'];
      if (typeof uri !== 'string' || uri === '') return null;
      const name = block['name'];
      const mimeType = block['mimeType'] ?? block['mime_type'];
      return {
        type: 'resource_link',
        uri,
        name: typeof name === 'string' && name !== '' ? name : uri,
        ...(typeof mimeType === 'string' && mimeType !== '' ? { mimeType } : {}),
      };
    }
    case 'structured': {
      // Already-normalized structured block (e.g. replayed event).
      return isRecord(block) && 'value' in block
        ? { type: 'structured', value: block['value'], ...(typeof block['schema'] === 'string' ? { schema: block['schema'] } : {}) }
        : null;
    }
    default:
      return null;
  }
}

/** Build the `structured` content from the CLI's `mcpMeta` ride-along
 *  (`{structuredContent?, _meta?}`, see client.ts:1899-1905). */
export function parseMcpMetaStructured(mcpMeta: unknown): AnyToolResultContent | null {
  if (!isRecord(mcpMeta)) return null;
  const structured = mcpMeta['structuredContent'];
  if (structured === undefined || structured === null) return null;
  return { type: 'structured', value: structured };
}

/** Text summary for a tool_result: joins text blocks; binary blocks
 *  contribute a bracketed note so the summary never contains base64. */
export function summarizeToolResultContent(content: readonly AnyToolResultContent[]): string {
  const parts: string[] = [];
  for (const block of content) {
    switch (block.type) {
      case 'text':
        if (block.text !== '') parts.push(block.text);
        break;
      case 'image':
        parts.push('[image]');
        break;
      case 'audio':
        parts.push('[audio]');
        break;
      case 'resource':
        parts.push('text' in block && typeof block.text === 'string' ? block.text : `[resource ${block.uri}]`);
        break;
      case 'resource_link':
        parts.push(`[resource link: ${block.name}] ${block.uri}`);
        break;
      case 'structured':
        parts.push('[structured result]');
        break;
    }
  }
  return parts.join('\n');
}

/** Guard against the §15.2 circuit breaker 「截图/base64 进入持久会话」:
 *  a `ToolMessage.outputContent` must only ever contain resolved blocks.
 *  Any raw/base64-carrying block is replaced by a text notice; strings
 *  that look like base64 payloads inside text blocks are truncated. Used
 *  by the reducer (belt) and the history normalizer (braces). */
export function toPersistedToolResultContent(
  content: readonly AnyToolResultContent[] | undefined,
): readonly ToolResultContent[] | undefined {
  if (!content || content.length === 0) return undefined;
  const out: ToolResultContent[] = [];
  for (const block of content) {
    switch (block.type) {
      case 'text': {
        const text = looksLikeBase64(block.text)
          ? '[binary content removed from the session record]'
          : block.text;
        out.push({ type: 'text', text });
        break;
      }
      case 'image':
      case 'audio':
        if ('ref' in block) {
          out.push(block);
        } else {
          out.push({ type: 'text', text: `[${block.type} not cached — dropped]` });
        }
        break;
      case 'resource':
        if ('blob' in block && block.blob !== undefined) {
          out.push({ type: 'resource', uri: block.uri, mimeType: block.mimeType, text: '[binary resource content removed from the session record]' });
        } else if ('ref' in block || 'text' in block) {
          out.push({ type: 'resource', uri: block.uri, ...(block.mimeType !== undefined ? { mimeType: block.mimeType } : {}), ...('text' in block && block.text !== undefined ? { text: block.text } : {}), ...('ref' in block ? { ref: (block as { ref?: BinaryRef }).ref! } : {}) });
        } else {
          out.push({ type: 'resource', uri: block.uri, ...(block.mimeType !== undefined ? { mimeType: block.mimeType } : {}) });
        }
        break;
      case 'resource_link':
        out.push(block);
        break;
      case 'structured':
        out.push(block);
        break;
    }
  }
  return out.length > 0 ? out : undefined;
}

/** Normalize an unknown persisted `outputContent` value (history load):
 *  whitelist rebuild block by block; anything that does not validate —
 *  including any blob/base64 field a tampered or hand-edited file may
 *  carry — is dropped. */
export function normalizePersistedToolResultContent(value: unknown): readonly ToolResultContent[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ToolResultContent[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    switch (item['type']) {
      case 'text': {
        const text = item['text'];
        if (typeof text !== 'string') break;
        out.push({ type: 'text', text: looksLikeBase64(text) ? '[binary content removed from the session record]' : text });
        break;
      }
      case 'image':
      case 'audio': {
        const ref = normalizeBinaryRef(item['ref']);
        if (!ref) break;
        if (item['type'] === 'image') {
          const alt = item['alt'];
          out.push({ type: 'image', ref, ...(typeof alt === 'string' ? { alt } : {}) });
        } else {
          out.push({ type: 'audio', ref });
        }
        break;
      }
      case 'resource': {
        const uri = item['uri'];
        if (typeof uri !== 'string' || uri === '') break;
        const blobbed = 'blob' in item;
        if (blobbed) break; // blobs never persist
        const mimeType = typeof item['mimeType'] === 'string' ? item['mimeType'] : undefined;
        const text = typeof item['text'] === 'string' ? item['text'] : undefined;
        const ref = normalizeBinaryRef(item['ref']);
        // PR-4 audit fix: a URI-only resource (no embedded text, no cached
        // bytes) is valid persisted metadata — the card renders uri / MIME
        // and states that the bytes were not cached. Dropping it here made
        // the record asymmetric with `toPersistedToolResultContent` and
        // broke the §13 PR-4 acceptance 「刷新后 metadata 可复原」: the chip
        // disappeared after a reload.
        out.push({
          type: 'resource',
          uri,
          ...(mimeType !== undefined ? { mimeType } : {}),
          ...(text !== undefined ? { text } : {}),
          ...(ref ? { ref } : {}),
        });
        break;
      }
      case 'resource_link': {
        const uri = item['uri'];
        const name = item['name'];
        if (typeof uri !== 'string' || uri === '' || typeof name !== 'string') break;
        const mimeType = typeof item['mimeType'] === 'string' ? item['mimeType'] : undefined;
        out.push({ type: 'resource_link', uri, name, ...(mimeType !== undefined ? { mimeType } : {}) });
        break;
      }
      case 'structured': {
        if (!('value' in item)) break;
        out.push({
          type: 'structured',
          value: item['value'],
          ...(typeof item['schema'] === 'string' ? { schema: item['schema'] } : {}),
        });
        break;
      }
      default:
        break;
    }
  }
  return out.length > 0 ? out : undefined;
}

/** Whitelist rebuild of a persisted BinaryRef. The path must be absolute
 *  and must not contain traversal segments (the store re-validates
 *  containment at READ time against its own root — a history file can be
 *  hand-edited, so the persisted metadata is never trusted blindly). */
export function normalizeBinaryRef(value: unknown): BinaryRef | undefined {
  if (!isRecord(value)) return undefined;
  const id = value['id'];
  const path = value['path'];
  const mimeType = value['mimeType'];
  const size = value['size'];
  const sha256 = value['sha256'];
  if (typeof id !== 'string' || id === '') return undefined;
  if (typeof path !== 'string' || !/^[A-Za-z]:[\\/]/.test(path) && !path.startsWith('/')) return undefined;
  if (path.includes('..')) return undefined;
  if (typeof mimeType !== 'string' || mimeType === '') return undefined;
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return undefined;
  if (typeof sha256 !== 'string' || sha256.length !== 64) return undefined;
  if (value['storage'] !== 'ephemeral-tool-cache' && value['storage'] !== 'workspace-artifact') return undefined;
  return {
    id,
    storage: value['storage'],
    path,
    mimeType,
    size: Math.floor(size),
    sha256,
  };
}
