// Compatibility for the existing check-learning and tool hosts; shared transport retains its owner.
export * from "./artifact-worker.js";
export { createToolEvolutionWorker, TOOL_EVOLUTION_WORKER_INSTRUCTION } from "../../learning/agent/subsystems/tool/adapters/evolution/provider-worker.js";
