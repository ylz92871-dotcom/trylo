/** Compatibility owner: method/tool learning relocation (2026-11-03).
 * Protected consumers: src/internal/integration/check-learning/v2/contracts.ts, src/internal/learning/check/v2/contracts.test.ts, src/internal/learning/check/v2/contracts.ts, src/internal/surface/cli/check-learning-runtime.ts, src/internal/surface/cli/check-learning-session.ts.
 * Remove during their separately assigned migration, once these imports use the subsystem entry.
 */
export * from "../../../agent/subsystems/tool/domain/evolution/execution.js";
