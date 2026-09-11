"use strict";
/**
 * Headless-safe types for the ManagedSession runtime core.
 *
 * This module MUST NOT import any Electron runtime package or any module that
 * statically loads `electron`. It only depends on `better-sqlite3` (via the
 * injected database handle), the headless-safe repositories, and shared types.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.toManagedEventPayload = toManagedEventPayload;
/**
 * Upgrade-safe accessor for a ManagedSession event payload in a decoupled
 * consumer (e.g. the daemon control-plane transport layer). Consumers should
 * NOT read the raw `payload` object they might receive from a transport; use
 * this to normalize to a plain object.
 */
function toManagedEventPayload(event) {
    if (!event)
        return {};
    const payload = event.payload;
    if (!payload)
        return {};
    if (typeof payload === "object" && !Array.isArray(payload))
        return payload;
    return {};
}
