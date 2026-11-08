import { displayWidth } from "./frame.js";

/** Clip on terminal columns; every panel uses the same CJK width contract. */
export function fitText(text: string, columns: number): string {
  const width = Math.max(0, columns);
  if (displayWidth(text) <= width) return text;

  if (width === 0) return "";

  let result = "";
  let used = 0;

  for (const character of text) {
    const size = displayWidth(character);
    if (used + size > width - 1) break;
    result += character;
    used += size;
  }

  return `${result}…`;
}

export function projectName(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/$/, "").split("/").at(-1) ?? path;
}
