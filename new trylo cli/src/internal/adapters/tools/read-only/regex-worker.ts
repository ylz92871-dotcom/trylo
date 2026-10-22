import { parentPort, workerData } from "node:worker_threads";

const port = parentPort;
if (port === null) throw new Error("regex_worker_requires_parent");
if (typeof workerData !== "object" || workerData === null ||
    !("pattern" in workerData) || typeof workerData.pattern !== "string" ||
    !("ignoreCase" in workerData) || typeof workerData.ignoreCase !== "boolean") {
  throw new Error("invalid_regex_worker_input");
}

let expression: RegExp | undefined;
try {
  expression = new RegExp(workerData.pattern, workerData.ignoreCase ? "i" : "");
  port.postMessage({ kind: "ready" });
} catch (error) {
  port.postMessage({ kind: "invalid_pattern", message: error instanceof Error ? error.message : String(error) });
}
const matcher = expression;
if (matcher !== undefined) port.on("message", (input: unknown) => {
  if (typeof input !== "object" || input === null || !("text" in input) || typeof input.text !== "string" ||
      !("limit" in input) || typeof input.limit !== "number" || !Number.isSafeInteger(input.limit) || input.limit < 1) {
    throw new Error("invalid_regex_scan_input");
  }
  const hits: { line: number; index: number }[] = [];
  const lines = input.text.split("\n");
  for (let line = 0; line < lines.length; line += 1) {
    const index = matcher.exec(lines[line] ?? "")?.index ?? -1;
    if (index >= 0) hits.push({ line, index });
    if (hits.length >= input.limit) break;
  }
  port.postMessage({ kind: "matches", hits });
});
