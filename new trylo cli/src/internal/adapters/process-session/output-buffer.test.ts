import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createBoundedBuffer } from "./output-buffer.js";

/**
 * The buffer's two promises: it says when it dropped something, and a read is a
 * cursor rather than a replay. Both are easy to break in a way that still looks
 * like it works — a buffer that silently trims produces output that reads as
 * "the program printed nothing", which is a different fact.
 */
describe("bounded output buffer", () => {
  it("returns only what arrived since the previous read", () => {
    const buffer = createBoundedBuffer(1024);
    buffer.write(Buffer.from("first\n", "utf8"));
    assert.equal(buffer.read(1024).text, "first\n");
    buffer.write(Buffer.from("second\n", "utf8"));
    assert.equal(buffer.read(1024).text, "second\n");
    // A third read with nothing new is empty, not the previous answer again.
    assert.equal(buffer.read(1024).text, "");
  });

  it("splits a read at the requested cap and keeps the remainder", () => {
    const buffer = createBoundedBuffer(1024);
    buffer.write(Buffer.from("abcdefghij", "utf8"));
    const first = buffer.read(4);
    assert.equal(first.text, "abcd");
    assert.equal(first.heldBack, 6);
    const second = buffer.read(1024);
    assert.equal(second.text, "efghij");
    assert.equal(second.heldBack, 0);
  });

  it("declares that it dropped output rather than trimming quietly", () => {
    const buffer = createBoundedBuffer(8);
    assert.equal(buffer.dropped, false);
    buffer.write(Buffer.from("0123456789", "utf8"));
    assert.equal(buffer.dropped, true, "exceeding the cap must be declared");
    // The newest bytes are what survive: a late reader wants the tail.
    assert.equal(buffer.read(1024).text, "23456789");
  });

  it("keeps byteLength as unread bytes, not bytes ever written", () => {
    const buffer = createBoundedBuffer(1024);
    buffer.write(Buffer.from("12345", "utf8"));
    assert.equal(buffer.byteLength, 5);
    buffer.read(5);
    assert.equal(buffer.byteLength, 0);
  });

  it("holds multi-byte characters whole rather than splitting the code point", () => {
    // "中文" is 中 (3 bytes) + 文 (3 bytes). Cutting at 5 bytes leaves a whole
    // 中 and two thirds of 文. The decoder must not invent a character out of
    // those two bytes. While the transport is open, the incomplete suffix waits.
    // Only a true end without the final byte renders a replacement character.
    const bytes = Buffer.from("中文", "utf8");
    assert.equal(bytes.byteLength, 6);
    const cut = createBoundedBuffer(1024);
    cut.write(bytes.subarray(0, 5));
    const partial = cut.read(1024).text;
    assert.ok(partial.startsWith("中"), "the complete character survives intact");
    assert.equal(partial, "中");
    cut.end();
    assert.equal(cut.read(1024).text, "�", "only a genuinely incomplete final stream is marked");
  });

  it("keeps the exact text across read limits that cut Chinese and emoji", () => {
    const buffer = createBoundedBuffer(1024);
    buffer.write(Buffer.from("中文🙂"));
    assert.equal(buffer.read(5).text, "中");
    assert.equal(buffer.read(5).text, "文");
    assert.equal(buffer.read(1).text, "", "a budget smaller than one character consumes none of it");
    assert.equal(buffer.read(4).text, "🙂");
    assert.equal(buffer.byteLength, 0);
  });

  it("resets both the content and the dropped flag", () => {
    const buffer = createBoundedBuffer(4);
    buffer.write(Buffer.from("abcdefgh", "utf8"));
    assert.equal(buffer.dropped, true);
    buffer.reset();
    assert.equal(buffer.dropped, false);
    assert.equal(buffer.byteLength, 0);
  });

  it("treats an empty write as nothing at all", () => {
    const buffer = createBoundedBuffer(1024);
    buffer.write(Buffer.alloc(0));
    assert.equal(buffer.byteLength, 0);
    assert.equal(buffer.dropped, false);
  });

  it("floors the cap at one byte rather than rejecting it", () => {
    const buffer = createBoundedBuffer(0);
    buffer.write(Buffer.from("a", "utf8"));
    assert.equal(buffer.read(1024).text, "a");
  });

  it("holds back everything when a read asks for zero bytes", () => {
    const buffer = createBoundedBuffer(1024);
    buffer.write(Buffer.from("keepme", "utf8"));
    const read = buffer.read(0);
    assert.equal(read.text, "");
    assert.equal(read.heldBack, 6, "a zero-byte read consumes nothing");
    assert.equal(buffer.read(1024).text, "keepme");
  });
});
