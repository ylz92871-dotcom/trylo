import { CENTRAL_LEARNING_CHANGE_TOOL } from "./change-contract.js";

/** Metadata is a leaf so encoder/receipt/schema import cycles cannot read an
 * uninitialized binding. The function records a decision, never execution. */
export const CENTRAL_SINGLE_ACTION_TOOL_NAME = CENTRAL_LEARNING_CHANGE_TOOL;
export const CENTRAL_SINGLE_ACTION_TOOL_DESCRIPTION = "Submit a public learning action or related changes. This records a decision; it executes no business tool.";
