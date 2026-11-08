import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SLASH_COMMANDS,
  findSlashCommand,
  isSlashInput,
  parseSlash,
  slashCompleter,
  slashHelpText,
} from "./slash.js";

/**
 * The slash table (WP C 波 §4.4, 反方 #17).
 *
 * The attack is the quiet one: an unrecognised `/whatever` being forwarded to the
 * model as if the user had said it. So the table is the authority on what a
 * command *is*, and `parseSlash` has to classify an unknown token as unknown
 * rather than letting it fall through to the prompt path.
 */

test("every command is reachable by its name and its aliases", () => {
  for (const command of SLASH_COMMANDS) {
    assert.equal(findSlashCommand(command.name), command);
    for (const alias of command.aliases) {
      assert.equal(findSlashCommand(alias), command, `${alias} must resolve to ${command.name}`);
    }
  }
});

test("parseSlash separates a command from its argument", () => {
  const resume = parseSlash("/resume   ses-1 ");

  assert.equal(resume.kind, "known");

  if (resume.kind === "known") {
    assert.equal(resume.invocation.command.kind, "resume");
    assert.equal(resume.invocation.arg, "ses-1");
  }

  const bare = parseSlash("/resume");

  assert.equal(bare.kind, "known");

  if (bare.kind === "known") {
    assert.equal(bare.invocation.arg, "");
  }

  assert.equal(parseSlash("/exit").kind, "known");
  assert.equal(parseSlash("/quit").kind, "known");
});

test("attack #17: an unknown slash token is unknown, never a prompt", () => {
  for (const input of ["/nope", "/?", "/help me", "/re sume"]) {
    const parsed = parseSlash(input);

    // `/?` is a documented alias of /help; everything else here is unknown.
    if (input === "/?" || input.startsWith("/help")) {
      assert.equal(parsed.kind, "known", input);
      continue;
    }

    assert.equal(parsed.kind, "unknown", `${input} must not be treated as a command`);
  }
  // And it must not be reported as a prompt either.
  assert.equal(parseSlash("/nope").kind === "not_a_command", false);
});

test("a line that is not a slash command is a prompt", () => {
  assert.equal(parseSlash("hello").kind, "not_a_command");
  assert.equal(parseSlash("").kind, "not_a_command");
  assert.equal(parseSlash("what is /etc?").kind, "not_a_command");
  assert.equal(isSlashInput("/x"), true);
  assert.equal(isSlashInput("x"), false);
});

test("help text is generated from the table, so the two cannot drift", () => {
  const help = slashHelpText();

  assert.equal(help.startsWith("commands:"), true);

  for (const command of SLASH_COMMANDS) {
    assert.equal(help.includes(command.name), true, `${command.name} missing from help`);
    if (command.arg !== undefined) {
      assert.equal(help.includes(command.arg), true, `${command.name} must show its argument`);
    }
    assert.equal(help.includes(command.summary), true, `${command.name} missing its summary`);
  }
});

test("tab completes a command name from what has been typed", () => {
  const [hits, line] = slashCompleter("/he");
  assert.deepEqual(hits, ["/help"]);
  // The original line comes back untouched: completion is a suggestion, and
  // rewriting what the person typed would be editing their message.
  assert.equal(line, "/he");
});

test("a bare slash offers every command", () => {
  const [hits] = slashCompleter("/");
  assert.equal(hits.length, SLASH_COMMANDS.length);
});

test("an ordinary line is not completed", () => {
  assert.deepEqual(slashCompleter("hello"), [[], "hello"]);
  assert.deepEqual(slashCompleter(""), [[], ""]);
});

test("a slash token nothing matches completes to nothing", () => {
  assert.deepEqual(slashCompleter("/zzz"), [[], "/zzz"]);
});

test("help also lists the keys a person cannot discover by looking", () => {
  const help = slashHelpText();
  assert.match(help, /\ \+ enter/, "multi-line is the one that silently mangles a pasted prompt");
  assert.match(help, /up \/ down/);
  assert.match(help, /ctrl-c/);
});

test("tab completes a command name from what has been typed", () => {
  const [hits, line] = slashCompleter("/he");
  assert.deepEqual(hits, ["/help"]);
  // The original line comes back untouched: completion is a suggestion, and
  // rewriting what the person typed would be editing their message.
  assert.equal(line, "/he");
});

test("a bare slash offers every command", () => {
  const [hits] = slashCompleter("/");
  assert.equal(hits.length, SLASH_COMMANDS.length);
});

test("an ordinary line is not completed", () => {
  assert.deepEqual(slashCompleter("hello"), [[], "hello"]);
  assert.deepEqual(slashCompleter(""), [[], ""]);
});

test("a slash token nothing matches completes to nothing", () => {
  assert.deepEqual(slashCompleter("/zzz"), [[], "/zzz"]);
});

test("help also lists the keys a person cannot discover by looking", () => {
  const help = slashHelpText();
  assert.match(help, /\ \+ enter/, "multi-line is the one that silently mangles a pasted prompt");
  assert.match(help, /up \/ down/);
  assert.match(help, /ctrl-c/);
});
