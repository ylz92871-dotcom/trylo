import assert from "node:assert/strict";
import test from "node:test";
import {
  checkImageBytes,
  checkImageDetail,
  crc32IEEE,
  describeImageForLog,
  detectImageMime,
  encodeDataUrl,
  inspectPng,
  parsePngDimensions,
} from "./image-guard.js";
import { MAX_IMAGE_BYTES } from "../../ports/media.js";

/**
 * WP19.1 (C25, L10) contract: magic decides, structure proves, the ceiling
 * refuses before any decode, unknown detail strings refuse, and logs never
 * carry the payload.
 *
 * WP19 复核订正 (F1): magic alone once accepted garbage with a PNG header
 * (reviewer proved `width=height=1094795585` on magic + 16 'A' bytes). The
 * two F1 cases below are that red, now pinned as refusals.
 */

function u32be(value: number): Array<number> {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function chunk(tag: string, data: Array<number>): Array<number> {
  const tagBytes = [...tag].map((char) => char.charCodeAt(0));
  const body = [...tagBytes, ...data];
  return [...u32be(data.length), ...body, ...u32be(crc32IEEE(Uint8Array.from(body), 0, body.length))];
}

/** Structurally whole PNG: signature + IHDR + IDAT + IEND, CRCs computed. */
function buildPng(width: number, height: number): Uint8Array {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = chunk("IHDR", [...u32be(width), ...u32be(height), 0x08, 0x02, 0x00, 0x00, 0x00]);
  const idat = chunk("IDAT", []);
  const iend = chunk("IEND", []);
  return Uint8Array.from([...signature, ...ihdr, ...idat, ...iend]);
}

function pngBytes(): Uint8Array {
  return buildPng(1, 1);
}

test("magic decides the MIME for all four allowlisted formats", () => {
  assert.equal(detectImageMime(pngBytes()), "image/png");
  assert.equal(detectImageMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0xff, 0xd9])), "image/jpeg");
  assert.equal(detectImageMime(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x3b])), "image/gif");
  assert.equal(
    detectImageMime(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50])),
    "image/webp",
  );
  assert.equal(detectImageMime(new TextEncoder().encode("arbitrary file contents")), undefined);
  assert.equal(detectImageMime(new Uint8Array(0)), undefined);
});

test("the CRC implementation matches the standard check value", () => {
  // CRC-32("123456789") = 0xCBF43926 pins the implementation independently of
  // the fixtures built with it below.
  assert.equal(crc32IEEE(new TextEncoder().encode("123456789"), 0, 9), 0xcbf43926);
});

test("F1 red: magic plus garbage is not an image and reports no dimensions", () => {
  // The reviewer's exact probe: PNG magic + 16 'A' bytes was once accepted
  // with width=height=1094795585.
  const garbage = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(16).fill(0x41)]);
  const refused = checkImageBytes({ bytes: garbage, path: "evil.png" });

  assert.equal(refused.ok, false);

  if (!refused.ok) {
    assert.equal(refused.code, "invalid_image");
  }

  assert.equal(parsePngDimensions(garbage), undefined);
  assert.equal(inspectPng(garbage).ok, false);
});

test("truncated and corrupt PNGs refuse with named codes", () => {
  // Signature + IHDR length/tag only: truncated before any header exists.
  const truncated = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
  const cut = checkImageBytes({ bytes: truncated, path: "cut.png" });

  assert.equal(cut.ok, false);

  if (!cut.ok) {
    assert.equal(cut.code, "invalid_image");
  }

  // Valid shape, flipped data byte: IHDR CRC mismatch.
  const corrupt = pngBytes();

  corrupt[18] = (corrupt[18] as number) ^ 0xff;
  const broken = checkImageBytes({ bytes: corrupt, path: "corrupt.png" });

  assert.equal(broken.ok, false);

  if (!broken.ok) {
    assert.equal(broken.code, "invalid_image");
  }

  // IHDR + IEND but no IDAT: a header with no image data.
  const noData = Uint8Array.from([
    ...pngBytes().slice(0, 33),
    ...chunk("IEND", []),
  ]);
  const hollow = checkImageBytes({ bytes: noData, path: "hollow.png" });

  assert.equal(hollow.ok, false);

  if (!hollow.ok) {
    assert.equal(hollow.code, "invalid_image");
  }
});

