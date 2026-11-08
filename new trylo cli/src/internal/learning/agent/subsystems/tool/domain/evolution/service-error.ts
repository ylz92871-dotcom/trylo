/** Stable, redacted diagnostics crossing a subsystem service boundary. */
export class ToolLearningServiceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ToolLearningServiceError";
  }
}
