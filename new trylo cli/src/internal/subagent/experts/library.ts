import { randomUUID } from "node:crypto";
import { contentHashOf } from "../../learning/control/hash.js";
import { ExpertLibraryError } from "./contracts.js";
import type { ExpertActionContext, ExpertAuthorizationPort, ExpertBuildPort,
  ExpertConfiguration, ExpertLibrarySnapshot, ExpertOrigin, ExpertRequest, ExpertRequestAssociation, ExpertStorePort, ExpertVersion } from "./contracts.js";
import { validateAssociation, validateConfiguration, validateEdits } from "./validation.js";
import { expertArchiveAuthorizationAction, expertRequestAuthorizationAction } from "./authorization.js";

export type ExpertLibraryOptions = { readonly store: ExpertStorePort; readonly authorization: ExpertAuthorizationPort;
  readonly builder: ExpertBuildPort; readonly now?: () => number; readonly createId?: () => string };

export type ExpertSubmitInput = { readonly origin: ExpertOrigin; readonly instruction: string;
  readonly expertId?: string; readonly requestId?: string; readonly association?: ExpertRequestAssociation;
  readonly preparation?: ExpertRequest["preparation"] };

export type ExpertRetention = { readonly kind: "save" | "temporary" } | { readonly kind: "revise"; readonly feedback: string };

/** Sole lifecycle writer. No method starts a team, learns experience, or grants tools. */
export class ExpertLibrary {
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(private readonly options: ExpertLibraryOptions) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  query(text = ""): readonly ExpertVersion[] {
    const words = text.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    return this.options.store.read().experts.filter(e => e.status === "active").map(e => e.versions.at(-1)!)
      .map(expert => ({ expert, score: words.reduce((score, word) => score + (JSON.stringify(expert.configuration).toLocaleLowerCase().includes(word) ? 1 : 0), 0) }))
      .filter(match => words.length === 0 || match.score > 0).sort((a, b) => b.score - a.score)
      .map(match => structuredClone(match.expert));
  }

  get(expertId: string, version?: number): ExpertVersion | undefined {
    const record = this.options.store.read().experts.find(e => e.expertId === expertId && e.status === "active");
    const result = version === undefined ? record?.versions.at(-1) : record?.versions.find(v => v.version === version);
    return result === undefined ? undefined : structuredClone(result);
  }

  requests(): readonly ExpertRequest[] { return structuredClone(this.options.store.read().requests); }

  request(requestId: string): ExpertRequest { return structuredClone(this.requireRequest(requestId)); }

  /** Existing expertise can be edited without paying for resource synthesis again. */
  async draftRevision(expertId: string, context: ExpertActionContext = {}, requestId?: string): Promise<ExpertRequest> {
    const version = this.get(expertId);
    if (version === undefined) throw new ExpertLibraryError("not_found", "Expert is absent or archived");
    return this.submitRequest({ origin: "settings", expertId, instruction: `编辑专家配置：${version.configuration.displayName}`,
      preparation: "reuse_configuration", ...(requestId === undefined ? {} : { requestId }) }, context);
  }

