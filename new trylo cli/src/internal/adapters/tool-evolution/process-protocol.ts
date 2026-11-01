const READY_MARKER = "TRYLO_TOOL_READY:";
const RESULT_MARKER = "TRYLO_TOOL_RESULT:";
const MAX_RESULT_CHARS = 32_768;
// This is a fixed program for the confined child, not host process access.
// Capture protocol writers before loading generated code. The nonce rejects
// polluted/forged stdout frames; caller-owned samples remain the quality oracle.
export const RUNNER = String.raw`const runtime = require("node:process");
const write = require("node:fs").writeSync;
const stringify = JSON.stringify;
const nonce = require("node:crypto").randomBytes(24).toString("hex");
const settle = Function.call.bind(Promise.prototype.then);
const resolved = Promise.resolve.bind(Promise);
const input = JSON.parse(Buffer.from(runtime.argv[2], "base64").toString("utf8"));
const emit = body => write(1, "\nTRYLO_TOOL_RESULT:" + nonce + ":" + body + "\n");
const protocolError = () => emit('{"kind":"protocol_error"}');
const keys = Object.keys, prototype = Object.getPrototypeOf, plain = Object.prototype, isArray = Array.isArray, finite = Number.isFinite;
const freshSet = Set, has = Function.call.bind(Set.prototype.has), add = Function.call.bind(Set.prototype.add), remove = Function.call.bind(Set.prototype.delete);
function jsonValue(value, depth = 0, seen = new freshSet()) {
  if (depth > 16) throw new Error("result nesting limit");
  if (value === null || typeof value === "string" || typeof value === "boolean") return stringify(value);
  if (typeof value === "number" && finite(value)) return stringify(value);
  if (typeof value !== "object" || has(seen, value)) throw new Error("non-JSON result");
  const array = isArray(value);
  if (!array && prototype(value) !== plain && prototype(value) !== null) throw new Error("non-JSON object");
  add(seen, value);
  const names = array ? null : keys(value);
  let body = "";
  const length = array ? value.length : names.length;
  for (let i = 0; i < length; i++) {
    if (i > 0) body += ",";
    body += array ? jsonValue(value[i], depth + 1, seen) : stringify(names[i]) + ":" + jsonValue(value[names[i]], depth + 1, seen);
  }
  remove(seen, value);
  return array ? "[" + body + "]" : "{" + body + "}";
}
write(1, "\nTRYLO_TOOL_READY:" + nonce + "\n");
let invoked = false;
const execution = settle(resolved(), () => {
  const execute = require("./candidate.cjs");
  if (typeof execute !== "function") throw new Error("module.exports must be a function");
  invoked = true;
  return execute(input);
});
settle(execution, value => {
  try {
    const body = '{"kind":"value","value":' + jsonValue(value) + '}';
    if (body.length > 32768) return protocolError();
    emit(body);
  } catch { protocolError(); }
}, error => {
  if (!invoked) return protocolError();
  try { emit('{"kind":"error","code":' + stringify(typeof error?.code === "string" && error.code.length > 0 ? error.code.slice(0,200) : "tool_error") + '}'); }
  catch { protocolError(); }
});`;

export function readResult(stdout: string): unknown {
  const lines = stdout.split(/\r?\n/);
  const ready = lines.filter(line => line.startsWith(READY_MARKER));
  const results = lines.filter(line => line.startsWith(RESULT_MARKER));
  if (ready.length !== 1 || results.length !== 1) return undefined;
  const nonce = ready[0]?.slice(READY_MARKER.length);
  const line = results[0];
  if (nonce === undefined || !/^[a-f0-9]{48}$/.test(nonce) || line === undefined) return undefined;
  const prefix = `${RESULT_MARKER}${nonce}:`;
  if (!line.startsWith(prefix) || line.length > MAX_RESULT_CHARS + prefix.length
    || lines.indexOf(ready[0] as string) > lines.indexOf(line)) return undefined;
  try {
    const value: unknown = JSON.parse(line.slice(prefix.length));
    if (typeof value !== "object" || value === null || !("kind" in value)) return undefined;
    const keys = Object.keys(value).sort().join(",");
    if (value.kind === "value" && keys === "kind,value") return value;
    if (value.kind === "error" && keys === "code,kind" && "code" in value && typeof value.code === "string"
      && value.code.length > 0 && value.code.length <= 200) return value;
    return undefined;
  } catch {
    return undefined;
  }
}
