import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { providerRequiresSecret, type CredentialProviderId } from "../../ports/credentials.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import { fail, type RunFailure } from "./run-failure.js";

/**
 * Where the secret for `trylo login` comes from.
 *
 * Two sources, and one invariant: argv is never one of them.
 *
 * - A file is read under a hard size cap, because the whole file becomes the
 *   key and a mistyped path should not turn into a multi-megabyte secret.
 * - A terminal is read with echo off. The audit that produced this module found
 *   the opposite assumption in the code: a line reader built with
 *   `terminal: false` silences *itself*, while the terminal driver keeps
 *   printing every keystroke onto the screen. Raw mode is what silences the
 *   driver, and readline is not used here at all.
 *
 * Everything is injected — a file reader, a terminal, an error sink — so both
 * rules are testable without a pty and without a real profile directory.
 */

/** The most bytes a secret file may hold. A key is not a document. */
export const MAX_SECRET_FILE_BYTES = 8192;

/**
 * The terminal the secret reader may touch.
 *
 * Deliberately tiny and structural: `process.stdin` satisfies it, and so does a
 * plain object in a test. It has no output member, which is the point — a
 * reader that cannot name an output stream cannot echo into one.
 */
export type SecretTerminal = {
  /** Turns the driver's echo off. Absent on a stream that is not a terminal. */
  readonly setRawMode?: (mode: boolean) => void;
  readonly resume: () => void;
  readonly pause: () => void;
  readonly on: (event: string, listener: (chunk: Buffer) => void) => unknown;
  readonly off: (event: string, listener: (chunk: Buffer) => void) => unknown;
};

/**
 * One line of secret text, read with echo off.
 *
 * `undefined` means the read could not be done safely or was abandoned: no raw
 * mode, Ctrl-C, Ctrl-D, or end of input. Each of those is a refusal the caller
 * must surface, so none of them is allowed to degrade into an empty secret that
 * later reads as a real key.
 */
export function readSecretLine(terminal: SecretTerminal): Promise<string | undefined> {
  const setRawMode = terminal.setRawMode;
  if (setRawMode === undefined) {
    return Promise.resolve(undefined);
  }

  // Raw mode is a method on the stream, so `terminal` has to stay the receiver.
  const setEcho = (enabled: boolean) => setRawMode.call(terminal, enabled);

  return new Promise((resolve) => {
    const decoder = new StringDecoder("utf8");
    let typed = "";
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) {
        return;
      }

      settled = true;
      terminal.off("data", onData);
      terminal.off("end", onEnd);
      terminal.off("error", onEnd);
      setEcho(false);
      terminal.pause();
      resolve(value);
    };
    const onData = (chunk: Buffer) => {
      // A decoder, not `chunk.toString`: a multi-byte character can straddle
      // two reads, and a mangled key would fail authentication for no reason.
      for (const character of decoder.write(chunk)) {
        if (character === "\r" || character === "\n") {
          finish(typed);
          return;
        }

        if (character === "\u0003" || character === "\u0004") {
          finish(undefined);
          return;
        }

        if (character === "\u007f" || character === "\b") {
          typed = typed.slice(0, -1);
          continue;
        }

        if (character >= " ") {
          typed += character;
        }
      }
    };
    const onEnd = () => finish(undefined);

    setEcho(true);
    terminal.on("data", onData);
    terminal.on("end", onEnd);
    terminal.on("error", onEnd);
    terminal.resume();
  });
}

/** The slice of the CLI context that reading a login secret needs. */
export type LoginSecretIo = {
  readonly cwd: string;
  readonly stdinIsTty: boolean;
  readonly readFile: (absolutePath: string) => string | undefined;
  readonly readSecret: () => Promise<string | undefined>;
  readonly stderr: (text: string) => void;
};

export type LoginSecretRequest = {
  readonly provider: CredentialProviderId;
  readonly secretFile?: string;
};

/** The secret to store, or the refusal that replaces the whole login. */
export type LoginSecret = { readonly secret?: string } | RunFailure;

export async function resolveLoginSecret(
  io: LoginSecretIo,
  request: LoginSecretRequest,
): Promise<LoginSecret> {
  if (!providerRequiresSecret(request.provider)) {
    return {};
  }

  if (request.secretFile !== undefined) {
    return secretFromFile(io, request.secretFile);
  }

  if (io.stdinIsTty) {
    return secretFromTerminal(io, request.provider);
  }

  return fail(
    EXIT_CODES.USAGE,
    "no secret source for a keyed provider",
    "pass --secret-file <path>, or run from a terminal to type the secret",
  );
}

function secretFromFile(io: LoginSecretIo, secretFile: string): LoginSecret {
  const absolute = path.resolve(io.cwd, secretFile);
  const text = io.readFile(absolute);
  if (text === undefined) {
    return fail(
      EXIT_CODES.USAGE,
      `cannot read secret file: ${absolute}`,
      "pass --secret-file <path> pointing at a readable file holding the key",
    );
  }

  // Measured on the file's own bytes and before any trimming: trimming first
  // would let an oversized file pass by ending in newlines.
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_SECRET_FILE_BYTES) {
    return fail(
      EXIT_CODES.USAGE,
      `secret file is ${bytes} bytes; the limit is ${MAX_SECRET_FILE_BYTES}`,
      `put only the key in the file: --secret-file accepts at most ${MAX_SECRET_FILE_BYTES} bytes`,
    );
  }

  return { secret: withoutTrailingNewlines(text) };
}

async function secretFromTerminal(io: LoginSecretIo, provider: string): Promise<LoginSecret> {
  io.stderr(`Enter secret for ${provider}: `);
  const typed = await io.readSecret();
  if (typed === undefined) {
    return fail(
      EXIT_CODES.USAGE,
      "no secret was read from the terminal",
      "type the secret and press Enter, or pass --secret-file <path>",
    );
  }

  return { secret: withoutTrailingNewlines(typed) };
}

/** A trailing newline is an editor or terminal artefact, not part of the key. */
function withoutTrailingNewlines(text: string): string {
  return text.replace(/[\r\n]+$/, "");
}
