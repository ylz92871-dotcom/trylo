/** Public method-learning contracts and service; IO composition lives in ./adapters. */
export * from "./domain/contracts.js";
export * from "./port.js";
export {
  createMethodBoard,
  type MethodBoard,
  type MethodBoardOptions,
} from "./orchestration/board.js";
export type { ShadowVariant } from "./assets/archive.js";
