import { createInterface, type Completer } from "node:readline";
import type { Readable, Writable } from "node:stream";

/** A borrowed terminal read owns its readline listeners only until it answers. */
export function createTerminalLineReader(input: Readable, output: Writable, completer: Completer) {
  let activeClose: (() => void) | undefined;
  const history: string[] = [];

  return {
    read(prompt = ""): Promise<string | undefined> {
      if (activeClose !== undefined) return Promise.reject(new Error("terminal_reader_busy: a borrowed read is already active"));

      if (input.readableEnded) return Promise.resolve(undefined);

      const reader = createInterface({ input, output, terminal: true, completer, history, historySize: 200 });

      return new Promise(resolve => {
        const onClose = () => {
          activeClose = undefined;
          resolve(undefined);
        };

        activeClose = () => reader.close();
        reader.once("close", onClose);
        reader.question(prompt, answer => {
          reader.removeListener("close", onClose);
          reader.close();
          activeClose = undefined;
          if (answer.length > 0 && history[0] !== answer) history.unshift(answer);
          history.length = Math.min(history.length, 200);
          resolve(answer);
        });
      });
    },

    close(): void { activeClose?.(); },
  };
}
