import {
  extensionMime,
  isImageDetail,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  type ImageDetail,
  type ImageMime,
  type ImageValidation,
} from "../../ports/media.js";

/**
 * Image boundary guard (WP19.1: C25, L10; structure hardened in WP19 复核 F1).
 *
 * Pure mechanical layer: magic-byte detection ported from Codex
 * `utils/image` (`image::guess_format` allowlist — png/jpeg/gif/webp pass
 * through, everything else is not an image) and the legacy
 * `detectImageFormatFromBuffer` branch in `FileReadTool`. No filesystem, no
 * clock, no process surface: bytes in, verdict out.
 *
 * WP19 复核订正 (F1): magic alone accepts garbage with a PNG header and then
 * reports its bytes as dimensions (the reviewer proved
 * `width=height=1094795585`). There is no decoder in this package, so each
 * format gets the weakest structural proof a pure function can give — chunk
 * tags, CRC, trailers, and the dimension ceiling — instead of pretending an
 * upstream decoder will catch what never reaches one.
 */

function startsWith(bytes: Uint8Array, prefix: ReadonlyArray<number>): boolean {
  if (bytes.length < prefix.length) {
    return false;
  }
  return prefix.every((byte, index) => bytes[index] === byte);
}

/**
 * MIME by magic bytes, not by filename. An extension that disagrees with the
 * bytes loses: renaming `notes.txt` to `notes.png` must not make it an image.
 */
export function detectImageMime(bytes: Uint8Array): ImageMime | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }

  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) {
    return "image/gif";
  }

  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  return undefined;
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] as number) * 0x1000000 +
    ((bytes[offset + 1] as number) << 16) +
    ((bytes[offset + 2] as number) << 8) +
    (bytes[offset + 3] as number)
  );
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] as number) +
    ((bytes[offset + 1] as number) << 8) +
    ((bytes[offset + 2] as number) << 16) +
    (bytes[offset + 3] as number) * 0x1000000
  );
}

