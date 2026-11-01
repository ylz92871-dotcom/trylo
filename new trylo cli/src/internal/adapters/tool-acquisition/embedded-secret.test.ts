import assert from "node:assert/strict";
import test from "node:test";
import { hasEmbeddedSecret } from "./embedded-secret.js";

const header = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
const scan = (text: string) => hasEmbeddedSecret(Buffer.from(text));
test("a PEM importer's format comparison is not embedded private key material", () => {
  assert.equal(scan(`if (pkcs8.indexOf("${header}") !== 0) throw new TypeError("invalid format");`), false);
  assert.equal(scan(`documented label: ${header}`), false);
});
test("raw, escaped, inline and truncated PEM material remain forbidden", () => {
  for (const separator of ["\n", "\r\n", "\\n", "\\r\\n", ""]) {
    // Deliberately invalid repeated data: never put a real credential into a test fixture.
    assert.equal(scan(`${header}${separator}${"A".repeat(96)}`), true, JSON.stringify(separator));
  }
  assert.equal(scan(["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ") + "\n" + "B".repeat(96)), true);
});
test("existing access-ID and token signatures remain forbidden", () => {
  assert.equal(scan("AK" + "IA" + "0".repeat(16)), true);
  assert.equal(scan("gh" + "p_" + "x".repeat(36)), true);
  assert.equal(scan("ordinary package source"), false);
});