  async submitRequest(input: ExpertSubmitInput, context: ExpertActionContext = {}): Promise<ExpertRequest> {
    this.checkSignal(context);

    if (!["settings", "personal_agent", "collaboration"].includes(input.origin) || !input.instruction?.trim() || input.instruction.length > 8000) {
      throw new ExpertLibraryError("invalid_input", "An expert request needs an origin and bounded instruction");
    }

    if (input.requestId !== undefined && (!input.requestId.trim() || input.requestId.length > 200)) throw new ExpertLibraryError("invalid_input", "Invalid request id");

    if (input.association !== undefined) validateAssociation(input.association);

    if (input.preparation !== undefined && !["build", "reuse_configuration"].includes(input.preparation)) throw new ExpertLibraryError("invalid_input", "Invalid expert preparation mode");

    if (context.useScope !== undefined && (!context.useScope.workspaceId?.trim() || !context.useScope.taskId?.trim())) throw new ExpertLibraryError("invalid_input", "Temporary use scope needs workspace and task identity");

    const snapshot = this.options.store.read();
    const existing = input.requestId === undefined ? undefined : snapshot.requests.find(r => r.requestId === input.requestId);
    if (existing !== undefined) {
      if (existing.origin !== input.origin || existing.instruction !== input.instruction || contentHashOf(existing.association ?? null) !== contentHashOf(input.association ?? null)
        || contentHashOf(existing.useScope ?? null) !== contentHashOf(context.useScope ?? null)
        || (existing.preparation ?? "build") !== (input.preparation ?? "build")
        || input.expertId !== undefined && existing.expertId !== input.expertId) {
        throw new ExpertLibraryError("conflict", "A request identity cannot be reused for different input");
      }
      return structuredClone(existing);
    }

    const previous = input.expertId === undefined ? undefined : this.get(input.expertId);
    if (input.expertId !== undefined && previous === undefined) throw new ExpertLibraryError("not_found", "Expert is absent or archived");

    if (input.preparation === "reuse_configuration" && previous === undefined) throw new ExpertLibraryError("invalid_input", "Only an existing expert configuration can be reused for manual revision");

    const lastRequest = previous === undefined ? undefined : snapshot.requests.find(r => r.requestId === previous.requestId);
    const expertId = previous?.expertId ?? this.createId();
    const request: ExpertRequest = { requestId: input.requestId ?? this.createId(), expertId,
      experienceKey: previous?.experienceKey ?? `expert:${expertId}`, origin: input.origin, instruction: input.instruction,
      baseVersion: previous?.version ?? 0, state: "awaiting_creation", revision: 0, createdAt: this.now(),
      ...(input.association === undefined ? {} : { association: input.association }),
      ...(context.useScope === undefined ? {} : { useScope: context.useScope }),
      ...(input.preparation === undefined ? {} : { preparation: input.preparation }),
      userEdits: lastRequest?.userEdits ?? {}, ...(previous === undefined ? {} : { configuration: previous.configuration }) };

    this.write(snapshot, { ...snapshot, requests: [...snapshot.requests, request] });

    return this.authorizeCreation(request, context);
  }

  /** Explicit retry after cancellation/expiry, never an implicit repeated prompt. */
  async authorizeCreation(request: ExpertRequest | string, context: ExpertActionContext = {}): Promise<ExpertRequest> {
    const current = this.requireRequest(typeof request === "string" ? request : request.requestId);

    this.expect(current, ["awaiting_creation"]);
    const authorization = await this.options.authorization.authorize(expertRequestAuthorizationAction(current, "create"), context);

    this.checkSignal(context);

    if (authorization.resolution === "cancelled" || authorization.resolution === "expired") return this.request(current.requestId);

    return this.replace(current, authorization.resolution === "approved"
      ? { ...current, state: current.preparation === "reuse_configuration" ? "awaiting_retention" : "authorized", creationAuthorization: authorization.receipt }
      : { ...current, state: "rejected" });
  }

  async build(requestId: string, context: ExpertActionContext = {}): Promise<ExpertRequest> {
    const request = this.requireRequest(requestId);

    this.expect(request, ["authorized", "revision_requested"]);

    if (!request.creationAuthorization) throw new ExpertLibraryError("unauthorized", "Creation was not authorized");

    this.checkSignal(context);
    const built = await this.options.builder.build({ request, ...(request.configuration === undefined ? {} : { previous: request.configuration }),
      signal: context.signal ?? new AbortController().signal });

    this.checkSignal(context);
    const configuration = validateConfiguration({ ...built, ...request.userEdits });

    return this.replace(request, { ...request, configuration, state: "awaiting_retention" });
  }

  /** User edits are recorded separately and reapplied after every automatic build. */
  async edit(requestId: string, edits: Partial<ExpertConfiguration>, context: ExpertActionContext = {}): Promise<ExpertRequest> {
    const request = this.requireRequest(requestId);

    this.expect(request, ["awaiting_retention", "revision_requested", "temporary"]);
    const checked = validateEdits(edits);
    const configuration = validateConfiguration({ ...request.configuration, ...checked });
    const candidate = { ...request, configuration };
    const approval = await this.options.authorization.authorize(expertRequestAuthorizationAction(candidate, "edit"), context);

    this.checkSignal(context);

    if (approval.resolution !== "approved") throw new ExpertLibraryError("unauthorized", "Expert edit was not authorized");

    return this.replace(request, { ...candidate, userEdits: { ...request.userEdits, ...checked }, state: "awaiting_retention" });
  }