/** IEEE CRC-32 over a slice: the PNG chunk integrity check, zero-dep. */
export function crc32IEEE(bytes: Uint8Array, start: number, end: number): number {
  let table: Uint32Array | undefined;
  const tableOf = (): Uint32Array => {
    if (table !== undefined) {
      return table;
    }

    const built = new Uint32Array(256);

    for (let value = 0; value < 256; value += 1) {
      let entry = value;

      for (let bit = 0; bit < 8; bit += 1) {
        // Bitwise oddness: `% 2 === 1` lies for the negative int32
        // intermediates XOR can produce (`-3 % 2 === -1`), silently
        // corrupting half the table (WP19 复核 F1 fix round).
        entry = (entry & 1) === 1 ? 0xedb88320 ^ (entry >>> 1) : entry >>> 1;
      }

      built[value] = entry;
    }

    table = built;

    return built;
  };
  let crc = 0xffffffff;

  for (let index = start; index < end; index += 1) {
    crc = tableOf()[(crc ^ (bytes[index] as number)) & 0xff] as number ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

export type PngInspection =
  | { readonly ok: true; readonly width: number; readonly height: number }
  | { readonly ok: false; readonly code: "invalid_image" | "too_large"; readonly message: string };

/**
 * PNG structure without a decoder: signature already proven by the caller,
 * then IHDR tag + IHDR CRC + IDAT presence + IEND trailer + the dimension
 * ceiling. Any one missing means the file is corrupt or truncated — not an
 * image this package may hand to a model as one.
 */
export function inspectPng(bytes: Uint8Array): PngInspection {
  // Signature (8) + IHDR chunk (25) + IEND chunk (12): shorter cannot be whole.
  if (bytes.length < 45) {
    return { ok: false, code: "invalid_image", message: "invalid_image: truncated PNG: shorter than signature + IHDR + IEND" };
  }

  const header = readIhdrDimensions(bytes);
  if (!header.ok) {
    return header;
  }

  const body = requireImageDataChunks(bytes);
  if (!body.ok) {
    return body;
  }

  const trailer = requireIendTrailer(bytes);
  if (!trailer.ok) {
    return trailer;
  }

  if (header.width > MAX_IMAGE_DIMENSION || header.height > MAX_IMAGE_DIMENSION) {
    return {
      ok: false,
      code: "too_large",
      message: `too_large: PNG is ${header.width}x${header.height}, over the ${MAX_IMAGE_DIMENSION}px edge this package can send without a resizer`,
    };
  }

  return { ok: true, width: header.width, height: header.height };
}

type PngRefusal = { readonly ok: false; readonly code: "invalid_image" | "too_large"; readonly message: string };

/** First chunk must be IHDR, with sane dimensions and an intact CRC. */
function readIhdrDimensions(bytes: Uint8Array): PngInspection | PngRefusal {
  if (
    bytes[12] !== 0x49 ||
    bytes[13] !== 0x48 ||
    bytes[14] !== 0x44 ||
    bytes[15] !== 0x52
  ) {
    return { ok: false, code: "invalid_image", message: "invalid_image: PNG first chunk is not IHDR" };
  }

  const width = readU32BE(bytes, 16);
  const height = readU32BE(bytes, 20);
  if (width === 0 || height === 0) {
    return { ok: false, code: "invalid_image", message: "invalid_image: PNG has a zero dimension" };
  }

  // CRC covers the IHDR tag + data (bytes 12..29), never the length field;
  // stored at 29..33.
  if (crc32IEEE(bytes, 12, 29) !== readU32BE(bytes, 29)) {
    return { ok: false, code: "invalid_image", message: "invalid_image: PNG IHDR CRC mismatch (corrupt header)" };
  }

  return { ok: true, width, height };
}

/**
 * At least one IDAT chunk must sit between IHDR and IEND: a header with no
 * image data is not a viewable image. Walked, not assumed.
 */
function requireImageDataChunks(bytes: Uint8Array): PngInspection | PngRefusal {
  let offset = 33;
  let sawImageData = false;

  while (offset + 8 <= bytes.length) {
    const length = readU32BE(bytes, offset);
    const tag =
      ((bytes[offset + 4] as number) << 24) +
      ((bytes[offset + 5] as number) << 16) +
      ((bytes[offset + 6] as number) << 8) +
      (bytes[offset + 7] as number);
    if (tag === 0x49454e44) {
      break;
    }

    if (offset + 12 + length > bytes.length) {
      return { ok: false, code: "invalid_image", message: "invalid_image: truncated PNG: chunk overruns the file" };
    }

    // No early return: chunks past the first IDAT are still walked, so a
    // lying length later in the file cannot hide behind valid image data.
    sawImageData = sawImageData || tag === 0x49444154;
    offset += 12 + length;
  }

  return sawImageData
    ? { ok: true, width: 0, height: 0 }
    : { ok: false, code: "invalid_image", message: "invalid_image: PNG has no IDAT image data" };
}

/** IEND chunk: length 0 + tag + fixed CRC. Absent means truncation. */
function requireIendTrailer(bytes: Uint8Array): PngInspection | PngRefusal {
  const tail = bytes.length - 12;
  if (
    readU32BE(bytes, tail) !== 0 ||
    bytes[tail + 4] !== 0x49 ||
    bytes[tail + 5] !== 0x45 ||
    bytes[tail + 6] !== 0x4e ||
    bytes[tail + 7] !== 0x44 ||
    readU32BE(bytes, tail + 8) !== 0xae426082
  ) {
    return { ok: false, code: "invalid_image", message: "invalid_image: truncated PNG: missing IEND trailer" };
  }

  return { ok: true, width: 0, height: 0 };
}

export type StructureVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "invalid_image" | "too_large"; readonly message: string };

/**
 * Per-format structural proof. Magic says what the file claims to be; this
 * says whether the claim holds together. Anything unproven is `invalid_image`
 * (corrupt or truncated) except an over-edge PNG, which is honestly `too_large`.
 */
function checkImageStructure(mime: ImageMime, bytes: Uint8Array): StructureVerdict {
  switch (mime) {
    case "image/png": {
      const inspection = inspectPng(bytes);
      return inspection.ok
        ? { ok: true }
        : { ok: false, code: inspection.code, message: inspection.message };
    }
    case "image/jpeg":
      return bytes.length >= 4 &&
        bytes[bytes.length - 2] === 0xff &&
        bytes[bytes.length - 1] === 0xd9
        ? { ok: true }
        : { ok: false, code: "invalid_image", message: "invalid_image: truncated JPEG: missing EOI trailer" };
    case "image/gif":
      // Full version GIF87a/GIF89a plus the 0x3B trailer.
      return bytes.length >= 7 &&
        bytes[3] === 0x38 &&
        (bytes[4] === 0x37 || bytes[4] === 0x39) &&
        bytes[bytes.length - 1] === 0x3b
        ? { ok: true }
        : { ok: false, code: "invalid_image", message: "invalid_image: corrupt GIF: bad version or missing trailer" };
    case "image/webp":
      return bytes.length >= 12 && readU32LE(bytes, 4) === bytes.length - 8
        ? { ok: true }
        : { ok: false, code: "invalid_image", message: "invalid_image: corrupt WebP: RIFF size disagrees with the file" };
  }
}

/**
 * PNG IHDR dimensions without a decoder. Undefined for non-PNG input,
 * truncated headers, and corrupt chunks — "dimensions unknown" is reported
 * only for files that failed structural proof, never guessed from raw bytes.
 */
export function parsePngDimensions(bytes: Uint8Array): { readonly width: number; readonly height: number } | undefined {
  if (detectImageMime(bytes) !== "image/png") {
    return undefined;
  }
  const inspection = inspectPng(bytes);
  return inspection.ok ? { width: inspection.width, height: inspection.height } : undefined;
}

/** Same wrapping Codex `data_url_from_bytes` performs, MIME already guarded. */
export function encodeDataUrl(mime: ImageMime, bytes: Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** Redacted one-line summary for logs and tool output: never the payload. */
export function describeImageForLog(input: {
  readonly mediaType: ImageMime;
  readonly bytes: number;
  readonly detail: ImageDetail;
  readonly width?: number;
  readonly height?: number;
}): string {
  const size = `${input.width ?? "?"}x${input.height ?? "?"}`;
  return `<image ${input.mediaType} ${input.bytes} bytes detail=${input.detail} ${size}>`;
}

export type ImageBytesInput = {
  readonly bytes: Uint8Array;
  /** Hint only; magic wins when the two disagree. */
  readonly path?: string;
  readonly maxBytes?: number;
};

/**
 * Validate raw bytes as an image input. Order matters: empty before magic
 * (an empty file has no magic to read), size before decode (a huge file must
 * not be decoded just to be refused), structure before acceptance (magic
 * without a body is a claim, not an image).
 */
export function checkImageBytes(input: ImageBytesInput): ImageValidation {
  const ceiling = input.maxBytes ?? MAX_IMAGE_BYTES;

  if (input.bytes.length === 0) {
    return { ok: false, code: "empty_file", message: "empty_file: image file is empty" };
  }

  if (input.bytes.length > ceiling) {
    return {
      ok: false,
      code: "too_large",
      message: `too_large: ${input.bytes.length} bytes exceeds ${ceiling} byte image ceiling`,
    };
  }

  const magic = detectImageMime(input.bytes);
  if (magic === undefined) {
    return { ok: false, code: "invalid_image", message: "invalid_image: unable to process image: invalid or unsupported image data" };
  }

  if (input.path !== undefined) {
    const dot = input.path.lastIndexOf(".");
    const hinted = dot >= 0 ? extensionMime(input.path.slice(dot + 1)) : undefined;
    if (hinted !== undefined && hinted !== magic) {
      return {
        ok: false,
        code: "invalid_image",
        message: `invalid_image: .${input.path.slice(dot + 1).toLowerCase()} extension disagrees with ${magic} magic bytes`,
      };
    }
  }

  const dimensions = parsePngDimensions(input.bytes);
  // Structure is proven per format before anything travels further: magic
  // without a body is a claim, not an image (WP19 复核 F1).
  const structure = checkImageStructure(magic, input.bytes);
  if (!structure.ok) {
    return { ok: false, code: structure.code, message: structure.message };
  }

  return {
    ok: true,
    attachment: {
      mediaType: magic,
      dataBase64: Buffer.from(input.bytes).toString("base64"),
      bytes: input.bytes.length,
      ...(dimensions === undefined ? {} : { width: dimensions.width, height: dimensions.height }),
    },
  };
}

export type ImageDetailInput = string | undefined;

/** Omitted means the default high view, exactly like the Codex handler. */
export function checkImageDetail(input: ImageDetailInput):
  | { readonly ok: true; readonly detail: ImageDetail }
  | { readonly ok: false; readonly code: "unsupported_detail"; readonly message: string } {
  if (input === undefined) {
    return { ok: true, detail: "high" };
  }

  if (isImageDetail(input)) {
    return { ok: true, detail: input };
  }

  return {
    ok: false,
    code: "unsupported_detail",
    message: `unsupported_detail: view_image.detail only supports \`high\` or \`original\`; omit \`detail\` for default high resized behavior, got \`${input}\``,
  };
}
