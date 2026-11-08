import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type { DocumentFailure, DocumentFailureCode, ProviderKind, ProvidersDocument } from "../../adapters/provider/providers-file.js";
import { capabilitiesFor, decodeDocument, editDeclared, encodeDocument, PROVIDER_KINDS, PROVIDERS_DOCUMENT_VERSION, removeDeclared, type RemoveEditFailure } from "../../adapters/provider/providers-file.js";
import type { ProviderRegistry } from "../../adapters/provider/registry.js";
import { readRegistry, registryOfDocument, requireProvider } from "../../adapters/provider/registry.js";
import type { Resolution, ResolveInput } from "../../adapters/provider/resolver.js";
import { resolveProvider, withSelected } from "../../adapters/provider/resolver.js";
import { tryloHome } from "./session-paths.js";

/**
 * The CLI's one binding to the declared-providers file.
 *
 * It is the counterpart of `mcp-wiring.ts`: it decides where the file is and
 * what each failure means for the process exit code, and nothing else. The
 * file's shape, its decode and the registry it becomes all live in
 * `adapters/provider/**`, so a command handler never parses JSON and never
 * names a path.
 *
 * The path is the user's profile, not the workspace. A declaration names an
 * endpoint and a model; putting that in the workspace would let a repository
 * choose which host a clone talks to, which is a decision no checkout should
 * make for the person who cloned it.
 *
 * Reading is optional in the strong sense: a machine with no such file is every
 * machine that never declared anything, and `readCliProviderRegistry` returns
 * the built-in registry rather than a failure — that is what keeps the default
 * run path byte for byte the run path it was.
 */

export const PROVIDERS_FILE_NAME = "providers.json";

/** The read half: everything that only wants to know what is declared. */
export type ProvidersReadContext = {
  readonly homeDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readFile: (absolutePath: string) => string | undefined;
};

/** The whole binding. The writer is separate because the doctor — and every
 *  other read-only caller — must not be able to write by accident. */
export type ProvidersWiringContext = ProvidersReadContext & {
  readonly writeFile: (absolutePath: string, text: string) => boolean;
};

export function providersFilePath(ctx: ProvidersReadContext): string {
  return `${tryloHome(ctx.homeDir, ctx.env)}/${PROVIDERS_FILE_NAME}`;
}

export function readCliProviderRegistry(ctx: ProvidersReadContext): ProviderRegistry | DocumentFailure {
  return readRegistry({ readFile: ctx.readFile, providersFile: providersFilePath(ctx) });
}

export function isDocumentFailure(value: ProviderRegistry | DocumentFailure): value is DocumentFailure {
  return "code" in value;
}

/**
 * Failure code -> exit code, exhaustive over the decoder's closed set.
 *
 * Every code is `CONFIG`: a file that exists but is not a providers document is
 * a fact about the disk, not about the command that was typed. The `Record`
 * type makes a new code a compile error here rather than a fallthrough at run
 * time.
 */
const DOCUMENT_EXIT_CODES: Record<DocumentFailureCode, ExitCode> = {
  not_json: EXIT_CODES.CONFIG,
  bad_shape: EXIT_CODES.CONFIG,
  bad_version: EXIT_CODES.CONFIG,
  unknown_field: EXIT_CODES.CONFIG,
  bad_entry: EXIT_CODES.CONFIG,
  reserved_id: EXIT_CODES.CONFIG,
  duplicate_id: EXIT_CODES.CONFIG,
};

export function documentFailureExit(failure: DocumentFailure): ExitCode {
  return DOCUMENT_EXIT_CODES[failure.code];
}

export function documentFailureMessage(failure: DocumentFailure): string {
  return `${PROVIDERS_FILE_NAME} is not usable: ${failure.code}: ${failure.detail}`;
}

/**
 * Resolve the provider a run will use.
 *
 * The registry is read here and handed to the resolver as one value, so the
 * selection and the entry it describes come from a single read — the failure
 * mode being avoided is a run that picks an id from one read and an endpoint
 * from another.
 */
