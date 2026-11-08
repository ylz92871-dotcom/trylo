import assert from "node:assert/strict";
import { test } from "node:test";
import { planShellPipeline, tokenizeCommand } from "./command.js";

/**
 * WP05.2: what the tokenizer does to a Windows path.
 *
 * Written as red cases first — every expectation below was a *quote of observed
 * behaviour* before the fix, so the fix had to move each one:
 *
 *   "C:\Users\binaries\node.exe"  ->  ["C:Usersbinariesnode.exe"]   separators deleted
 *   "C:\b\n\v\t\f\r\a\0test"      ->  ["C:bnvtfra0test"]            letters survived
 *   "\\\\server\\share\\file.txt"  ->  ["\\serversharefile.txt"]      UNC, deleted
 *   "dir\"                        ->  undefined                    dangling escape
 *
 * Two things the measurements ruled out, worth keeping in the record because
 * both were believed before they were checked:
 *
 *  - The letters survive. `\b` and `\n` in a path are deleted as separators,
 *    NOT turned into backspace and newline. A control-character bug would need
 *    a completely different fix.
 *  - Quoted (`"C:\Program Files\..."`) and forward-slash (`C:/...`) paths
 *    already worked whole. The gap was specifically the *bare backslash* word,
 *    so "all absolute paths fail" was too strong.
 *
 * What the fix is NOT: a platform flag, a general separator rewrite, or a
 * blanket `shell: true`. `\` is still an escape character everywhere except
 * where the word is recognisably a drive path or a UNC opening, so a POSIX
 * command cannot change meaning because of this.
 */

function words(command: string): readonly string[] | undefined {
  const tokens = tokenizeCommand(command);
  return tokens?.map((token) => token.text);
}

test("a bare drive path keeps its separators", () => {
  // The bug this file exists for. A drive path is the most common way to name a
  // program on this platform and none of it used to survive.
  assert.deepEqual(words("C:\\tools\\prog.exe -v"), [
    "C:\\tools\\prog.exe",
    "-v",
  ]);
});

test("separators are kept, not turned into control characters", () => {
  // The letters-and-control-characters question, settled: every letter and
  // every separator is present verbatim.
  assert.deepEqual(words("C:\\b\\n\\v\\t\\test"), ["C:\\b\\n\\v\\t\\test"]);
  const out = words("C:\\b\\n\\v\\t\\f\\r\\a\\0test");

  for (const char of out?.[0] ?? "") {
    assert.ok(char.charCodeAt(0) >= 0x20, `unexpected control character in ${JSON.stringify(out)}`);
  }
});

test("a UNC path keeps its separators", () => {
  assert.deepEqual(words("\\\\server\\share\\file.txt"), ["\\\\server\\share\\file.txt"]);
});

test("an extended-length or device path opening is a path too", () => {
  // `\\?\` and `\\.\` are how Windows spells "no path parsing, literally this".
  // They open with the same doubled backslash, so the same rule has to cover
  // them or a caller gets a half-deleted word.
  assert.deepEqual(words("\\\\?\\C:\\tools\\prog.exe"), ["\\\\?\\C:\\tools\\prog.exe"]);
  assert.deepEqual(words("\\\\.\\PhysicalDrive0"), ["\\\\.\\PhysicalDrive0"]);
});

test("a path as an argument keeps its separators", () => {
  // Not only the executable: `--file C:\tmp\x.txt` is the ordinary case, and a
  // fix that only looked at word zero would leave the argument mangled.
  assert.deepEqual(words("prog --file C:\\tmp\\x.txt"), [
    "prog",
    "--file",
    "C:\\tmp\\x.txt",
  ]);
  // A path containing a space still has to be quoted, and that is not a
  // backslash rule: a space ends the word here exactly as it does on POSIX.
  // Quoted, the path survives whole:
  assert.deepEqual(words('prog --path "D:\\空 格\\文件.txt"'), [
    "prog",
    "--path",
    "D:\\空 格\\文件.txt",
  ]);
  // Unquoted it splits at the space, and the tail is then an ordinary word whose
  // backslash escapes like any other (`note\file` below). Nothing carries the
  // path-ness across the space — that is the same answer POSIX gives, and it is
  // why a space in a path has to be quoted.
  assert.deepEqual(words("prog --path D:\\空 格\\文件.txt"), [
    "prog",
    "--path",
    "D:\\空",
    "格文件.txt",
  ]);
});

