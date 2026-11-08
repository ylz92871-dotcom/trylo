import type { KeyEvent } from "./keys.js";
import { fitText } from "./text.js";

export type ChoiceItem = { readonly id: string; readonly label: string; readonly detail?: string };

export type ChoiceRequest = {
  readonly title: string;
  readonly items: ReadonlyArray<ChoiceItem>;
  readonly initialId?: string;
};

export type ChoiceStep = { readonly kind: "continue" } | { readonly kind: "done"; readonly id: string | undefined };

/** A modal selector shares the composer's key owner instead of adding a reader. */
export function createChoice(request: ChoiceRequest) {
  let query = "";
  let selected = Math.max(0, request.items.findIndex(item => item.id === request.initialId));
  const items = () => request.items.filter(item => `${item.label} ${item.detail ?? ""}`.toLowerCase().includes(query.toLowerCase()));

  return {
    rows(columns: number): ReadonlyArray<string> {
      const filtered = items();
      selected = Math.min(selected, Math.max(0, filtered.length - 1));
      const start = Math.max(0, selected - 4);
      return [request.title, `筛选：${query || "输入文字搜索"}`, ...filtered.slice(start, start + 8).map((item, index) =>
        `${start + index === selected ? "›" : " "} ${item.label}${item.detail === undefined ? "" : ` · ${item.detail}`}`),
      ...(filtered.length === 0 ? ["  没有匹配项"] : []), "↑↓ 选择 · Enter 确认 · Esc 返回"].map(row => fitText(row, columns - 1));
    },

    key(event: KeyEvent): ChoiceStep {
      if (event.kind === "escape" || (event.kind === "ctrl" && ["c", "d"].includes(event.name))) return { kind: "done", id: undefined };

      const filtered = items();

      if (event.kind === "enter") return filtered[selected] === undefined ? { kind: "continue" } : { kind: "done", id: filtered[selected]!.id };

      if (event.kind === "up") selected = (selected - 1 + filtered.length) % Math.max(1, filtered.length);

      if (event.kind === "down" || event.kind === "tab") selected = (selected + 1) % Math.max(1, filtered.length);

      if (event.kind === "char" || event.kind === "paste") {
        query += event.text;
        selected = 0;
      }

      if (event.kind === "backspace") {
        query = Array.from(query).slice(0, -1).join("");
        selected = 0;
      }

      return { kind: "continue" };
    },
  };
}
