import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_BINDINGS,
  loadUserBindings,
  parseKeystroke,
  resolveAction,
  resolveBindings,
  type Binding,
} from "./keybindings.js";

/**
 * WP23.2 (L46): the keystroke grammar, the user layer and the override rule.
 * The grammar is the legacy build's; the reserved-key rule (Ctrl-C / Ctrl-D)
 * is legacy's `reservedShortcuts`.
 */

test("the grammar parses modifiers and aliases", () => {
  assert.deepEqual(parseKeystroke("ctrl+r"), { key: "r", ctrl: true, alt: false, shift: false });
  assert.deepEqual(parseKeystroke("return"), { key: "enter", ctrl: false, alt: false, shift: false });
  assert.deepEqual(parseKeystroke("ctrl+shift+-"), { key: "-", ctrl: true, alt: false, shift: true });
});

test("unparsable strokes are dropped, not guessed", () => {
  assert.equal(parseKeystroke("ctrl+alt+"), undefined);
  assert.equal(parseKeystroke(""), undefined);
});

test("defaults cover the readline-ish set", () => {
  const actions = DEFAULT_BINDINGS.map((entry) => entry.action);
  for (const expected of ["submit", "history-previous", "history-next", "history-search", "external-editor", "kill-word"]) {
    assert.ok(actions.includes(expected as never), `missing default: ${expected}`);
  }
});

test("user bindings override defaults", () => {
  const user: ReadonlyArray<Binding> = [
    { strokes: [parseKeystroke("ctrl+t")!], action: "history-search" },
  ];
  const table = resolveBindings(user);
  const verdict = resolveAction({ kind: "ctrl", name: "t" }, table);
  assert.deepEqual(verdict, { kind: "action", action: "history-search" });
});

test("reserved keys are refused from the user layer but stay at the shell", () => {
  const user: ReadonlyArray<Binding> = [
    { strokes: [parseKeystroke("ctrl+c")!], action: "kill-line-after" },
    { strokes: [parseKeystroke("ctrl+k")!], action: "end-of-line" },
  ];
  const table = resolveBindings(user);
  // ctrl+k was accepted; ctrl+c was refused, so nothing in the table carries
  // it and the shell's interrupt path keeps it.
  const claimsCtrlC = (entry: Binding): boolean => entry.strokes.some((s) => s.ctrl && s.key === "c");

  assert.equal(table.some(claimsCtrlC), false);
  assert.equal(table.some((entry) => entry.action === "end-of-line"), true);
});

test("the user file is read from the config home and parsed", () => {
  const files = new Map<string, string>([
    ["/home/.trylo/keybindings.json", JSON.stringify([{ key: "ctrl+t", action: "history-search" }])],
  ]);
  const { bindings, problem } = loadUserBindings((path) => files.get(path), "/home");
  assert.equal(problem, undefined);
  assert.equal(bindings.length, 1);
});

test("a missing file means defaults only, with no problem", () => {
  const { bindings, problem } = loadUserBindings(() => undefined, "/home");
  assert.equal(problem, undefined);
  assert.equal(bindings.length, 0);
});

test("a malformed file means defaults plus a stated problem", () => {
  const { bindings, problem } = loadUserBindings(() => "{not json", "/home");
  assert.equal(bindings.length, 0);
  assert.match(problem ?? "", /not valid JSON/);
});

test("unknown actions and keys in the user file are dropped, not fatal", () => {
  const files = new Map<string, string>([
    [
      "/home/.trylo/keybindings.json",
      JSON.stringify([
        { key: "ctrl+t", action: "not-a-real-action" },
        { key: "ctrl+alt+", action: "submit" },
        { key: "ctrl+y", action: "end-of-line" },
      ]),
    ],
  ]);
  const { bindings } = loadUserBindings((path) => files.get(path), "/home");

  assert.deepEqual(bindings.map((entry) => entry.action), ["end-of-line"]);
});

test("chords match as sequences", () => {
  const user: ReadonlyArray<Binding> = [
    { strokes: [parseKeystroke("ctrl+x")!, parseKeystroke("ctrl+e")!], action: "external-editor" },
  ];
  const table = resolveBindings(user);
  const first = resolveAction({ kind: "ctrl", name: "x" }, table);

  assert.deepEqual(first, { kind: "chord" });
  const second = resolveAction({ kind: "ctrl", name: "e" }, table, [{ key: "x", ctrl: true, alt: false, shift: false }]);

  assert.deepEqual(second, { kind: "action", action: "external-editor" });
});
