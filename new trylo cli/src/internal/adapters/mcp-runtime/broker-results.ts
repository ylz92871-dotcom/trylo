import type { McpResourceListResult, McpResourceTemplatesResult, McpResourceReadResult, McpResource, McpResourceTemplate, McpResourceContent, McpToolOutcome, } from "../../ports/mcp-client.js";
import type { McpResourceCall, McpRuntimeCall } from "./pool.js";
import { object, record } from "./broker-contract.js";

function failure(value: unknown): value is {
    ok: false;
    code: string;
    detail: string;
} {
    return record(value) && value.ok === false && typeof value.code === "string" && typeof value.detail === "string";
}

function outcome(value: unknown): value is McpToolOutcome {
    if (!record(value))
        return false;

    if (value.outcome === "cancelled")
        return true;

    if (value.outcome === "error" || value.outcome === "unknown") {
        return typeof value.code === "string" && typeof value.message === "string";
    }

    return value.outcome === "result" && object(value.value) && typeof value.output === "string"
        && typeof value.truncated === "boolean" && (value.inlineImages === undefined
        || Array.isArray(value.inlineImages) && value.inlineImages.every(image => record(image)
            && typeof image.mimeType === "string" && typeof image.data === "string"));
}

// Broker IPC is untrusted input; validate the outcome before exposing port values.
export function callResult(value: unknown): McpRuntimeCall {
    if (failure(value))
        return value;
    if (record(value) && value.ok === true && outcome(value.outcome))
        return { ok: true, outcome: value.outcome };
    throw new Error("mcp_broker_invalid_result");
}

// Resource annotations remain untrusted after crossing the broker boundary.
function resourceBase(value: Record<string, unknown>): boolean {
    return typeof value.name === "string" && record(value.annotations) && value.annotationsTrust === "untrusted"
        && [value.title, value.description, value.mimeType].every(field => field === undefined || typeof field === "string");
}

function resource(value: unknown): value is McpResource {
    return record(value) && typeof value.uri === "string" && resourceBase(value);
}

function template(value: unknown): value is McpResourceTemplate {
    return record(value) && typeof value.uriTemplate === "string" && resourceBase(value);
}

function content(value: unknown): value is McpResourceContent {
    return record(value) && typeof value.uri === "string" && (value.mimeType === undefined || typeof value.mimeType === "string")
        && (value.kind === "text" && typeof value.text === "string"
            || value.kind === "binary" && typeof value.byteLength === "number" && Number.isSafeInteger(value.byteLength) && value.byteLength >= 0);
}

function result<T>(raw: unknown, guard: (value: unknown) => value is T): McpResourceCall<T> {
    if (failure(raw))
        return raw;
    if (record(raw) && raw.ok === true && guard(raw.value))
        return { ok: true, value: raw.value };
    throw new Error("mcp_broker_invalid_resource");
}

export function listResult(raw: unknown): McpResourceCall<McpResourceListResult> {
    return result(raw, (value): value is McpResourceListResult => record(value) && Array.isArray(value.resources)
        && value.resources.every(resource) && (value.nextCursor === undefined || typeof value.nextCursor === "string"));
}

export function templatesResult(raw: unknown): McpResourceCall<McpResourceTemplatesResult> {
    return result(raw, (value): value is McpResourceTemplatesResult => record(value) && Array.isArray(value.templates)
        && value.templates.every(template) && (value.nextCursor === undefined || typeof value.nextCursor === "string"));
}

export function readResult(raw: unknown): McpResourceCall<McpResourceReadResult> {
    return result(raw, (value): value is McpResourceReadResult => record(value) && Array.isArray(value.contents) && value.contents.every(content));
}