export function resolveRunProvider(
  ctx: ProvidersWiringContext,
  input: Omit<ResolveInput, "registry">,
): Resolution | { readonly ok: false; readonly failure: DocumentFailure } {
  const registry = readCliProviderRegistry(ctx);
  if (isDocumentFailure(registry)) {
    return { ok: false, failure: registry };
  }
  return resolveProvider({ registry, ...input });
}

export type SwitchTarget = { readonly id: string };

export type SwitchResult =
  | { readonly ok: true; readonly id: string; readonly created: boolean }
  | {
      readonly ok: false;
      readonly code: "unknown_provider" | "write_failed" | DocumentFailureCode;
      readonly detail: string;
      readonly known?: ReadonlyArray<string>;
    };

function currentDocument(ctx: ProvidersWiringContext): ProvidersDocument | DocumentFailure {
  const raw = ctx.readFile(providersFilePath(ctx));
  if (raw === undefined) {
    return { version: PROVIDERS_DOCUMENT_VERSION, providers: [] };
  }
  const decoded = decodeDocument(raw);
  return decoded.ok ? decoded.value : decoded.failure;
}

/**
 * Select a provider: one read, one complete document, one write (D3).
 *
 * The whole document is rewritten rather than patched, because "which provider
 * is selected" and "which providers exist" are one file, and a partial write
 * that updated the selection while keeping a half-read provider list is exactly
 * the half-old/half-new state the design forbids.
 *
 * Switching to an id that does not exist is refused *before* anything is
 * written, and the refusal carries the known ids: a typo here should be
 * correctable from the error message alone.
 */
export function switchSelected(ctx: ProvidersWiringContext, target: SwitchTarget): SwitchResult {
  const document = currentDocument(ctx);
  if ("code" in document) {
    return { ok: false, code: document.code, detail: document.detail };
  }

  const registry = registryOfDocument(document);
  const found = requireProvider(registry, target.id);
  if (!found.ok) {
    return {
      ok: false,
      code: "unknown_provider",
      detail: `unknown provider: ${target.id}`,
      known: found.denial.known,
    };
  }

  const next = withSelected(document, found.entry.id);
  const path = providersFilePath(ctx);
  if (!ctx.writeFile(path, encodeDocument(next))) {
    return { ok: false, code: "write_failed", detail: `could not write ${path}` };
  }

  return { ok: true, id: found.entry.id, created: document.providers.length === 0 };
}

/** Exit code for a failed switch: bad id is usage, a bad file or disk is config. */
export function switchFailureExit(result: Extract<SwitchResult, { ok: false }>): ExitCode {
  if (result.code === "unknown_provider") {
    return EXIT_CODES.USAGE;
  }

  if (result.code === "write_failed") {
    return EXIT_CODES.EXECUTION_FAILURE;
  }

  return DOCUMENT_EXIT_CODES[result.code];
}

// ---------------------------------------------------------------------------
// `providers add`
// ---------------------------------------------------------------------------

/** One new declaration, exactly as `providers add` was given it. */
export type AddDeclaration = {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly endpoint: string;
  readonly model: string;
  readonly accountId?: string;
  readonly contextWindow?: number;
};

export type AddResult =
  | { readonly ok: true; readonly id: string; readonly created: boolean }
  | {
      readonly ok: false;
      readonly code: "invalid_id" | "reserved_id" | "duplicate_id" | "missing_field" | "write_failed" | DocumentFailureCode;
      readonly detail: string;
      readonly known?: ReadonlyArray<string>;
    };

/**
 * Declared ids are flag values and file keys, so the charset is as tight as the
 * credential ledger's account ids: a space or an `=` in an id is a syntax
 * accident waiting for a shell, and an id nobody can type is a declaration
 * nobody can select.
 */
const DECLARED_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function invalidIdReason(id: string): string | undefined {
  if (id.length === 0) {
    return "a provider id is required";
  }

  if (!DECLARED_ID_PATTERN.test(id)) {
    return `provider id ${JSON.stringify(id)} is not usable: letters, digits, "-" and "_", starting with a letter`;
  }

  return undefined;
}

