import { SLASH_COMMANDS } from "../slash.js";
import { fitText } from "./text.js";

/** Completion and the popup share the authoritative slash vocabulary. */
export function createCommandMenu() {
  let selected = 0;
  let hidden: string | undefined;
  const matches = (text: string) => hidden === text || !/^\/[^\s]*$/.test(text) ? [] : SLASH_COMMANDS.filter(command => command.name.startsWith(text));

  return {
    matches,
    hide: (text: string) => { hidden = text; },

    show: () => {
      hidden = undefined;
      selected = 0;
    },

    selected(text: string) { return matches(text)[Math.min(selected, Math.max(0, matches(text).length - 1))]; },

    move(text: string, delta: number) {
      const length = matches(text).length;
      selected = (selected + delta + length) % Math.max(1, length);
    },

    rows(text: string, columns: number): ReadonlyArray<string> {
      const commands = matches(text);
      if (commands.length === 0) return [];

      selected = Math.min(selected, commands.length - 1);
      const start = Math.max(0, selected - 3);

      return [...commands.slice(start, start + 6).map((command, index) => fitText(
        `${start + index === selected ? "›" : " "} ${command.name}  ${command.summary}`, columns - 1)),
      fitText("↑↓ 选择 · Enter 使用 · Tab 补全 · Esc 收起", columns - 1)];
    },
  };
}
