import type { ComposerIo } from "./composer.js";

/** Redraw from the previous cursor row, including multi-line drafts and panels. */
export function createComposerScreen(io: ComposerIo) {
  let cursorRow = 0;
  const clear = (): void => {
    if (cursorRow > 0) io.write(`\x1b[${cursorRow}A`);
    io.write("\r\x1b[J");
    cursorRow = 0;
  };

  return {
    clear,
    reset: () => { cursorRow = 0; },

    draw(rows: ReadonlyArray<string>, row: number, column: number): void {
      clear();
      io.write(rows.join("\n"));
      const up = rows.length - 1 - row;
      if (up > 0) io.write(`\x1b[${up}A`);
      io.write(`\r\x1b[${column + 1}G`);
      cursorRow = row;
    },
  };
}