  async retain(requestId: string, result: ExpertRetention, context: ExpertActionContext = {}): Promise<ExpertRequest> {
    const request = this.requireRequest(requestId);
    if (request.state === "saved" && result.kind === "save") return structuredClone(request);

    this.expect(request, ["awaiting_retention", "temporary"]);

    if (result.kind === "revise") {
      if (!result.feedback.trim() || result.feedback.length > 8000) throw new ExpertLibraryError("invalid_input", "Revision needs bounded feedback");
      return this.replace(request, { ...request, state: "revision_requested", feedback: result.feedback });
    }

    if (result.kind === "temporary") return this.replace(request, { ...request, state: "temporary" });

    if (result.kind !== "save") throw new ExpertLibraryError("invalid_input", "Unknown retention result");

    const approval = await this.options.authorization.authorize(expertRequestAuthorizationAction(request, "retain"), context);

    this.checkSignal(context);

    if (approval.resolution === "denied") return this.replace(request, { ...request, state: "temporary" });

    if (approval.resolution !== "approved") return this.request(requestId);

    const snapshot = this.options.store.read();

    this.requireUnchanged(snapshot, request);
    const record = snapshot.experts.find(e => e.expertId === request.expertId);
    if ((record?.versions.at(-1)?.version ?? 0) !== request.baseVersion || record?.status === "archived") {
      throw new ExpertLibraryError("conflict", "The expert changed while the draft was being reviewed; create a new revision request");
    }

    const configuration = validateConfiguration(request.configuration);
    const saved: ExpertRequest = { ...request, state: "saved", revision: request.revision + 1, retentionAuthorization: approval.receipt };
    const version: ExpertVersion = { expertId: request.expertId, experienceKey: request.experienceKey,
      version: request.baseVersion + 1, requestId, configuration, createdAt: this.now() };
    const nextRecord = { expertId: request.expertId, experienceKey: request.experienceKey, status: "active" as const,
      versions: [...(record?.versions ?? []), version] };

    this.write(snapshot, { ...snapshot, requests: snapshot.requests.map(r => r.requestId === requestId ? saved : r),
      experts: [...snapshot.experts.filter(e => e.expertId !== request.expertId), nextRecord] });

    return structuredClone(saved);
  }

  async archive(expertId: string, context: ExpertActionContext = {}): Promise<void> {
    const expert = this.get(expertId);
    if (expert === undefined) throw new ExpertLibraryError("not_found", "Expert is absent or already archived");

    const approval = await this.options.authorization.authorize(expertArchiveAuthorizationAction(expert), context);

    this.checkSignal(context);

    if (approval.resolution !== "approved") throw new ExpertLibraryError("unauthorized", "Expert archive was not authorized");

    const snapshot = this.options.store.read();
    if (snapshot.experts.find(e => e.expertId === expertId)?.versions.at(-1)?.version !== expert.version) throw new ExpertLibraryError("conflict", "Expert changed during archive approval");

    this.write(snapshot, { ...snapshot, experts: snapshot.experts.map(e => e.expertId === expertId ? { ...e, status: "archived" } : e) });
  }

  private requireRequest(id: string): ExpertRequest {
    const request = this.options.store.read().requests.find(r => r.requestId === id);
    if (request === undefined) throw new ExpertLibraryError("not_found", "Expert request is absent");
    return request;
  }

  private expect(request: ExpertRequest, states: readonly ExpertRequest["state"][]): void {
    if (!states.includes(request.state)) throw new ExpertLibraryError("invalid_state", `Cannot perform this action on a ${request.state} expert request`);
  }

  private requireUnchanged(snapshot: ExpertLibrarySnapshot, expected: ExpertRequest): void {
    const current = snapshot.requests.find(r => r.requestId === expected.requestId);
    if (current?.revision !== expected.revision || current.state !== expected.state) throw new ExpertLibraryError("conflict", "Expert request changed during the operation");
  }

  private replace(expected: ExpertRequest, next: ExpertRequest): ExpertRequest {
    const snapshot = this.options.store.read();
    this.requireUnchanged(snapshot, expected);
    const updated = { ...next, revision: expected.revision + 1 };
    this.write(snapshot, { ...snapshot, requests: snapshot.requests.map(r => r.requestId === expected.requestId ? updated : r) });
    return structuredClone(updated);
  }

  private write(previous: ExpertLibrarySnapshot, next: ExpertLibrarySnapshot): void {
    this.options.store.update(previous.sequence, structuredClone({ ...next, sequence: previous.sequence + 1 }));
  }

  private checkSignal(context: ExpertActionContext): void {
    if (context.signal?.aborted) throw new ExpertLibraryError("cancelled", "Expert operation was cancelled");
  }
}
