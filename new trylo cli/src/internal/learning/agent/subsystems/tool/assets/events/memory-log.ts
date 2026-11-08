import type { ToolingEvent } from "../../../../../../tooling/contract/types.js";

export function createMemoryLog(): {
  append: (event: Omit<ToolingEvent, "sequence"> & { sequence?: number }) => ToolingEvent;
  events: () => readonly ToolingEvent[];
} {
  const events: ToolingEvent[] = [];
  return {
    append(event) {
      const sequence = event.sequence ?? events.length + 1;
      const stored = { ...event, sequence } as ToolingEvent;
      events.push(stored);
      return stored;
    },
    events() {
      return [...events];
    },
  };
}

