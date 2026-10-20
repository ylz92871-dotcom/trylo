import type { FileAccessMode } from "../../ports/filesystem.js";
import type { ShellIsolation } from "../../ports/isolation.js";
import type { ShellKind } from "../../adapters/sandbox/shell-detect.js";

/** Independent, explicit decisions for target scope, interpreter and isolation. */
export type RunExecutionOptions = {
  readonly fileAccess?: FileAccessMode;
  readonly shell?: ShellKind | "auto" | "none";
  /** Host execution still requires per-call permission. */
  readonly shellIsolation?: ShellIsolation;
};