test("POSIX escaping still means what it means", () => {
  // The behaviour that must survive any fix: outside a path shape, a backslash
  // escapes. This is why the rule is scoped to a recognisable path instead of
  // "backslashes are literal now" — that version would break this line.
  assert.deepEqual(words("echo a\\ b"), ["echo", "a b"]);
  assert.deepEqual(words("echo \\$HOME"), ["echo", "$HOME"]);
  assert.deepEqual(words('echo "a\\"b"'), ["echo", 'a"b']);
});

test("a backslash before an ordinary letter is still an escape", () => {
  // The negative case that keeps the rule narrow: `note\file` is a POSIX escape
  // (one word, `note` + `file`), not a path, because nothing marks it as one.
  assert.deepEqual(words("note\\file"), ["notefile"]);
});

test("a trailing backslash is still refused", () => {
  // Unchanged on purpose: a dangling escape has no defined meaning, and the
  // path rule does not make `dir\` a directory reference. A directory is named
  // with a forward slash or in quotes.
  assert.equal(words("dir\\"), undefined);
});

test("the planner now sees the path the caller wrote", () => {
  // Before the fix this planned `["C:toolsprog.exe"]`: admitted, then failed at
  // spawn with an ENOENT naming a program nobody asked for. The plan now carries
  // the word as written, so `allowAbsoluteExecutable: false` can do its job on
  // the real path.
  const policy = { workspaceRoot: "C:\\w", allowAbsoluteExecutable: false };
  const planned = planShellPipeline(policy, "C:\\tools\\prog.exe");

  assert.equal(planned.ok, false, "an absolute executable is refused when not allowed");

  if (!planned.ok) {
    assert.equal(planned.code, "path_outside_workspace");
  }

  // And with the policy permissive it is admitted as the path that was written.
  const allowed = planShellPipeline({ ...policy, allowAbsoluteExecutable: true }, "C:\\tools\\prog.exe -v");

  assert.equal(allowed.ok, true);

  if (allowed.ok) {
    assert.deepEqual(allowed.segments[0]?.argv, ["C:\\tools\\prog.exe", "-v"]);
  }
});

test("the tokenizer and the pipeline splitter agree on every backslash shape", () => {
  // The two scanners work on different things — words and raw text — and share
  // rules rather than code. These are the shapes where sharing rules could
  // drift, so they are checked against each other rather than trusted. Each case
  // states the segment count it expects, because counting `|` characters would
  // be wrong: a quoted `|` is text, not a pipe.
  const cases: ReadonlyArray<{ readonly command: string; readonly segments: number }> = [
    { command: "C:\\a\\b.exe | prog", segments: 2 },
    { command: "C:\\a\\b.exe | C:\\c\\d.exe", segments: 2 },
    { command: "\\\\srv\\s\\p | prog", segments: 2 },
    { command: "echo a\\ b | prog", segments: 2 },
    { command: 'echo "a|b" | prog', segments: 2 },
    { command: 'prog "C:\\x y\\z.txt" | tail', segments: 2 },
  ];
  for (const { command, segments } of cases) {
    const planned = planShellPipeline({ workspaceRoot: "/w", allowAbsoluteExecutable: true }, command);
    assert.equal(planned.ok, true, `${command} -> ${planned.ok ? "ok" : planned.code}`);
    if (planned.ok) {
      assert.equal(planned.segments.length, segments, command);
    }
  }
});

test("a pipeline of real drive paths keeps every path whole", () => {
  const planned = planShellPipeline(
    { workspaceRoot: "/w", allowAbsoluteExecutable: true },
    "C:\\tools\\a.exe --in C:\\in\\x.txt | C:\\tools\\b.exe",
  );

  assert.equal(planned.ok, true);

  if (planned.ok) {
    assert.deepEqual(planned.segments[0]?.argv, ["C:\\tools\\a.exe", "--in", "C:\\in\\x.txt"]);
    assert.deepEqual(planned.segments[1]?.argv, ["C:\\tools\\b.exe"]);
  }
});
