import assert from "node:assert/strict";
import test from "node:test";
import { createProcessContext } from "./main.js";

for (const terminal of [false, true]) {
  test(`root lends the keyboard interface only when stdin is a terminal (${terminal})`, () => {
    const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

    Object.defineProperty(process.stdin, "isTTY", { value: terminal, configurable: true });

    try {
      const ctx = createProcessContext();
      if (terminal) {
        assert.equal(typeof ctx.keys?.start, "function");
        assert.equal(typeof ctx.keys?.suspend, "function");
      } else {
        assert.equal(ctx.keys, undefined);
      }
    } finally {
      if (original === undefined) Reflect.deleteProperty(process.stdin, "isTTY");
      else Object.defineProperty(process.stdin, "isTTY", original);
    }
  });
}