/** Shared form/command validation before any credential or declaration is written. */
export function validateDeclaration(declaration: AddDeclaration): Extract<AddResult, { ok: false }> | undefined {
  const idReason = invalidIdReason(declaration.id);
  if (idReason !== undefined) return { ok: false, code: "invalid_id", detail: idReason };

  if (RESERVED_DECLARED_IDS.includes(declaration.id)) return { ok: false, code: "reserved_id", detail: `${declaration.id} is a built-in provider and cannot be redefined` };

  const missing: string[] = [];

  if (declaration.endpoint.trim().length === 0) missing.push("--endpoint");

  if (declaration.model.trim().length === 0) missing.push("--model");

  if (missing.length > 0) return { ok: false, code: "missing_field", detail: `${declaration.kind} needs ${missing.join(" and ")}` };

  return undefined;
}

/**
 * Add one declaration: one read, one complete document, one write.
 *
 * The same whole-document discipline as `switchSelected` — "which providers
 * exist" and "which is selected" are one file — and the same refusal ordering:
 * everything that can be refused from the arguments is refused *before* the
 * disk is touched, so a typo never leaves a half-written declaration behind.
 *
 * Adding an id that already exists is refused rather than upserted. A declaration
 * names an endpoint and an account binding; silently replacing one because the
 * id matched is exactly how a key ends up being sent to a host it was never
 * issued for. `providers add` is not `providers set`.
 */
export function addDeclaredProvider(ctx: ProvidersWiringContext, declaration: AddDeclaration): AddResult {
  const invalid = validateDeclaration(declaration);
  if (invalid !== undefined) return invalid;

  const document = currentDocument(ctx);
  if ("code" in document) {
    return { ok: false, code: document.code, detail: document.detail };
  }

  if (document.providers.some((entry) => entry.id === declaration.id)) {
    return {
      ok: false,
      code: "duplicate_id",
      detail: `provider ${declaration.id} already exists; remove it from ${PROVIDERS_FILE_NAME} first`,
    };
  }

  const next: ProvidersDocument = {
    ...document,
    providers: [
      ...document.providers,
      {
        id: declaration.id,
        kind: declaration.kind,
        endpoint: declaration.endpoint.trim(),
        model: declaration.model.trim(),
        ...(declaration.accountId === undefined || declaration.accountId.trim().length === 0
          ? {}
          : { accountId: declaration.accountId.trim() }),
        capabilities: capabilitiesForNewDeclaration(declaration.kind, declaration.endpoint.trim(), declaration.model.trim(), declaration.contextWindow),
      },
    ],
  };
  const path = providersFilePath(ctx);
  if (!ctx.writeFile(path, encodeDocument(next))) {
    return { ok: false, code: "write_failed", detail: `could not write ${path}` };
  }

  return { ok: true, id: declaration.id, created: document.providers.length === 0 };
}

/** Exit code for a failed add: a mistake in the arguments is usage, the rest is config or disk. */
export function addFailureExit(result: Extract<AddResult, { ok: false }>): ExitCode {
  if (result.code === "invalid_id" || result.code === "reserved_id" || result.code === "duplicate_id" || result.code === "missing_field") {
    return EXIT_CODES.USAGE;
  }

  if (result.code === "write_failed") {
    return EXIT_CODES.EXECUTION_FAILURE;
  }

  return DOCUMENT_EXIT_CODES[result.code];
}

/** The kinds a declaration may name, for the help text and usage errors. */
export function declaredProviderKinds(): ReadonlyArray<ProviderKind> {
  return [...PROVIDER_KINDS];
}

// `providers remove` / `providers edit` writers, same whole-document discipline as add/switch.
export type RemoveEditResult =
  | { readonly ok: true; readonly id: string; readonly clearedSelected: boolean; readonly changed: ReadonlyArray<string>; readonly accountId?: string }
  | {
      readonly ok: false;
      readonly code: RemoveEditFailure["code"] | "write_failed" | DocumentFailureCode;
      readonly detail: string;
      readonly known?: ReadonlyArray<string>;
    };

