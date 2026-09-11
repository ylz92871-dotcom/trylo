"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TRYLO_MANAGED_WORK_SYSTEM_PROMPT = exports.TRYLO_MANAGED_WORK_AGENT_NAME = exports.TRYLO_MANAGED_WORK_AGENT_ID = void 0;
exports.provisionTryloManagedWork = provisionTryloManagedWork;
exports.sanitizeInputRequestRespondParams = sanitizeInputRequestRespondParams;
exports.attachAgentDaemonTaskBridge = attachAgentDaemonTaskBridge;
exports.registerControlPlaneMethods = registerControlPlaneMethods;
const fs = __importStar(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const node_os_1 = __importDefault(require("node:os"));
const node_crypto_1 = require("node:crypto");
const protocol_1 = require("../electron/control-plane/protocol");
const settings_1 = require("../electron/control-plane/settings");
const types_1 = require("../shared/types");
const repositories_1 = require("../electron/database/repositories");
const search_1 = require("../electron/agent/search");
const llm_configure_1 = require("../electron/control-plane/llm-configure");
const managed_account_manager_1 = require("../electron/accounts/managed-account-manager");
const runtime_mode_1 = require("../electron/utils/runtime-mode");
const user_data_dir_1 = require("../electron/utils/user-data-dir");
const sanitize_1 = require("../electron/control-plane/sanitize");
const registerControlPlaneCoreMethods_1 = require("../electron/control-plane/registerControlPlaneCoreMethods");
const registerAgentSecurityMethods_1 = require("../electron/control-plane/registerAgentSecurityMethods");
const registerStrategicPlannerMethods_1 = require("../electron/control-plane/registerStrategicPlannerMethods");
const StrategicPlannerService_1 = require("../electron/control-plane/StrategicPlannerService");
const path_containment_1 = require("../electron/control-plane/path-containment");
const deployment_posture_1 = require("../electron/control-plane/deployment-posture");
const task_event_transport_1 = require("../electron/control-plane/task-event-transport");
const ManagedSessionRuntimeService_1 = require("../runtime/managed/ManagedSessionRuntimeService");
const repositories_2 = require("../electron/managed/repositories");
/**
 * Managed-work built-in agent identity (P1 provisioner).
 */
exports.TRYLO_MANAGED_WORK_AGENT_ID = "trylo-managed-work";
exports.TRYLO_MANAGED_WORK_AGENT_NAME = "Trylo Managed Work";
exports.TRYLO_MANAGED_WORK_SYSTEM_PROMPT = "You are a durable, background-capable work executor. " +
    "Complete the assigned objective in the workspace, produce concrete deliverables, " +
    "and clearly report what was done, what was produced, and any blockers.";
let __managedRuntimeService = null;
/**
 * Lazily construct a single ManagedSessionRuntimeService for the running daemon.
 * The daemon is protected by control-plane scopes at every registered method.
 * Inject that trust decision explicitly so the shared runtime never has an
 * implicit fail-open permission mode.
 */
function getManagedSessionRuntimeService(dbManager, agentDaemon) {
    if (!__managedRuntimeService) {
        __managedRuntimeService = new ManagedSessionRuntimeService_1.ManagedSessionRuntimeService(dbManager.getDatabase(), agentDaemon, {
            assertPermission: () => {
                // Control-plane methods require read/admin scope before reaching the runtime.
            },
        });
    }
    return __managedRuntimeService;
}
/**
 * Idempotently provision the built-in `trylo-managed-work` agent (executionMode:
 * solo) plus one default ManagedEnvironment per existing workspace. Safe to call
 * on every daemon boot: previously-created rows are left untouched.
 */
function provisionTryloManagedWork(dbManager) {
    const db = dbManager.getDatabase();
    const agentRepo = new repositories_2.ManagedAgentRepository(db);
    const versionRepo = new repositories_2.ManagedAgentVersionRepository(db);
    const environmentRepo = new repositories_2.ManagedEnvironmentRepository(db);
    const workspaceRepo = new repositories_1.WorkspaceRepository(db);
    const result = {
        agentId: exports.TRYLO_MANAGED_WORK_AGENT_ID,
        createdAgent: false,
        createdEnvironments: [],
    };
    let agent = agentRepo.findById(exports.TRYLO_MANAGED_WORK_AGENT_ID);
    if (!agent) {
        agent = agentRepo.create({
            id: exports.TRYLO_MANAGED_WORK_AGENT_ID,
            name: exports.TRYLO_MANAGED_WORK_AGENT_NAME,
            description: "Built-in durable background work executor provisioned by the headless daemon (P1, solo).",
            status: "active",
            currentVersion: 1,
        });
        versionRepo.create({
            agentId: exports.TRYLO_MANAGED_WORK_AGENT_ID,
            version: 1,
            systemPrompt: exports.TRYLO_MANAGED_WORK_SYSTEM_PROMPT,
            executionMode: "solo",
            runtimeDefaults: {
                allowUserInput: true,
                maxTurns: 30,
                autonomousMode: false,
            },
            createdAt: Date.now(),
        });
        result.createdAgent = true;
    }
    // One default environment per workspace, keyed by a stable id.
    const workspaces = workspaceRepo.findAll();
    for (const workspace of workspaces) {
        const envId = `managed-env-${workspace.id}`;
        if (environmentRepo.findById(envId))
            continue;
        environmentRepo.create({
            id: envId,
            name: `Managed work environment — ${workspace.name}`,
            kind: "cowork_local",
            revision: 1,
            status: "active",
            config: {
                workspaceId: workspace.id,
                enableShell: Boolean(workspace.permissions?.shell) || false,
                enableBrowser: false,
                enableComputerUse: false,
            },
        });
        result.createdEnvironments.push(envId);
    }
    return result;
}
/* Headless-safe sanitizers for the ManagedAgent/Environment/Session methods. */
function sanitizeManagedIdParam(params, key) {
    const p = (params ?? {});
    const id = typeof p[key] === "string" ? p[key].trim() : "";
    if (!id)
        throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: `${key} is required` };
    return { id };
}
function sanitizeManagedListParams(params, statuses = []) {
    const p = (params ?? {});
    const rawLimit = typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.floor(p.limit) : 100;
    const rawOffset = typeof p.offset === "number" && Number.isFinite(p.offset) ? Math.floor(p.offset) : 0;
    const workspaceId = typeof p.workspaceId === "string" ? p.workspaceId.trim() || undefined : undefined;
    const rawStatus = typeof p.status === "string" ? p.status.trim() || undefined : undefined;
    const status = rawStatus && statuses.includes(rawStatus) ? rawStatus : undefined;
    return {
        limit: Math.min(Math.max(rawLimit, 1), 500),
        offset: Math.max(rawOffset, 0),
        ...(workspaceId ? { workspaceId } : {}),
        ...(status ? { status } : {}),
    };
}
function sanitizeManagedSessionCreateParams(params) {
    const p = (params ?? {});
    const agentId = typeof p.agentId === "string" ? p.agentId.trim() : "";
    const environmentId = typeof p.environmentId === "string" ? p.environmentId.trim() : "";
    const title = typeof p.title === "string" ? p.title.trim() : "";
    if (!agentId)
        throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "agentId is required" };
    if (!environmentId)
        throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "environmentId is required" };
    if (!title)
        throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "title is required" };
    let initialEvent;
    const rawEvent = p.initialEvent;
    if (rawEvent && typeof rawEvent === "object") {
        const content = Array.isArray(rawEvent.content) ? rawEvent.content : [];
        const normalizedContent = content
            .filter((item) => item && typeof item === "object")
            .map((item) => {
            const type = item.type === "file" ? "file" : "text";
            if (type === "file") {
                return {
                    type: "file",
                    artifactId: typeof item.artifactId === "string" ? item.artifactId : "",
                };
            }
            return { type: "text", text: typeof item.text === "string" ? item.text : "" };
        });
        initialEvent = { type: "user.message", content: normalizedContent };
    }
    return { agentId, environmentId, title, ...(initialEvent ? { initialEvent } : {}) };
}
function sanitizeManagedSessionIdParams(params) {
    const { id } = sanitizeManagedIdParam(params, "sessionId");
    return { sessionId: id };
}
function sanitizeManagedEnvironmentIdParams(params) {
    const { id } = sanitizeManagedIdParam(params, "environmentId");
    return { environmentId: id };
}
function sanitizeManagedSessionEventsParams(params) {
    const { sessionId } = sanitizeManagedSessionIdParams(params);
    const p = (params ?? {});
    const rawLimit = typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.floor(p.limit) : 500;
    return { sessionId, limit: Math.min(Math.max(rawLimit, 1), 5000) };
}
function sanitizeManagedSessionSendEventParams(params) {
    const { sessionId } = sanitizeManagedSessionIdParams(params);
    const p = (params ?? {});
    const rawEvent = p.event;
    if (!rawEvent || typeof rawEvent !== "object") {
        throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "event is required" };
    }
    const type = rawEvent.type;
    if (type === "user.message") {
        const content = Array.isArray(rawEvent.content) ? rawEvent.content : [];
        const normalizedContent = content
            .filter((item) => item && typeof item === "object")
            .map((item) => {
            const itemType = item.type === "file" ? "file" : "text";
            if (itemType === "file") {
                return { type: "file", artifactId: typeof item.artifactId === "string" ? item.artifactId : "" };
            }
            return { type: "text", text: typeof item.text === "string" ? item.text : "" };
        });
        return { sessionId, event: { type: "user.message", content: normalizedContent } };
    }
    if (type === "input.received") {
        return {
            sessionId,
            event: {
                type: "input.received",
                requestId: typeof rawEvent.requestId === "string" ? rawEvent.requestId : "",
                ...(rawEvent.answers && typeof rawEvent.answers === "object"
                    ? { answers: rawEvent.answers }
                    : {}),
                ...(typeof rawEvent.status === "string" ? { status: rawEvent.status } : {}),
            },
        };
    }
    throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: `Unsupported managed session event type: ${type}` };
}
const MANAGED_SESSION_STATUSES = [
    "pending",
    "running",
    "awaiting_input",
    "interrupted",
    "completed",
    "failed",
    "cancelled",
];
function requireScope(client, scope) {
    if (!client?.hasScope?.(scope)) {
        throw { code: protocol_1.ErrorCodes.UNAUTHORIZED, message: `Missing required scope: ${scope}` };
    }
}
function sanitizeTaskCreateParams(params) {
    const p = (params ?? {});
    const title = typeof p.title === "string" ? p.title.trim() : "";
    const prompt = typeof p.prompt === "string" ? p.prompt.trim() : "";
    const workspaceId = typeof p.workspaceId === "string" ? p.workspaceId.trim() : "";
    const assignedAgentRoleId = typeof p.assignedAgentRoleId === "string" ? p.assignedAgentRoleId.trim() : "";
    const budgetTokens = typeof p.budgetTokens === "number" && Number.isFinite(p.budgetTokens)
        ? Math.max(0, Math.floor(p.budgetTokens))
        : undefined;
    const budgetCost = typeof p.budgetCost === "number" && Number.isFinite(p.budgetCost)
        ? Math.max(0, p.budgetCost)
        : undefined;
    const shellAccess = p.shellAccess === true;
    const agentConfig = (() => {
        if (!p.agentConfig || typeof p.agentConfig !== "object")
            return undefined;
        return p.agentConfig;
    })();
    if (!title)
        throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "title is required" };
    if (!prompt)
        throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "prompt is required" };
    if (!workspaceId)
        throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "workspaceId is required" };
    return {
        title,
        prompt,
        workspaceId,
        ...(assignedAgentRoleId ? { assignedAgentRoleId } : {}),
        ...(agentConfig ? { agentConfig } : {}),
        ...(budgetTokens !== undefined ? { budgetTokens } : {}),
        ...(budgetCost !== undefined ? { budgetCost } : {}),
        ...(shellAccess ? { shellAccess } : {}),
    };
}
function sanitizeTaskIdParams(params) {
    const p = (params ?? {});
    const taskId = typeof p.taskId === "string" ? p.taskId.trim() : "";
    if (!taskId)
        throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "taskId is required" };
    return { taskId };
}
function sanitizeApprovalRespondParams(params) {
    const p = (params ?? {});
    const approvalId = typeof p.approvalId === "string" ? p.approvalId.trim() : "";
    const approved = p.approved;
    if (!approvalId)
        throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "approvalId is required" };
    if (typeof approved !== "boolean")
        throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "approved is required (boolean)" };
    return { approvalId, approved };
}
function sanitizeInputRequestListParams(params) {
    const p = (params ?? {});
    const rawLimit = typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.floor(p.limit) : 100;
    const rawOffset = typeof p.offset === "number" && Number.isFinite(p.offset) ? Math.floor(p.offset) : 0;
    const limit = Math.min(Math.max(rawLimit, 1), 500);
    const offset = Math.max(rawOffset, 0);
    const taskId = typeof p.taskId === "string" ? p.taskId.trim() : "";
    const rawStatus = typeof p.status === "string" ? p.status.trim() : "";
    const status = rawStatus === "pending" || rawStatus === "submitted" || rawStatus === "dismissed"
        ? rawStatus
        : undefined;
    return {
        limit,
        offset,
        ...(taskId ? { taskId } : {}),
        ...(status ? { status } : {}),
    };
}
function sanitizeInputRequestRespondParams(params) {
    const MAX_INPUT_REQUEST_OTHER_TEXT_LENGTH = 500000;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const keyRegex = /^[a-z][a-z0-9_]*$/;
    const p = (params ?? {});
    const requestId = typeof p.requestId === "string" ? p.requestId.trim() : "";
    const status = typeof p.status === "string" ? p.status.trim() : "";
    if (!requestId)
        throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "requestId is required" };
    if (!uuidRegex.test(requestId)) {
        throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "requestId must be a UUID" };
    }
    if (status !== "submitted" && status !== "dismissed") {
        throw {
            code: protocol_1.ErrorCodes.INVALID_PARAMS,
            message: "status is required and must be 'submitted' or 'dismissed'",
        };
    }
    const answers = p.answers;
    if (answers !== undefined &&
        (!answers || typeof answers !== "object" || Array.isArray(answers))) {
        throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "answers must be an object when provided" };
    }
    let normalizedAnswers = undefined;
    if (answers && typeof answers === "object" && !Array.isArray(answers)) {
        normalizedAnswers = {};
        for (const [rawKey, rawValue] of Object.entries(answers)) {
            const key = String(rawKey || "").trim();
            if (!keyRegex.test(key)) {
                throw {
                    code: protocol_1.ErrorCodes.INVALID_PARAMS,
                    message: `answers key "${rawKey}" must match /^[a-z][a-z0-9_]*$/`,
                };
            }
            if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
                throw {
                    code: protocol_1.ErrorCodes.INVALID_PARAMS,
                    message: `answers["${key}"] must be an object`,
                };
            }
            const value = rawValue;
            const optionLabelRaw = value.optionLabel;
            const otherTextRaw = value.otherText;
            const normalizedValue = {};
            if (optionLabelRaw !== undefined) {
                if (typeof optionLabelRaw !== "string") {
                    throw {
                        code: protocol_1.ErrorCodes.INVALID_PARAMS,
                        message: `answers["${key}"].optionLabel must be a string`,
                    };
                }
                const optionLabel = optionLabelRaw.trim();
                if (optionLabel.length < 1 || optionLabel.length > 200) {
                    throw {
                        code: protocol_1.ErrorCodes.INVALID_PARAMS,
                        message: `answers["${key}"].optionLabel must be 1..200 chars`,
                    };
                }
                normalizedValue.optionLabel = optionLabel;
            }
            if (otherTextRaw !== undefined) {
                if (typeof otherTextRaw !== "string") {
                    throw {
                        code: protocol_1.ErrorCodes.INVALID_PARAMS,
                        message: `answers["${key}"].otherText must be a string`,
                    };
                }
                const otherText = otherTextRaw.trim();
                if (otherText.length < 1 || otherText.length > MAX_INPUT_REQUEST_OTHER_TEXT_LENGTH) {
                    throw {
                        code: protocol_1.ErrorCodes.INVALID_PARAMS,
                        message: `answers["${key}"].otherText must be 1..${MAX_INPUT_REQUEST_OTHER_TEXT_LENGTH} chars`,
                    };
                }
                normalizedValue.otherText = otherText;
            }
            normalizedAnswers[key] = normalizedValue;
        }
    }
    return {
        requestId,
        status,
        ...(normalizedAnswers ? { answers: normalizedAnswers } : {}),
    };
}
function sanitizeTaskListParams(params) {
    const p = (params ?? {});
    const rawLimit = typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.floor(p.limit) : 100;
    const rawOffset = typeof p.offset === "number" && Number.isFinite(p.offset) ? Math.floor(p.offset) : 0;
    const limit = Math.min(Math.max(rawLimit, 1), 500);
    const offset = Math.max(rawOffset, 0);
    const workspaceId = typeof p.workspaceId === "string" ? p.workspaceId.trim() : "";
    return { limit, offset, ...(workspaceId ? { workspaceId } : {}) };
}
function sanitizeApprovalListParams(params) {
    const p = (params ?? {});
    const rawLimit = typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.floor(p.limit) : 100;
    const rawOffset = typeof p.offset === "number" && Number.isFinite(p.offset) ? Math.floor(p.offset) : 0;
    const limit = Math.min(Math.max(rawLimit, 1), 500);
    const offset = Math.max(rawOffset, 0);
    const taskId = typeof p.taskId === "string" ? p.taskId.trim() : "";
    return { limit, offset, ...(taskId ? { taskId } : {}) };
}
function sanitizeTaskEventsParams(params) {
    const p = (params ?? {});
    const { taskId } = sanitizeTaskIdParams(params);
    const rawLimit = typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.floor(p.limit) : 200;
    const limit = Math.min(Math.max(rawLimit, 1), 2000);
    return { taskId, limit };
}
function sanitizeWorkspaceIdParams(params) {
    const p = (params ?? {});
    const workspaceId = typeof p.workspaceId === "string" ? p.workspaceId.trim() : "";
    if (!workspaceId)
        throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "workspaceId is required" };
    return { workspaceId };
}
function sanitizeWorkspaceCreateParams(params) {
    const p = (params ?? {});
    const name = typeof p.name === "string" ? p.name.trim() : "";
    const rawPath = typeof p.path === "string" ? p.path.trim() : "";
    if (!name)
        throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "name is required" };
    if (!rawPath)
        throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "path is required" };
    const home = node_os_1.default.homedir();
    const expanded = rawPath === "~" ? home : rawPath.startsWith("~/") ? node_path_1.default.join(home, rawPath.slice(2)) : rawPath;
    if (!node_path_1.default.isAbsolute(expanded)) {
        throw {
            code: protocol_1.ErrorCodes.INVALID_PARAMS,
            message: "path must be an absolute path (or start with ~/)",
        };
    }
    return { name, path: node_path_1.default.resolve(expanded) };
}
function sanitizeChannelIdParams(params) {
    const p = (params ?? {});
    const channelId = typeof p.channelId === "string" ? p.channelId.trim() : "";
    if (!channelId)
        throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "channelId is required" };
    return { channelId };
}
function sanitizeChannelCreateParams(params) {
    const p = (params ?? {});
    const type = typeof p.type === "string" ? p.type.trim() : "";
    const name = typeof p.name === "string" ? p.name.trim() : "";
    const enabled = typeof p.enabled === "boolean" ? p.enabled : false;
    const config = p.config && typeof p.config === "object" ? p.config : {};
    const securityConfigRaw = p.securityConfig && typeof p.securityConfig === "object"
        ? p.securityConfig
        : {};
    if (!type)
        throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "type is required" };
    if (!name)
        throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "name is required" };
    // Provide safe defaults for security config if not specified.
    const defaults = {
        mode: "pairing",
        pairingCodeTTL: 300,
        maxPairingAttempts: 5,
        rateLimitPerMinute: 30,
    };
    const mode = typeof securityConfigRaw.mode === "string" ? securityConfigRaw.mode : undefined;
    const normalizedMode = mode === "open" || mode === "allowlist" || mode === "pairing" ? mode : defaults.mode;
    const allowedUsers = Array.isArray(securityConfigRaw.allowedUsers)
        ? securityConfigRaw.allowedUsers.filter((x) => typeof x === "string")
        : undefined;
    const securityConfig = {
        ...defaults,
        ...securityConfigRaw,
        mode: normalizedMode,
        ...(allowedUsers ? { allowedUsers } : {}),
    };
    return { type, name, enabled, config, securityConfig };
}
function sanitizeChannelUpdateParams(params) {
    const p = (params ?? {});
    const channelId = typeof p.channelId === "string" ? p.channelId.trim() : "";
    if (!channelId)
        throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "channelId is required" };
    const updates = {};
    if (p.name !== undefined) {
        if (typeof p.name !== "string" || !p.name.trim())
            throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "name must be a non-empty string" };
        updates.name = p.name.trim();
    }
    if (p.config !== undefined) {
        if (!p.config || typeof p.config !== "object") {
            throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "config must be an object" };
        }
        updates.config = p.config;
    }
    if (p.securityConfig !== undefined) {
        if (!p.securityConfig || typeof p.securityConfig !== "object") {
            throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "securityConfig must be an object" };
        }
        updates.securityConfig = p.securityConfig;
    }
    return { channelId, updates };
}
function sanitizeAccountListParams(params) {
    const p = (params ?? {});
    const includeSecrets = p.includeSecrets === true;
    const provider = typeof p.provider === "string" ? p.provider.trim() : "";
    const status = typeof p.status === "string" ? p.status.trim().toLowerCase() : "";
    const allowedStatuses = [
        "draft",
        "pending_signup",
        "pending_verification",
        "active",
        "blocked",
        "disabled",
        "error",
    ];
    const normalizedStatus = allowedStatuses.includes(status)
        ? status
        : undefined;
    return {
        includeSecrets,
        ...(provider ? { provider } : {}),
        ...(normalizedStatus ? { status: normalizedStatus } : {}),
    };
}
function sanitizeAccountGetParams(params) {
    const p = (params ?? {});
    const accountId = typeof p.accountId === "string" ? p.accountId.trim() : "";
    if (!accountId)
        throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "accountId is required" };
    return { accountId, includeSecrets: p.includeSecrets === true };
}
function sanitizeAccountUpsertParams(params) {
    const p = (params ?? {});
    if (!p || typeof p !== "object") {
        throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "params must be an object" };
    }
    const result = {};
    if (typeof p.id === "string" && p.id.trim()) {
        result.id = p.id.trim();
    }
    if (typeof p.provider === "string" && p.provider.trim()) {
        result.provider = p.provider.trim();
    }
    if (p.label !== undefined) {
        if (typeof p.label !== "string") {
            throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "label must be a string" };
        }
        result.label = p.label;
    }
    if (p.status !== undefined) {
        if (typeof p.status !== "string") {
            throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "status must be a string" };
        }
        result.status = p.status;
    }
    if (p.signupUrl !== undefined) {
        if (typeof p.signupUrl !== "string") {
            throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "signupUrl must be a string" };
        }
        result.signupUrl = p.signupUrl;
    }
    if (p.dashboardUrl !== undefined) {
        if (typeof p.dashboardUrl !== "string") {
            throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "dashboardUrl must be a string" };
        }
        result.dashboardUrl = p.dashboardUrl;
    }
    if (p.docsUrl !== undefined) {
        if (typeof p.docsUrl !== "string") {
            throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "docsUrl must be a string" };
        }
        result.docsUrl = p.docsUrl;
    }
    if (p.notes !== undefined) {
        if (typeof p.notes !== "string") {
            throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "notes must be a string" };
        }
        result.notes = p.notes;
    }
    if (p.lastError !== undefined) {
        if (typeof p.lastError !== "string") {
            throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "lastError must be a string" };
        }
        result.lastError = p.lastError;
    }
    if (p.lastVerifiedAt !== undefined) {
        if (typeof p.lastVerifiedAt !== "number" || !Number.isFinite(p.lastVerifiedAt)) {
            throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "lastVerifiedAt must be a number" };
        }
        result.lastVerifiedAt = p.lastVerifiedAt;
    }
    if (p.metadata !== undefined) {
        if (!p.metadata || typeof p.metadata !== "object" || Array.isArray(p.metadata)) {
            throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "metadata must be an object" };
        }
        result.metadata = p.metadata;
    }
    if (p.secrets !== undefined) {
        if (!p.secrets || typeof p.secrets !== "object" || Array.isArray(p.secrets)) {
            throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "secrets must be an object" };
        }
        result.secrets = p.secrets;
    }
    if (p.clearSecrets !== undefined) {
        if (typeof p.clearSecrets !== "boolean") {
            throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "clearSecrets must be a boolean" };
        }
        result.clearSecrets = p.clearSecrets;
    }
    if (!result.id && !result.provider) {
        throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "provider is required for new accounts" };
    }
    return result;
}
function sanitizeAccountRemoveParams(params) {
    const p = (params ?? {});
    const accountId = typeof p.accountId === "string" ? p.accountId.trim() : "";
    if (!accountId)
        throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "accountId is required" };
    return { accountId };
}
function maskSecretString(value) {
    const trimmed = value.trim();
    if (!trimmed)
        return "";
    if (trimmed.length <= 8)
        return "[redacted]";
    return `${trimmed.slice(0, 2)}...${trimmed.slice(-4)}`;
}
function redactObjectSecrets(input, depth = 0) {
    if (depth > 8)
        return "[truncated]";
    if (input === null || input === undefined)
        return input;
    if (typeof input === "string")
        return input;
    if (typeof input !== "object")
        return input;
    if (Array.isArray(input))
        return input.map((x) => redactObjectSecrets(x, depth + 1));
    const obj = input;
    const out = {};
    const secretKeyRe = /(token|secret|password|apiKey|accessKey|privateKey|signing|oauth)/i;
    for (const [k, v] of Object.entries(obj)) {
        if (secretKeyRe.test(k) && typeof v === "string") {
            out[k] = maskSecretString(v);
            continue;
        }
        out[k] = redactObjectSecrets(v, depth + 1);
    }
    return out;
}
const MAX_BROADCAST_STRING_CHARS = 2000;
const MAX_BROADCAST_ARRAY_ITEMS = 50;
const MAX_BROADCAST_OBJECT_KEYS = 50;
const MAX_BROADCAST_DEPTH = 3;
const SENSITIVE_KEY_RE = /(token|api[_-]?key|secret|password|authorization)/i;
const ALWAYS_REDACT_KEY_RE = /^(prompt|systemPrompt)$/i;
function truncateForBroadcastKey(value, key) {
    // Allow longer message bodies, but keep other fields short by default.
    const maxChars = key === "message" ? 12000 : MAX_BROADCAST_STRING_CHARS;
    if (value.length <= maxChars)
        return value;
    return value.slice(0, maxChars) + `\n\n[... truncated (${value.length} chars) ...]`;
}
function sanitizeForBroadcast(value, depth = 0, key) {
    if (depth > MAX_BROADCAST_DEPTH) {
        return "[... truncated ...]";
    }
    if (value === null || value === undefined)
        return value;
    if (typeof value === "string")
        return truncateForBroadcastKey(value, key);
    if (typeof value === "number" || typeof value === "boolean")
        return value;
    if (Array.isArray(value)) {
        const next = value
            .slice(0, MAX_BROADCAST_ARRAY_ITEMS)
            .map((item) => sanitizeForBroadcast(item, depth + 1));
        if (value.length > MAX_BROADCAST_ARRAY_ITEMS) {
            next.push(`[... ${value.length - MAX_BROADCAST_ARRAY_ITEMS} more items truncated ...]`);
        }
        return next;
    }
    if (typeof value === "object") {
        const obj = value;
        const keys = Object.keys(obj);
        const out = {};
        for (const k of keys.slice(0, MAX_BROADCAST_OBJECT_KEYS)) {
            if (ALWAYS_REDACT_KEY_RE.test(k) || SENSITIVE_KEY_RE.test(k)) {
                out[k] = "[REDACTED]";
                continue;
            }
            out[k] = sanitizeForBroadcast(obj[k], depth + 1, k);
        }
        if (keys.length > MAX_BROADCAST_OBJECT_KEYS) {
            out.__truncated_keys__ = keys.length - MAX_BROADCAST_OBJECT_KEYS;
        }
        return out;
    }
    try {
        return truncateForBroadcastKey(String(value));
    }
    catch {
        return "[unserializable]";
    }
}
function getCoworkVersionFromNearestPackageJson() {
    // Try to find a package.json by walking up from this compiled file's directory.
    // Works for both dist/electron/... and dist/daemon/... layouts.
    let dir = __dirname;
    for (let i = 0; i < 10; i++) {
        const candidate = node_path_1.default.join(dir, "package.json");
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const pkg = require(candidate);
            const version = typeof pkg?.version === "string" ? pkg.version.trim() : "";
            if (version)
                return version;
        }
        catch {
            // ignore
        }
        const parent = node_path_1.default.dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return undefined;
}
function attachAgentDaemonTaskBridge(server, daemon) {
    const allowlist = [
        "timeline_group_started",
        "timeline_group_finished",
        "timeline_step_started",
        "timeline_step_updated",
        "timeline_step_finished",
        "timeline_evidence_attached",
        "timeline_artifact_emitted",
        "timeline_command_output",
        "timeline_error",
    ];
    // Backing-task event types that additionally stream into managed sessions.
    const managedBridgeEventTypes = [
        "task_status",
        "task_queued",
        "task_running",
        "task_paused",
        "task_resumed",
        "task_cancelled",
        "task_interrupted",
        "task_completed",
        "task_failed",
        "user_message",
        "assistant_message",
        "tool_call",
        "tool_result",
        "input_request_created",
        "error",
    ];
    const unsubscribes = [];
    // Tracks per-task mirror subscriptions registered while a matching managed
    // session exists, so we only bridge backing tasks that are managed sessions.
    const handledManagedTaskIds = new Set();
    const mirrorManagedTaskEvent = (evt) => {
        try {
            const managed = __managedRuntimeService;
            if (!managed)
                return;
            const taskId = typeof evt?.taskId === "string" ? evt.taskId : "";
            if (!taskId)
                return;
            if (!handledManagedTaskIds.has(taskId)) {
                // Only bother bridging if this task is a managed session's backing task.
                const sessions = managed.listSessions({ limit: 200 });
                if (!sessions.some((s) => s.backingTaskId === taskId))
                    return;
                handledManagedTaskIds.add(taskId);
            }
            const payload = evt?.payload && typeof evt.payload === "object" && !Array.isArray(evt.payload)
                ? { ...evt.payload }
                : {};
            const sanitizedPayload = sanitizeForBroadcast(payload);
            const bridged = managed.bridgeTaskEventNotification(taskId, {
                eventId: typeof evt?.eventId === "string" ? evt.eventId : undefined,
                timestamp: typeof evt?.timestamp === "number" && Number.isFinite(evt.timestamp) ? evt.timestamp : Date.now(),
                type: typeof evt?.type === "string" ? evt.type : "",
                payload: sanitizedPayload,
                status: typeof evt?.status === "string" ? evt.status : undefined,
            });
            if (!bridged.session)
                return;
            server.broadcastToOperators(protocol_1.Events.MANAGED_SESSION_UPDATED, {
                sessionId: bridged.session.id,
                session: bridged.session,
            });
            if (bridged.appended) {
                server.broadcastToOperators(protocol_1.Events.MANAGED_SESSION_EVENT, {
                    sessionId: bridged.session.id,
                    event: bridged.appended,
                });
            }
            if (bridged.session.status === "completed") {
                server.broadcastToOperators(protocol_1.Events.MANAGED_SESSION_COMPLETED, {
                    sessionId: bridged.session.id,
                    session: bridged.session,
                });
            }
            else if (bridged.session.status === "failed") {
                server.broadcastToOperators(protocol_1.Events.MANAGED_SESSION_FAILED, {
                    sessionId: bridged.session.id,
                    session: bridged.session,
                });
            }
        }
        catch (error) {
            console.error("[ControlPlane] Failed to mirror managed session event:", error);
        }
    };
    for (const eventType of allowlist) {
        const handler = (evt) => {
            try {
                const taskId = typeof evt?.taskId === "string" ? evt.taskId : "";
                if (!taskId)
                    return;
                const payload = evt?.payload && typeof evt.payload === "object" && !Array.isArray(evt.payload)
                    ? { ...evt.payload }
                    : {};
                if (eventType === "timeline_step_updated" && typeof payload?.message === "string") {
                    payload.message = truncateForBroadcastKey(payload.message, "message");
                }
                if (eventType === "timeline_command_output" && typeof payload?.output === "string") {
                    payload.output = truncateForBroadcastKey(payload.output, "message");
                }
                const sanitizedPayload = sanitizeForBroadcast(payload);
                server.broadcastToOperators(protocol_1.Events.TASK_EVENT, {
                    taskId,
                    type: eventType,
                    payload: sanitizedPayload,
                    timestamp: typeof evt?.timestamp === "number" && Number.isFinite(evt.timestamp)
                        ? evt.timestamp
                        : Date.now(),
                    schemaVersion: 2,
                    eventId: typeof evt?.eventId === "string" ? evt.eventId : undefined,
                    seq: typeof evt?.seq === "number" ? evt.seq : undefined,
                    ts: typeof evt?.ts === "number" ? evt.ts : undefined,
                    status: typeof evt?.status === "string" ? evt.status : undefined,
                    stepId: typeof evt?.stepId === "string" ? evt.stepId : undefined,
                    groupId: typeof evt?.groupId === "string" ? evt.groupId : undefined,
                    actor: typeof evt?.actor === "string" ? evt.actor : undefined,
                });
            }
            catch (error) {
                console.error("[ControlPlane] Failed to broadcast task event:", error);
            }
        };
        daemon.on(eventType, handler);
        unsubscribes.push(() => daemon.off(eventType, handler));
    }
    // Bridge backing-task events into managed sessions. Uses a separate handler
    // per event type so it stays independent of the operator broadcast path.
    for (const eventType of managedBridgeEventTypes) {
        const handler = (evt) => mirrorManagedTaskEvent(evt);
        daemon.on(eventType, handler);
        unsubscribes.push(() => daemon.off(eventType, handler));
    }
    return () => {
        for (const off of unsubscribes)
            off();
    };
}
function registerControlPlaneMethods(server, deps) {
    const db = deps.dbManager.getDatabase();
    const taskRepo = new repositories_1.TaskRepository(db);
    const workspaceRepo = new repositories_1.WorkspaceRepository(db);
    const approvalRepo = new repositories_1.ApprovalRepository(db);
    const inputRequestRepo = new repositories_1.InputRequestRepository(db);
    const eventRepo = new repositories_1.TaskEventRepository(db);
    const channelRepo = new repositories_1.ChannelRepository(db);
    const agentDaemon = deps.agentDaemon;
    const channelGateway = deps.channelGateway;
    const isAdminClient = (client) => !!client?.hasScope?.("admin");
    const redactWorkspaceForRead = (workspace) => ({
        id: workspace.id,
        name: workspace.name,
        createdAt: workspace.createdAt,
        lastUsedAt: workspace.lastUsedAt,
    });
    const redactTaskForRead = (task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        workspaceId: task.workspaceId,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        completedAt: task.completedAt,
        parentTaskId: task.parentTaskId,
        agentType: task.agentType,
        depth: task.depth,
        assignedAgentRoleId: task.assignedAgentRoleId,
        boardColumn: task.boardColumn,
        priority: task.priority,
        labels: task.labels,
        dueDate: task.dueDate,
    });
    const redactChannelForRead = (channel) => ({
        id: channel.id,
        type: channel.type,
        name: channel.name,
        enabled: channel.enabled,
        status: channel.status,
        botUsername: channel.botUsername,
        securityConfig: channel.securityConfig ? { mode: channel.securityConfig.mode } : undefined,
        createdAt: channel.createdAt,
        updatedAt: channel.updatedAt,
    });
    (0, registerControlPlaneCoreMethods_1.registerControlPlaneCoreMethods)({
        server,
        db,
        requireScope,
    });
    (0, registerAgentSecurityMethods_1.registerAgentSecurityMethods)({
        server,
        requireScope,
    });
    (0, registerStrategicPlannerMethods_1.registerStrategicPlannerMethods)({
        server,
        plannerService: (0, StrategicPlannerService_1.getStrategicPlannerService)(),
        requireScope,
    });
    // --- Managed Agents / Environments / Sessions (headless core) ---
    const managedSessions = getManagedSessionRuntimeService(deps.dbManager, agentDaemon);
    const redactManagedEnvironmentForRead = (environment) => ({
        ...environment,
        config: environment?.config
            ? {
                ...environment.config,
                credentialRefs: undefined,
                managedAccountRefs: undefined,
            }
            : environment?.config,
    });
    server.registerMethod(protocol_1.Methods.MANAGED_AGENT_LIST, async (client, params) => {
        requireScope(client, "read");
        const p = sanitizeManagedListParams(params);
        return { agents: managedSessions.listAgents({ limit: p.limit, offset: p.offset }) };
    });
    server.registerMethod(protocol_1.Methods.MANAGED_AGENT_GET, async (client, params) => {
        requireScope(client, "read");
        const { id: agentId } = sanitizeManagedIdParam(params, "agentId");
        const result = managedSessions.getAgent(agentId);
        if (!result) {
            throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: `Managed agent not found: ${agentId}` };
        }
        return { agent: result.agent, currentVersion: result.currentVersion };
    });
    server.registerMethod(protocol_1.Methods.MANAGED_ENVIRONMENT_LIST, async (client, params) => {
        requireScope(client, "read");
        const p = sanitizeManagedListParams(params);
        return {
            environments: managedSessions
                .listEnvironments({ limit: p.limit, offset: p.offset })
                .map(redactManagedEnvironmentForRead),
        };
    });
    server.registerMethod(protocol_1.Methods.MANAGED_ENVIRONMENT_GET, async (client, params) => {
        requireScope(client, "read");
        const { environmentId } = sanitizeManagedEnvironmentIdParams(params);
        const environment = managedSessions.getEnvironment(environmentId);
        if (!environment) {
            throw {
                code: protocol_1.ErrorCodes.INVALID_PARAMS,
                message: `Managed environment not found: ${environmentId}`,
            };
        }
        return { environment: redactManagedEnvironmentForRead(environment) };
    });
    server.registerMethod(protocol_1.Methods.MANAGED_SESSION_LIST, async (client, params) => {
        requireScope(client, "read");
        const p = sanitizeManagedListParams(params, MANAGED_SESSION_STATUSES);
        return {
            sessions: managedSessions.listSessions({
                limit: p.limit,
                offset: p.offset,
                ...(p.workspaceId ? { workspaceId: p.workspaceId } : {}),
                ...(p.status ? { status: p.status } : {}),
            }),
        };
    });
    server.registerMethod(protocol_1.Methods.MANAGED_SESSION_GET, async (client, params) => {
        requireScope(client, "read");
        const { sessionId } = sanitizeManagedSessionIdParams(params);
        const session = managedSessions.getSession(sessionId);
        if (!session) {
            throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: `Managed session not found: ${sessionId}` };
        }
        return { session };
    });
    server.registerMethod(protocol_1.Methods.MANAGED_SESSION_CREATE, async (client, params) => {
        requireScope(client, "admin");
        const validated = sanitizeManagedSessionCreateParams(params);
        const session = await managedSessions.createSession(validated);
        server.broadcastToOperators(protocol_1.Events.MANAGED_SESSION_CREATED, { sessionId: session.id, session });
        return { session };
    });
    server.registerMethod(protocol_1.Methods.MANAGED_SESSION_CANCEL, async (client, params) => {
        requireScope(client, "admin");
        const { sessionId } = sanitizeManagedSessionIdParams(params);
        const session = await managedSessions.cancelSession(sessionId);
        server.broadcastToOperators(protocol_1.Events.MANAGED_SESSION_UPDATED, { sessionId, session });
        return { session: session || null };
    });
    server.registerMethod(protocol_1.Methods.MANAGED_SESSION_RESUME, async (client, params) => {
        requireScope(client, "admin");
        const { sessionId } = sanitizeManagedSessionIdParams(params);
        const result = await managedSessions.resumeSession(sessionId);
        if (result.session) {
            server.broadcastToOperators(protocol_1.Events.MANAGED_SESSION_UPDATED, {
                sessionId,
                session: result.session,
            });
        }
        return result;
    });
    server.registerMethod(protocol_1.Methods.MANAGED_SESSION_SEND_EVENT, async (client, params) => {
        requireScope(client, "admin");
        const validated = sanitizeManagedSessionSendEventParams(params);
        const session = await managedSessions.sendEvent(validated.sessionId, validated.event);
        server.broadcastToOperators(protocol_1.Events.MANAGED_SESSION_UPDATED, {
            sessionId: validated.sessionId,
            session,
        });
        return { session: session || null };
    });
    server.registerMethod(protocol_1.Methods.MANAGED_SESSION_EVENTS_LIST, async (client, params) => {
        requireScope(client, "read");
        const { sessionId, limit } = sanitizeManagedSessionEventsParams(params);
        return {
            events: managedSessions.listSessionEvents(sessionId, limit).map((event) => ({
                ...event,
                payload: sanitizeForBroadcast(event.payload),
            })),
        };
    });
    // Managed Accounts (API-first signup/account lifecycle)
    server.registerMethod(protocol_1.Methods.ACCOUNT_LIST, async (client, params) => {
        requireScope(client, "read");
        const { includeSecrets, provider, status } = sanitizeAccountListParams(params);
        const accounts = managed_account_manager_1.ManagedAccountManager.list({ provider, status });
        const canIncludeSecrets = includeSecrets && isAdminClient(client);
        return {
            accounts: accounts.map((account) => managed_account_manager_1.ManagedAccountManager.toPublicView(account, canIncludeSecrets)),
        };
    });
    server.registerMethod(protocol_1.Methods.ACCOUNT_GET, async (client, params) => {
        requireScope(client, "read");
        const { accountId, includeSecrets } = sanitizeAccountGetParams(params);
        const account = managed_account_manager_1.ManagedAccountManager.getById(accountId);
        if (!account) {
            throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: `Account not found: ${accountId}` };
        }
        const canIncludeSecrets = includeSecrets && isAdminClient(client);
        return { account: managed_account_manager_1.ManagedAccountManager.toPublicView(account, canIncludeSecrets) };
    });
    server.registerMethod(protocol_1.Methods.ACCOUNT_UPSERT, async (client, params) => {
        requireScope(client, "admin");
        const validated = sanitizeAccountUpsertParams(params);
        try {
            const account = managed_account_manager_1.ManagedAccountManager.upsert(validated);
            return { account: managed_account_manager_1.ManagedAccountManager.toPublicView(account, false) };
        }
        catch (error) {
            throw {
                code: protocol_1.ErrorCodes.INVALID_PARAMS,
                message: error?.message || "Invalid account payload",
            };
        }
    });
    server.registerMethod(protocol_1.Methods.ACCOUNT_REMOVE, async (client, params) => {
        requireScope(client, "admin");
        const { accountId } = sanitizeAccountRemoveParams(params);
        const removed = managed_account_manager_1.ManagedAccountManager.remove(accountId);
        return { removed };
    });
    // Workspaces
    server.registerMethod(protocol_1.Methods.WORKSPACE_LIST, async (client) => {
        requireScope(client, "read");
        const all = workspaceRepo.findAll();
        const workspaces = all.filter((w) => !(0, types_1.isTempWorkspaceId)(w.id));
        return {
            workspaces: isAdminClient(client) ? workspaces : workspaces.map(redactWorkspaceForRead),
        };
    });
    server.registerMethod(protocol_1.Methods.WORKSPACE_GET, async (client, params) => {
        requireScope(client, "read");
        const { workspaceId } = sanitizeWorkspaceIdParams(params);
        const workspace = workspaceRepo.findById(workspaceId);
        if (!workspace) {
            throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: `Workspace not found: ${workspaceId}` };
        }
        return { workspace: isAdminClient(client) ? workspace : redactWorkspaceForRead(workspace) };
    });
    server.registerMethod(protocol_1.Methods.WORKSPACE_CREATE, async (client, params) => {
        requireScope(client, "admin");
        const validated = sanitizeWorkspaceCreateParams(params);
        if (workspaceRepo.existsByPath(validated.path)) {
            throw {
                code: protocol_1.ErrorCodes.INVALID_PARAMS,
                message: `A workspace with path "${validated.path}" already exists`,
            };
        }
        try {
            await fs.mkdir(validated.path, { recursive: true });
        }
        catch (error) {
            throw {
                code: protocol_1.ErrorCodes.METHOD_FAILED,
                message: error?.message || `Failed to create workspace directory: ${validated.path}`,
            };
        }
        const defaultPermissions = {
            read: true,
            write: true,
            delete: false,
            network: true,
            shell: false,
        };
        const workspace = workspaceRepo.create(validated.name, validated.path, defaultPermissions);
        return { workspace };
    });
    // File operations (for remote file selection)
    server.registerMethod(protocol_1.Methods.FILE_LIST_DIRECTORY, async (client, params) => {
        requireScope(client, "read");
        const p = (params ?? {});
        const workspaceId = typeof p.workspaceId === "string" ? p.workspaceId.trim() : "";
        const relativePath = typeof p.path === "string" ? p.path.trim() || "." : ".";
        if (!workspaceId)
            throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "workspaceId is required" };
        const workspace = workspaceRepo.findById(workspaceId);
        if (!workspace) {
            throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: `Workspace not found: ${workspaceId}` };
        }
        const resolved = (0, path_containment_1.resolvePathWithinRoot)(workspace.path, relativePath);
        if (!resolved) {
            throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: "Path escapes workspace" };
        }
        try {
            const entries = await fs.readdir(resolved, { withFileTypes: true });
            const files = await Promise.all(entries.slice(0, 200).map(async (entry) => {
                try {
                    const entryPath = node_path_1.default.join(resolved, entry.name);
                    const stat = await fs.stat(entryPath);
                    return {
                        name: entry.name,
                        type: stat.isDirectory() ? "directory" : "file",
                        size: stat.isFile() ? stat.size : 0,
                    };
                }
                catch {
                    return { name: entry.name, type: "file", size: 0 };
                }
            }));
            return { files };
        }
        catch (error) {
            throw {
                code: protocol_1.ErrorCodes.METHOD_FAILED,
                message: error?.message || `Failed to list directory: ${relativePath}`,
            };
        }
    });
    // Tasks
    server.registerMethod(protocol_1.Methods.TASK_CREATE, async (client, params) => {
        requireScope(client, "admin");
        const validated = sanitizeTaskCreateParams(params);
        const workspace = workspaceRepo.findById(validated.workspaceId);
        if (!workspace) {
            throw {
                code: protocol_1.ErrorCodes.INVALID_PARAMS,
                message: `Workspace not found: ${validated.workspaceId}`,
            };
        }
        if (validated.shellAccess && !workspace.permissions?.shell) {
            workspaceRepo.updatePermissions(validated.workspaceId, {
                ...workspace.permissions,
                shell: true,
            });
        }
        const task = taskRepo.create({
            title: validated.title,
            prompt: validated.prompt,
            status: "pending",
            workspaceId: validated.workspaceId,
            agentConfig: validated.agentConfig,
            budgetTokens: validated.budgetTokens,
            budgetCost: validated.budgetCost,
        });
        const initialUpdates = {};
        if (validated.assignedAgentRoleId) {
            initialUpdates.assignedAgentRoleId = validated.assignedAgentRoleId;
            initialUpdates.boardColumn = "todo";
        }
        if (Object.keys(initialUpdates).length > 0) {
            taskRepo.update(task.id, initialUpdates);
            Object.assign(task, initialUpdates);
        }
        if (!(0, types_1.isTempWorkspaceId)(validated.workspaceId)) {
            try {
                workspaceRepo.updateLastUsedAt(validated.workspaceId);
            }
            catch (error) {
                console.warn("[ControlPlane] Failed to update workspace last used time:", error);
            }
        }
        // `startTask()` intentionally resolves only after an immediately-started
        // task has finished. A Control Plane create call must not inherit that
        // lifetime: the desktop needs the task id first so it can bind incoming
        // events to the visible run. Schedule execution after the RPC response has
        // been queued on the socket, then report failures through task state/events.
        setImmediate(() => {
            void agentDaemon.startTask(task).catch((error) => {
                taskRepo.update(task.id, {
                    status: "failed",
                    error: error?.message || "Failed to start task",
                    completedAt: Date.now(),
                });
                console.error(`[ControlPlane] Failed to start task ${task.id}:`, error);
            });
        });
        return { taskId: task.id, task };
    });
    server.registerMethod(protocol_1.Methods.TASK_EVENTS, async (client, params) => {
        requireScope(client, "admin");
        const { taskId, limit } = sanitizeTaskEventsParams(params);
        const all = eventRepo.findByTaskId(taskId);
        const sliced = all.slice(Math.max(all.length - limit, 0));
        const events = sliced.map((e) => ({
            id: e.id,
            taskId: e.taskId,
            timestamp: e.timestamp,
            type: e.type,
            seq: e.seq,
            status: e.status,
            stepId: e.stepId,
            groupId: e.groupId,
            actor: e.actor,
            legacyType: e.legacyType,
            payload: sanitizeForBroadcast(e.payload),
        }));
        return { events };
    });
    server.registerMethod(protocol_1.Methods.TASK_TIMELINE_PAGE, async (client, params) => {
        requireScope(client, "admin");
        const request = (0, task_event_transport_1.sanitizeTaskTimelinePageRequest)(params);
        return (0, task_event_transport_1.buildTaskTimelinePageForTransport)({
            request,
            taskRepo,
            eventRepo,
            sanitizeValue: sanitizeForBroadcast,
        });
    });
    server.registerMethod(protocol_1.Methods.TASK_EVENT_DETAIL, async (client, params) => {
        requireScope(client, "admin");
        const request = (0, task_event_transport_1.sanitizeTaskEventDetailRequest)(params);
        return (0, task_event_transport_1.buildTaskEventDetailForTransport)({
            request,
            taskRepo,
            eventRepo,
            sanitizeValue: sanitizeForBroadcast,
        });
    });
    server.registerMethod(protocol_1.Methods.TASK_GET, async (client, params) => {
        requireScope(client, "read");
        const { taskId } = sanitizeTaskIdParams(params);
        const task = taskRepo.findById(taskId);
        if (!task) {
            throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: `Task not found: ${taskId}` };
        }
        return { task: isAdminClient(client) ? task : redactTaskForRead(task) };
    });
    server.registerMethod(protocol_1.Methods.TASK_LIST, async (client, params) => {
        requireScope(client, "read");
        const { limit, offset, workspaceId } = sanitizeTaskListParams(params);
        if (workspaceId) {
            const total = taskRepo.countByWorkspace(workspaceId);
            const tasks = taskRepo.findByWorkspace(workspaceId, limit, offset);
            return {
                tasks: isAdminClient(client) ? tasks : tasks.map(redactTaskForRead),
                total,
                limit,
                offset,
            };
        }
        const tasks = taskRepo.findAll(limit, offset);
        return { tasks: isAdminClient(client) ? tasks : tasks.map(redactTaskForRead), limit, offset };
    });
    server.registerMethod(protocol_1.Methods.TASK_CANCEL, async (client, params) => {
        requireScope(client, "admin");
        const { taskId } = sanitizeTaskIdParams(params);
        await agentDaemon.cancelTask(taskId);
        return { ok: true };
    });
    server.registerMethod(protocol_1.Methods.TASK_SEND_MESSAGE, async (client, params) => {
        requireScope(client, "admin");
        const { taskId, message, images, quotedAssistantMessage, permissionMode, shellAccess, integrationMentions, } = (0, sanitize_1.sanitizeTaskMessageParams)(params);
        // Keep the headless Control Plane on the same follow-up path as the
        // Electron IPC bridge. Dropping these fields strands paused tasks because
        // the executor never receives the permission/shell update needed to
        // resume, even though the client sent it correctly.
        if (!taskRepo.findById(taskId)) {
            throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: `Task not found: ${taskId}` };
        }
        // A follow-up can resume a document/PPT task that runs for minutes.
        // The RPC only acknowledges acceptance; progress and terminal state travel
        // over task events. Awaiting the whole executor here made the desktop's
        // bounded request time out after 10s even while useful work was underway.
        // Defer execution until the acknowledgement has been queued. sendMessage
        // can emit synchronously before its first await; without this boundary the
        // desktop receives follow-up events while it still has the previous runId.
        setImmediate(() => {
            void agentDaemon
                .sendMessage(taskId, message, images, quotedAssistantMessage, {
                permissionMode,
                shellAccess,
                integrationMentions,
            })
                .catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                agentDaemon.updateTask(taskId, {
                    status: "failed",
                    error: message || "Failed to continue task",
                    terminalStatus: "failed",
                    failureClass: "unknown",
                    completedAt: Date.now(),
                });
                // The renderer deliberately ignores the previous turn's terminal
                // task.get row until it sees evidence that the new run started. If
                // startup itself fails, emit that evidence and the failure together
                // so the run cannot remain `starting` forever.
                agentDaemon.logEvent(taskId, "task_failed", {
                    message: message || "Failed to continue task",
                    failureClass: "follow_up_start_failed",
                });
                console.error(`[ControlPlane] Failed to continue task ${taskId}:`, error);
            });
        });
        return { ok: true };
    });
    // Approvals
    server.registerMethod(protocol_1.Methods.APPROVAL_LIST, async (client, params) => {
        requireScope(client, "admin");
        const { limit, offset, taskId } = sanitizeApprovalListParams(params);
        const approvals = taskId
            ? approvalRepo.findPendingByTaskId(taskId).slice(offset, offset + limit)
            : (() => {
                const stmt = db.prepare(`
            SELECT * FROM approvals
            WHERE status = 'pending'
            ORDER BY requested_at ASC
            LIMIT ? OFFSET ?
          `);
                const rows = stmt.all(limit, offset);
                return rows.map((row) => ({
                    id: String(row.id ?? ""),
                    taskId: String(row.task_id ?? ""),
                    type: row.type,
                    description: row.description,
                    details: (() => {
                        try {
                            return row.details ? JSON.parse(String(row.details)) : {};
                        }
                        catch {
                            return {};
                        }
                    })(),
                    status: row.status,
                    requestedAt: Number(row.requested_at ?? 0),
                    resolvedAt: row.resolved_at ? Number(row.resolved_at) : undefined,
                }));
            })();
        const enriched = approvals.map((a) => {
            const t = a.taskId ? taskRepo.findById(a.taskId) : undefined;
            return {
                ...a,
                ...(t ? { taskTitle: t.title, workspaceId: t.workspaceId, taskStatus: t.status } : {}),
                details: sanitizeForBroadcast(a.details),
            };
        });
        return { approvals: enriched };
    });
    server.registerMethod(protocol_1.Methods.APPROVAL_RESPOND, async (client, params) => {
        requireScope(client, "admin");
        const { approvalId, approved } = sanitizeApprovalRespondParams(params);
        const status = await agentDaemon.respondToApproval(approvalId, approved);
        return { status };
    });
    server.registerMethod(protocol_1.Methods.INPUT_REQUEST_LIST, async (client, params) => {
        requireScope(client, "admin");
        const { limit, offset, taskId, status } = sanitizeInputRequestListParams(params);
        const requests = inputRequestRepo.list({
            limit,
            offset,
            ...(taskId ? { taskId } : {}),
            ...(status ? { status } : {}),
        });
        const enriched = requests.map((request) => {
            const task = request.taskId ? taskRepo.findById(request.taskId) : undefined;
            return {
                ...request,
                ...(task
                    ? { taskTitle: task.title, workspaceId: task.workspaceId, taskStatus: task.status }
                    : {}),
                questions: sanitizeForBroadcast(request.questions),
                answers: sanitizeForBroadcast(request.answers),
            };
        });
        return { inputRequests: enriched };
    });
    server.registerMethod(protocol_1.Methods.INPUT_REQUEST_RESPOND, async (client, params) => {
        requireScope(client, "admin");
        const validated = sanitizeInputRequestRespondParams(params);
        return await agentDaemon.respondToInputRequest(validated);
    });
    // Channels (gateway)
    server.registerMethod(protocol_1.Methods.CHANNEL_LIST, async (client) => {
        requireScope(client, "read");
        const rows = db.prepare("SELECT * FROM channels ORDER BY created_at ASC").all();
        const channels = rows.map((row) => ({
            id: String(row.id ?? ""),
            type: String(row.type ?? ""),
            name: String(row.name ?? ""),
            enabled: row.enabled === 1,
            config: (() => {
                try {
                    return row.config ? JSON.parse(String(row.config)) : {};
                }
                catch {
                    return {};
                }
            })(),
            securityConfig: (() => {
                try {
                    return row.security_config
                        ? JSON.parse(String(row.security_config))
                        : { mode: "pairing" };
                }
                catch {
                    return { mode: "pairing" };
                }
            })(),
            status: String(row.status ?? ""),
            botUsername: row.bot_username ? String(row.bot_username) : undefined,
            createdAt: Number(row.created_at ?? 0),
            updatedAt: Number(row.updated_at ?? 0),
        }));
        if (!isAdminClient(client)) {
            return { channels: channels.map(redactChannelForRead) };
        }
        return {
            channels: channels.map((c) => ({
                ...redactChannelForRead(c),
                config: redactObjectSecrets(c.config),
                securityConfig: {
                    mode: c.securityConfig?.mode,
                    allowedUsersCount: Array.isArray(c.securityConfig?.allowedUsers)
                        ? c.securityConfig.allowedUsers.length
                        : 0,
                },
            })),
        };
    });
    server.registerMethod(protocol_1.Methods.CHANNEL_GET, async (client, params) => {
        requireScope(client, "read");
        const { channelId } = sanitizeChannelIdParams(params);
        const row = db.prepare("SELECT * FROM channels WHERE id = ?").get(channelId);
        if (!row) {
            throw { code: protocol_1.ErrorCodes.INVALID_PARAMS, message: `Channel not found: ${channelId}` };
        }
        const channel = {
            id: String(row.id ?? ""),
            type: String(row.type ?? ""),
            name: String(row.name ?? ""),
            enabled: row.enabled === 1,
            config: (() => {
                try {
                    return row.config ? JSON.parse(String(row.config)) : {};
                }
                catch {
                    return {};
                }
            })(),
            status: String(row.status ?? ""),
            botUsername: row.bot_username ? String(row.bot_username) : undefined,
            securityConfig: (() => {
                try {
                    return row.security_config
                        ? JSON.parse(String(row.security_config))
                        : { mode: "pairing" };
                }
                catch {
                    return { mode: "pairing" };
                }
            })(),
            createdAt: Number(row.created_at ?? 0),
            updatedAt: Number(row.updated_at ?? 0),
        };
        if (!isAdminClient(client))
            return { channel: redactChannelForRead(channel) };
        return {
            channel: {
                ...redactChannelForRead(channel),
                config: redactObjectSecrets(channel.config),
                securityConfig: {
                    mode: channel.securityConfig?.mode,
                    allowedUsersCount: Array.isArray(channel.securityConfig?.allowedUsers)
                        ? channel.securityConfig.allowedUsers.length
                        : 0,
                },
            },
        };
    });
    server.registerMethod(protocol_1.Methods.CHANNEL_CREATE, async (client, params) => {
        requireScope(client, "admin");
        const validated = sanitizeChannelCreateParams(params);
        // Enforce one channel per type (router registers by type).
        const existing = db
            .prepare("SELECT id FROM channels WHERE type = ? LIMIT 1")
            .get(validated.type);
        if (existing?.id) {
            throw {
                code: protocol_1.ErrorCodes.INVALID_PARAMS,
                message: `Channel type "${validated.type}" already exists (id=${existing.id})`,
            };
        }
        const now = Date.now();
        const id = (0, node_crypto_1.randomUUID)();
        db.prepare(`
      INSERT INTO channels (id, type, name, enabled, config, security_config, status, bot_username, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, validated.type, validated.name, validated.enabled ? 1 : 0, JSON.stringify(validated.config || {}), JSON.stringify(validated.securityConfig || { mode: "pairing" }), "disconnected", null, now, now);
        // If the gateway is running, optionally connect immediately when enabled.
        if (validated.enabled && channelGateway) {
            try {
                await channelGateway.enableChannel(id);
            }
            catch (error) {
                // Keep the channel record but surface the connection error.
                db.prepare("UPDATE channels SET enabled = 0, status = ?, updated_at = ? WHERE id = ?").run("disconnected", Date.now(), id);
                throw {
                    code: protocol_1.ErrorCodes.METHOD_FAILED,
                    message: error?.message || "Failed to enable channel",
                };
            }
        }
        return { channelId: id };
    });
    server.registerMethod(protocol_1.Methods.CHANNEL_UPDATE, async (client, params) => {
        requireScope(client, "admin");
        const { channelId, updates } = sanitizeChannelUpdateParams(params);
        if (channelGateway) {
            channelGateway.updateChannel(channelId, updates);
            return { ok: true };
        }
        // Fallback: update DB only (restart required to take effect).
        const fields = [];
        const values = [];
        if (updates.name !== undefined) {
            fields.push("name = ?");
            values.push(updates.name);
        }
        if (updates.config !== undefined) {
            fields.push("config = ?");
            values.push(JSON.stringify(updates.config));
        }
        if (updates.securityConfig !== undefined) {
            fields.push("security_config = ?");
            values.push(JSON.stringify(updates.securityConfig));
        }
        if (fields.length === 0)
            return { ok: true };
        fields.push("updated_at = ?");
        values.push(Date.now());
        values.push(channelId);
        db.prepare(`UPDATE channels SET ${fields.join(", ")} WHERE id = ?`).run(...values);
        return { ok: true, restartRequired: true };
    });
    server.registerMethod(protocol_1.Methods.CHANNEL_TEST, async (client, params) => {
        requireScope(client, "admin");
        const { channelId } = sanitizeChannelIdParams(params);
        if (!channelGateway) {
            return { success: false, error: "Channel gateway not available (restart required)" };
        }
        return await channelGateway.testChannel(channelId);
    });
    server.registerMethod(protocol_1.Methods.CHANNEL_ENABLE, async (client, params) => {
        requireScope(client, "admin");
        const { channelId } = sanitizeChannelIdParams(params);
        if (!channelGateway) {
            db.prepare("UPDATE channels SET enabled = 1, updated_at = ? WHERE id = ?").run(Date.now(), channelId);
            return { ok: true, restartRequired: true };
        }
        await channelGateway.enableChannel(channelId);
        return { ok: true };
    });
    server.registerMethod(protocol_1.Methods.CHANNEL_DISABLE, async (client, params) => {
        requireScope(client, "admin");
        const { channelId } = sanitizeChannelIdParams(params);
        if (!channelGateway) {
            db.prepare("UPDATE channels SET enabled = 0, status = ?, updated_at = ? WHERE id = ?").run("disconnected", Date.now(), channelId);
            return { ok: true, restartRequired: true };
        }
        await channelGateway.disableChannel(channelId);
        return { ok: true };
    });
    server.registerMethod(protocol_1.Methods.CHANNEL_REMOVE, async (client, params) => {
        requireScope(client, "admin");
        const { channelId } = sanitizeChannelIdParams(params);
        if (!channelGateway) {
            db.prepare("DELETE FROM channels WHERE id = ?").run(channelId);
            return { ok: true, restartRequired: true };
        }
        await channelGateway.removeChannel(channelId);
        return { ok: true };
    });
    // LLM setup (headless-friendly credential/provider configuration).
    server.registerMethod(protocol_1.Methods.LLM_CONFIGURE, async (client, params) => {
        requireScope(client, "admin");
        return (0, llm_configure_1.configureLlmFromControlPlaneParams)(params);
    });
    // Config/health (sanitized; no secrets).
    server.registerMethod(protocol_1.Methods.CONFIG_GET, async (client) => {
        requireScope(client, "read");
        const isAdmin = isAdminClient(client);
        const allWorkspaces = workspaceRepo.findAll().filter((w) => !(0, types_1.isTempWorkspaceId)(w.id));
        const workspacesForClient = isAdmin ? allWorkspaces : allWorkspaces.map(redactWorkspaceForRead);
        const taskStatusRows = db
            .prepare(`SELECT status, COUNT(1) AS count FROM tasks GROUP BY status`)
            .all();
        const tasksByStatus = {};
        let taskTotal = 0;
        for (const row of taskStatusRows) {
            const status = String(row.status || "");
            const count = typeof row.count === "number" ? row.count : Number(row.count);
            const safeCount = Number.isFinite(count) ? count : 0;
            if (status)
                tasksByStatus[status] = safeCount;
            taskTotal += safeCount;
        }
        const llm = (0, llm_configure_1.getControlPlaneLlmStatus)();
        const anyLlmConfigured = llm.providers.some((p) => p.configured);
        const currentProviderConfigured = llm.providers.find((p) => p.type === llm.currentProvider)?.configured || false;
        const searchStatus = search_1.SearchProviderFactory.getConfigStatus();
        const controlPlane = settings_1.ControlPlaneSettingsManager.getSettingsForDisplay();
        const envImport = {
            enabled: (0, runtime_mode_1.shouldImportEnvSettingsFromArgsOrEnv)(),
            mode: (0, runtime_mode_1.getEnvSettingsImportModeFromArgsOrEnv)(),
        };
        const runtime = {
            platform: process.platform,
            arch: process.arch,
            node: process.version,
            electron: process.versions.electron,
            coworkVersion: getCoworkVersionFromNearestPackageJson(),
            headless: (0, runtime_mode_1.isHeadlessMode)(),
            cwd: process.cwd(),
            userDataDir: (0, user_data_dir_1.getUserDataDir)(),
            importEnvSettings: envImport,
        };
        const deploymentPosture = (0, deployment_posture_1.evaluateControlPlaneDeploymentPosture)({
            settings: controlPlane,
            headless: runtime.headless,
            managedDeployment: (0, runtime_mode_1.shouldUseManagedDeploymentModeFromEnv)(),
            bindContext: (0, runtime_mode_1.getControlPlaneBindContextFromEnv)(),
            allowInsecurePublicBind: (0, runtime_mode_1.shouldAllowInsecureControlPlanePublicBindFromEnv)(),
        });
        const warnings = [];
        if (deploymentPosture.status !== "ready") {
            warnings.push(...deploymentPosture.reasons);
        }
        if (allWorkspaces.length === 0) {
            warnings.push("No workspaces configured. Set COWORK_BOOTSTRAP_WORKSPACE_PATH on startup or create one via workspace.create.");
        }
        if (!anyLlmConfigured) {
            warnings.push("No LLM provider credentials configured. Configure one via Control Plane (LLM Setup / llm.configure), or use COWORK_IMPORT_ENV_SETTINGS=1 with provider env vars and restart.");
        }
        else if (!currentProviderConfigured) {
            warnings.push(`Selected LLM provider "${llm.currentProvider}" is not configured. Either switch provider or configure its credentials.`);
        }
        if (!envImport.enabled && !anyLlmConfigured) {
            warnings.push("Tip: enable env import with COWORK_IMPORT_ENV_SETTINGS=1 (or --import-env-settings) so provider env vars are persisted into Secure Settings at boot.");
        }
        if (!searchStatus.isConfigured) {
            warnings.push("No search provider configured (optional). Set TAVILY_API_KEY/BRAVE_API_KEY/SERPAPI_API_KEY if you want web search.");
        }
        // Channels summary (no secrets).
        const channelRows = db
            .prepare(`SELECT id, type, name, enabled, status, bot_username, security_config, created_at, updated_at FROM channels ORDER BY created_at ASC`)
            .all();
        const channels = channelRows.map((row) => ({
            id: String(row.id ?? ""),
            type: String(row.type ?? ""),
            name: String(row.name ?? ""),
            enabled: row.enabled === 1,
            status: String(row.status ?? ""),
            botUsername: row.bot_username ? String(row.bot_username) : undefined,
            securityConfig: (() => {
                try {
                    return row.security_config
                        ? JSON.parse(String(row.security_config))
                        : { mode: "pairing" };
                }
                catch {
                    return { mode: "pairing" };
                }
            })(),
            createdAt: Number(row.created_at ?? 0),
            updatedAt: Number(row.updated_at ?? 0),
        }));
        const channelsEnabled = channels.filter((c) => c.enabled).length;
        return {
            runtime,
            controlPlane,
            deploymentPosture,
            workspaces: { count: allWorkspaces.length, workspaces: workspacesForClient },
            tasks: { total: taskTotal, byStatus: tasksByStatus },
            channels: {
                count: channels.length,
                enabled: channelsEnabled,
                channels: channels.map(redactChannelForRead),
            },
            llm,
            search: searchStatus,
            warnings,
        };
    });
    // Basic channel sanity check: report adapters available (best-effort).
    server.registerMethod("gateway.channelsSupported", async (client) => {
        requireScope(client, "read");
        const types = [
            "telegram",
            "discord",
            "slack",
            "whatsapp",
            "imessage",
            "signal",
            "matrix",
            "mattermost",
            "twitch",
            "line",
            "bluebubbles",
            "email",
            "x",
        ];
        return { types };
    });
    // Best-effort: Ensure channel settings category is initialized (legacy compatibility).
    try {
        if (channelRepo && settings_1.ControlPlaneSettingsManager) {
            // no-op
        }
    }
    catch {
        // ignore
    }
}
