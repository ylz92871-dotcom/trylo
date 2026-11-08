import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadLspServersFile } from "./lsp-config.js";

/**
 * Where `lsp_navigate` comes from in production (WP12 L60).
 *
 * The settings key holds a path, never the servers: this file is the one
 * place that path becomes programs. Every malformed shape below must refuse
 * with a named reason rather than starting a neighbouring program — a typo
 * in `command` next to a valid `name` is how a config starts something the
 * person never meant.
 */
describe("loadLspServersFile", () => {
  function reader(files: Readonly<Record<string, string>>): (path: string) => string {
    return (path: string) => {
      const text = files[path];
      if (text === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return text;
    };
  }

  it("loads one server with defaults filled", () => {
    const result = loadLspServersFile(reader({ "lsp.json": JSON.stringify({ servers: [{ name: "ts", command: "tsserver", extensions: ["ts"] }] }) }), "lsp.json");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.servers, [
      { serverName: "ts", command: "tsserver", args: [], extensions: ["ts"] },
    ]);
  });

  it("an empty server list is valid and means no servers", () => {
    const result = loadLspServersFile(reader({ "lsp.json": JSON.stringify({ servers: [] }) }), "lsp.json");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.servers, []);
  });

  it("an unreadable file is a named failure, not an exception", () => {
    const result = loadLspServersFile(reader({}), "missing.json");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "lsp_config_unreadable");
    assert.match(result.message, /missing\.json/);
  });

  it("non-JSON and non-object roots are refused", () => {
    for (const text of ["{oops", "[1,2]", '"str"', "42"]) {
      const result = loadLspServersFile(reader({ "lsp.json": text }), "lsp.json");
      assert.equal(result.ok, false, `${text} was accepted`);
      if (!result.ok) {
        assert.equal(result.code, "lsp_config_invalid");
      }
    }
  });

  it("refuses a missing name, command, or extension list", () => {
    const bad = [
      { command: "x", extensions: ["ts"] },
      { name: "ts", extensions: ["ts"] },
      { name: "ts", command: "x", extensions: [] },
      { name: "", command: "x", extensions: ["ts"] },
      { name: "ts", command: "x", extensions: ["TS"] },
      { name: "ts", command: "x", extensions: [".ts"] },
    ];
    for (const entry of bad) {
      const result = loadLspServersFile(reader({ "lsp.json": JSON.stringify({ servers: [entry] }) }), "lsp.json");
      assert.equal(result.ok, false, `${JSON.stringify(entry)} was accepted`);
    }
  });

  it("refuses unknown keys, duplicate names, and shared extensions", () => {
    const unknown = loadLspServersFile(
      reader({ "lsp.json": JSON.stringify({ servers: [{ name: "ts", command: "x", extensions: ["ts"], cmd: "y" }] }) }),
      "lsp.json",
    );

    assert.equal(unknown.ok, false);
    const duplicate = loadLspServersFile(
      reader({
        "lsp.json": JSON.stringify({
          servers: [
            { name: "ts", command: "a", extensions: ["ts"] },
            { name: "ts", command: "b", extensions: ["tsx"] },
          ],
        }),
      }),
      "lsp.json",
    );

    assert.equal(duplicate.ok, false);
    const shared = loadLspServersFile(
      reader({
        "lsp.json": JSON.stringify({
          servers: [
            { name: "a", command: "a", extensions: ["ts"] },
            { name: "b", command: "b", extensions: ["ts"] },
          ],
        }),
      }),
      "lsp.json",
    );

    assert.equal(shared.ok, false);

    if (!shared.ok) {
      assert.match(shared.message, /\.ts/);
    }
  });

  it("caps the list and validates the optional fields", () => {
    const many = Array.from({ length: 17 }, (_, index) => ({ name: `s${index}`, command: "x", extensions: [`e${index}`] }));
    const capped = loadLspServersFile(reader({ "lsp.json": JSON.stringify({ servers: many }) }), "lsp.json");

    assert.equal(capped.ok, false);
    const env = loadLspServersFile(
      reader({ "lsp.json": JSON.stringify({ servers: [{ name: "ts", command: "x", extensions: ["ts"], env: { A: "1" }, enabled: false, origin: "user file" }] }) }),
      "lsp.json",
    );

    assert.equal(env.ok, true);

    if (!env.ok) return;

    assert.deepEqual(env.servers[0], {
      serverName: "ts",
      command: "x",
      args: [],
      extensions: ["ts"],
      env: { A: "1" },
      enabled: false,
      origin: "user file",
    });
    const badEnv = loadLspServersFile(
      reader({ "lsp.json": JSON.stringify({ servers: [{ name: "ts", command: "x", extensions: ["ts"], env: { A: 1 } }] }) }),
      "lsp.json",
    );

    assert.equal(badEnv.ok, false);
  });
});
