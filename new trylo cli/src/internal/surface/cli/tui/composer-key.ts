import type { ComposerBuffer } from "./composer-buffer.js";
import type { ComposerHistory } from "./composer-history.js";
import type { createCommandMenu } from "./composer-commands.js";
import type { KeyEvent } from "./keys.js";

type KeyOps = {
  readonly buffer: ComposerBuffer;
  readonly history: ComposerHistory;
  readonly menu: ReturnType<typeof createCommandMenu>;
  readonly submit: () => void;
};

/** Ordinary editing after shell controls, history search and bindings route the key. */
export function applyComposerKey(event: KeyEvent, ops: KeyOps): void {
  const { buffer: buf, history: hist, menu, submit } = ops;
  switch (event.kind) {
    case "char":
      buf.insert(event.text);
      return;
    case "paste":
      buf.acceptPaste(event.text);
      return;
    case "enter":
      submit();
      return;
    case "backspace":
      buf.backspace();
      return;
    case "delete":
      buf.deleteForward();
      return;
    case "left":
      buf.left();
      return;
    case "right":
      buf.right();
      return;
    case "home":
      buf.home();
      return;
    case "end":
      buf.end();
      return;
    case "up":
      hist.up();
      return;
    case "down":
      hist.down();
      return;
    case "escape":
      menu.hide(buf.text());
      return;
    case "tab": {
      const selected = menu.selected(buf.text());
      if (selected !== undefined) {
        buf.clear();
        buf.insert(selected.name);
        menu.hide(buf.text());
      }

      return;
    }
    case "ctrl":
      if (event.name === "u") {
        buf.killBefore();
      } else if (event.name === "k") {
        buf.killAfter();
      } else if (event.name === "w") {
        buf.killWord();
      }
      return;
    case "ignored":
      return;
  }
}