test("a structurally valid but oversize PNG refuses as too_large, naming its edge", () => {
  const big = buildPng(3000, 3000);
  const refused = checkImageBytes({ bytes: big, path: "big.png" });

  assert.equal(refused.ok, false);

  if (!refused.ok) {
    assert.equal(refused.code, "too_large");
    assert.ok(refused.message.includes("3000x3000"));
  }
});

test("truncated siblings refuse: JPEG needs EOI, GIF needs version and trailer, WebP needs a true size", () => {
  const jpegCut = checkImageBytes({ bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00]), path: "a.jpg" });

  assert.equal(jpegCut.ok, false);
  const jpegWhole = checkImageBytes({ bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0xff, 0xd9]), path: "a.jpg" });

  assert.equal(jpegWhole.ok, true);
  const gifCut = checkImageBytes({ bytes: Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), path: "a.gif" });

  assert.equal(gifCut.ok, false);
  const gifWhole = checkImageBytes({ bytes: Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x3b]), path: "a.gif" });

  assert.equal(gifWhole.ok, true);
  const webpLying = checkImageBytes({
    bytes: Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
    path: "a.webp",
  });

  assert.equal(webpLying.ok, false);
  const webpWhole = checkImageBytes({
    bytes: Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
    path: "a.webp",
  });

  assert.equal(webpWhole.ok, true);
});

test("a .png renamed from text is invalid, and a lying extension loses to magic", () => {
  const text = new TextEncoder().encode("arbitrary file contents");
  const refused = checkImageBytes({ bytes: text, path: "notes.png" });

  assert.equal(refused.ok, false);

  if (!refused.ok) {
    assert.equal(refused.code, "invalid_image");
  }

  const mismatch = checkImageBytes({ bytes: pngBytes(), path: "photo.jpg" });

  assert.equal(mismatch.ok, false);

  if (!mismatch.ok) {
    assert.equal(mismatch.code, "invalid_image");
  }
});

test("empty and oversize inputs refuse before any decode", () => {
  const empty = checkImageBytes({ bytes: new Uint8Array(0), path: "empty.png" });

  assert.equal(empty.ok, false);

  if (!empty.ok) {
    assert.equal(empty.code, "empty_file");
  }

  const big = new Uint8Array(MAX_IMAGE_BYTES + 1);

  big[0] = 0x89;
  big[1] = 0x50;
  const oversize = checkImageBytes({ bytes: big });

  assert.equal(oversize.ok, false);

  if (!oversize.ok) {
    assert.equal(oversize.code, "too_large");
  }
});

test("a valid PNG validates with dimensions and a data URL that round-trips", () => {
  const bytes = pngBytes();

  assert.deepEqual(parsePngDimensions(bytes), { width: 1, height: 1 });
  const verdict = checkImageBytes({ bytes, path: "image.png" });

  assert.equal(verdict.ok, true);

  if (verdict.ok) {
    assert.equal(verdict.attachment.mediaType, "image/png");
    assert.equal(verdict.attachment.bytes, bytes.length);
    assert.equal(verdict.attachment.width, 1);
    assert.equal(verdict.attachment.height, 1);
    const url = encodeDataUrl(verdict.attachment.mediaType, bytes);

    assert.ok(url.startsWith("data:image/png;base64,"));
    assert.deepEqual(Buffer.from(url.split(",")[1] as string, "base64"), Buffer.from(bytes));
  }
});

test("detail accepts only high/original and defaults to high when omitted", () => {
  assert.deepEqual(checkImageDetail(undefined), { ok: true, detail: "high" });
  assert.deepEqual(checkImageDetail("high"), { ok: true, detail: "high" });
  assert.deepEqual(checkImageDetail("original"), { ok: true, detail: "original" });
  const low = checkImageDetail("low");

  assert.equal(low.ok, false);

  if (!low.ok) {
    assert.equal(low.code, "unsupported_detail");
  }
});

test("log summaries carry facts, never the payload", () => {
  const verdict = checkImageBytes({ bytes: pngBytes(), path: "image.png" });

  assert.equal(verdict.ok, true);

  if (verdict.ok) {
    const summary = describeImageForLog({ ...verdict.attachment, detail: "high" });
    assert.ok(summary.includes("image/png"));
    assert.ok(summary.includes(String(pngBytes().length)));
    assert.ok(!summary.includes(verdict.attachment.dataBase64));
  }
});