/** One read, one complete document, one write — the same discipline as add/switch. */
function writeDocument(
  ctx: ProvidersWiringContext,
  next: ProvidersDocument,
): { readonly ok: true } | { readonly ok: false; readonly detail: string } {
  const path = providersFilePath(ctx);
  if (!ctx.writeFile(path, encodeDocument(next))) {
    return { ok: false, detail: `could not write ${path}` };
  }
  return { ok: true };
}

export function removeDeclaredProvider(
  ctx: ProvidersWiringContext,
  target: { readonly id: string },
): RemoveEditResult {
  const document = currentDocument(ctx);
  if ("code" in document) {
    return { ok: false, code: document.code, detail: document.detail };
  }

  const removed = removeDeclared(document, target.id);
  if (!removed.ok) {
    return { ok: false, code: removed.failure.code, detail: removed.failure.detail, ...(removed.failure.code === "unknown_provider" ? { known: removed.failure.known } : {}) };
  }

  const written = writeDocument(ctx, removed.value);
  if (!written.ok) {
    return { ok: false, code: "write_failed", detail: written.detail };
  }

  return { ok: true, id: target.id, clearedSelected: removed.clearedSelected, changed: [] };
}

export function editDeclaredProvider(
  ctx: ProvidersWiringContext,
  target: { readonly id: string; readonly endpoint?: string; readonly model?: string; readonly account?: string; readonly contextWindow?: number },
): RemoveEditResult {
  const document = currentDocument(ctx);
  if ("code" in document) {
    return { ok: false, code: document.code, detail: document.detail };
  }

  const edited = editDeclared(document, target.id, {
    ...(target.endpoint === undefined ? {} : { endpoint: target.endpoint }),
    ...(target.model === undefined ? {} : { model: target.model }),
    ...(target.account === undefined ? {} : { accountId: target.account }),
    ...(target.contextWindow === undefined ? {} : { contextWindow: target.contextWindow }),
  });
  if (!edited.ok) {
    return { ok: false, code: edited.failure.code, detail: edited.failure.detail, ...(edited.failure.code === "unknown_provider" ? { known: edited.failure.known } : {}) };
  }

  const written = writeDocument(ctx, edited.value);
  if (!written.ok) {
    return { ok: false, code: "write_failed", detail: written.detail };
  }

  const entry = edited.value.providers.find((item) => item.id === target.id);

  return {
    ok: true,
    id: target.id,
    clearedSelected: false,
    changed: edited.changed,
    ...(entry?.accountId === undefined ? {} : { accountId: entry.accountId }),
  };
}

/** Exit code for a failed remove/edit: bad id or patch is usage, the rest is config or disk. */
export function removeEditFailureExit(result: Extract<RemoveEditResult, { ok: false }>): ExitCode {
  if (result.code === "reserved_id" || result.code === "unknown_provider" || result.code === "missing_field") {
    return EXIT_CODES.USAGE;
  }

  if (result.code === "write_failed") {
    return EXIT_CODES.EXECUTION_FAILURE;
  }

  return DOCUMENT_EXIT_CODES[result.code];
}

/** The ids `providers add` may not take: they are the shipped providers. */
const RESERVED_DECLARED_IDS: ReadonlyArray<string> = [...PROVIDER_KINDS];

/**
 * The capability block a new declaration gets, from the same defaults the
 * decoder applies to a hand-written one.
 *
 * The declared model is also the declared model *list*, so `providers models
 * <id>` has something true to say; a run still reads `entry.model`, which is
 * the same string.
 */
function capabilitiesForNewDeclaration(kind: ProviderKind, endpoint: string, model: string, contextWindow?: number) {
  return {
    ...capabilitiesFor(kind, {}),
    models: [model],
    endpoint,
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };
}
