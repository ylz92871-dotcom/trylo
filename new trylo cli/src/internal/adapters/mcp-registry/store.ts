import {
  MCP_REGISTRY_FORMAT_VERSION,
  type McpAddInput,
  type McpEffectiveEntry,
  type McpRegistryEntryLocation,
  type McpRegistryFailure,
  type McpRegistryPort,
  type McpRegistryResult,
  type McpRegistryScopeView,
  type McpRegistryView,
  type McpScope,
  type McpServerEntry,
} from "../../ports/mcp-registry.js";
import {
  acquireLock,
  createRegistryIo,
  loadScope,
  releaseLock,
  storeScope,
  type LoadedScope,
  type McpRegistryStoreConfig,
  type RegistryIo,
} from "./registry-io.js";
import { publicViewOf, validateEntryShape } from "./validate.js";

export type { McpRegistryPaths, McpRegistryStoreConfig } from "./registry-io.js";

/**
 * Two JSON files, one registry.
 *
 * The file-level rules (whole-file replace, rename-not-truncate, one writer,
 * fail closed on read) live in `registry-io.ts`. What stays here is the scope
 * semantics: the two scopes are read and written independently. `list()`
 * merges them for display; nothing here ever writes one file from the other's
 * contents, so a project file cannot delete a user's entry by simply not
 * mentioning it.
 */

/**
 * Merge order, stated once: higher precedence wins on `enabled` and the
 * transport fields, and the losing scope is recorded in `shadowedScopes`.
 * Field-by-field merging (taking `command` from one scope and `env` from the
 * other) would produce a server neither file describes.
 */
const SCOPE_PRECEDENCE: Readonly<Record<McpScope, number>> = { user: 0, project: 1 };

export function createMcpRegistry(config: McpRegistryStoreConfig): McpRegistryPort {
  const io = createRegistryIo(config);
  return {
    add: async (input) => addEntry(io, input),
    remove: async (location) => removeEntry(io, location),
    setEnabled: async (location, enabled) => setEntryEnabled(io, location, enabled),
    listScope: async (scope) => listScopeView(io, scope),
    list: async () => listMergedView(io),
    resolve: async (name) => resolveEntry(io, name),
    names: async () => listNames(io),
  };
}

async function addEntry(
  io: RegistryIo,
  input: McpAddInput,
): Promise<McpRegistryResult<McpServerEntry>> {
  const shapeFailure = validateEntryShape(input);
  if (shapeFailure !== undefined) {
    return shapeFailure;
  }

  const lockFailure = acquireLock(io, input.scope);
  if (lockFailure !== undefined) {
    return lockFailure;
  }

  try {
    const loaded = loadScope(io, input.scope);
    if (!loaded.ok) {
      return loaded;
    }

    if (findEntry(loaded.document.servers, input.name) !== undefined) {
      // Refused rather than overwritten: making a user remove a server
      // explicitly is a small cost against silently repointing one.
      return {
        ok: false,
        code: "duplicate_entry",
        detail: `${input.name} already exists in the ${input.scope} registry`,
      };
    }

    const entry: McpServerEntry = {
      name: input.name,
      transport: input.transport,
      command: input.command,
      args: [...input.args],
      env: { ...input.env },
      enabled: input.enabled,
      ...(input.url === undefined ? {} : { url: input.url }),
      ...(input.headers === undefined ? {} : { headers: { ...input.headers } }),
    };
    const servers = [...loaded.document.servers, entry];
    const writeFailure = storeScope(io, input.scope, servers);
    if (writeFailure !== undefined) {
      return writeFailure;
    }

    return { ok: true, value: entry };
  } finally {
    releaseLock(io, input.scope);
  }
}

async function removeEntry(
  io: RegistryIo,
  location: McpRegistryEntryLocation,
): Promise<McpRegistryResult<McpServerEntry>> {
  const lockFailure = acquireLock(io, location.scope);
  if (lockFailure !== undefined) {
    return lockFailure;
  }

  try {
    const loaded = loadScope(io, location.scope);
    if (!loaded.ok) {
      return loaded;
    }

    const existing = findEntry(loaded.document.servers, location.name);
    if (existing === undefined) {
      return {
        ok: false,
        code: "missing_entry",
        detail: `${location.name} is not in the ${location.scope} registry`,
      };
    }

    const servers = loaded.document.servers.filter((entry) => entry.name !== location.name);
    const writeFailure = storeScope(io, location.scope, servers);
    if (writeFailure !== undefined) {
      return writeFailure;
    }

    return { ok: true, value: existing };
  } finally {
    releaseLock(io, location.scope);
  }
}

async function setEntryEnabled(
  io: RegistryIo,
  location: McpRegistryEntryLocation,
  enabled: boolean,
): Promise<McpRegistryResult<McpServerEntry>> {
  const lockFailure = acquireLock(io, location.scope);
  if (lockFailure !== undefined) {
    return lockFailure;
  }

  try {
    const loaded = loadScope(io, location.scope);
    if (!loaded.ok) {
      return loaded;
    }

    const existing = findEntry(loaded.document.servers, location.name);
    if (existing === undefined) {
      return {
        ok: false,
        code: "missing_entry",
        detail: `${location.name} is not in the ${location.scope} registry`,
      };
    }

    const next: McpServerEntry = { ...existing, enabled };
    const writeFailure = storeScope(io, location.scope, replaceEntry(loaded.document.servers, next));
    if (writeFailure !== undefined) {
      return writeFailure;
    }

    return { ok: true, value: next };
  } finally {
    releaseLock(io, location.scope);
  }
}

async function listScopeView(
  io: RegistryIo,
  scope: McpScope,
): Promise<McpRegistryResult<McpRegistryScopeView>> {
  const loaded = loadScope(io, scope);
  if (!loaded.ok) {
    return loaded;
  }

  return {
    ok: true,
    value: {
      scope,
      formatVersion: loaded.document.formatVersion,
      servers: loaded.document.servers,
    },
  };
}

async function listMergedView(io: RegistryIo): Promise<McpRegistryResult<McpRegistryView>> {
  const merged = mergeScopes(loadScope(io, "project"), loadScope(io, "user"));
  if (!merged.ok) {
    return merged;
  }

  return {
    ok: true,
    value: {
      formatVersion: MCP_REGISTRY_FORMAT_VERSION,
      servers: merged.value.map((item) => publicViewOf(item.entry, item.scopes)),
    },
  };
}

async function resolveEntry(
  io: RegistryIo,
  name: string,
): Promise<McpRegistryResult<McpEffectiveEntry>> {
  const merged = mergeScopes(loadScope(io, "project"), loadScope(io, "user"));
  if (!merged.ok) {
    return merged;
  }

  const found = merged.value.find((item) => item.entry.name === name);
  if (found === undefined) {
    return { ok: false, code: "missing_entry", detail: `${name} is not registered in any scope` };
  }

  return {
    ok: true,
    value: {
      entry: found.entry,
      scope: found.scopeOfOrigin,
      shadowedScopes: found.shadowedScopes,
    },
  };
}

async function listNames(io: RegistryIo): Promise<McpRegistryResult<ReadonlyArray<string>>> {
  const merged = mergeScopes(loadScope(io, "project"), loadScope(io, "user"));
  if (!merged.ok) {
    return merged;
  }
  return { ok: true, value: merged.value.map((item) => item.entry.name).sort() };
}

function findEntry(
  servers: ReadonlyArray<McpServerEntry>,
  name: string,
): McpServerEntry | undefined {
  return servers.find((entry) => entry.name === name);
}

function replaceEntry(
  servers: ReadonlyArray<McpServerEntry>,
  next: McpServerEntry,
): ReadonlyArray<McpServerEntry> {
  return servers.map((entry) => (entry.name === next.name ? next : entry));
}

// ---------------------------------------------------------------------------
// Pure merge. Kept outside the factory so it can be read as one rule.
// ---------------------------------------------------------------------------

type MergedEntry = {
  readonly entry: McpServerEntry;
  /** Which scope's values survived the merge. */
  readonly scopeOfOrigin: McpScope;
  /** Every scope that mentioned this name, for display. */
  readonly scopes: ReadonlyArray<McpScope>;
  readonly shadowedScopes: ReadonlyArray<McpScope>;
};

function mergeScopes(
  project: LoadedScope,
  user: LoadedScope,
): { readonly ok: true; readonly value: ReadonlyArray<MergedEntry> } | McpRegistryFailure {
  if (!project.ok || !user.ok) {
    // A broken scope makes the whole view unavailable. Returning "the other
    // scope's entries" would let a user act on a list that is quietly half.
    const failure = !project.ok ? project : user;
    return failure as McpRegistryFailure;
  }

  const byName = new Map<string, { entry: McpServerEntry; scopeOfOrigin: McpScope; scopes: McpScope[] }>();

  for (const scope of ["user", "project"] as const) {
    const source = scope === "user" ? user.document : project.document;
    for (const entry of source.servers) {
      const existing = byName.get(entry.name);
      if (existing === undefined) {
        byName.set(entry.name, { entry, scopeOfOrigin: scope, scopes: [scope] });
        continue;
      }

      existing.scopes.push(scope);

      if (SCOPE_PRECEDENCE[scope] > SCOPE_PRECEDENCE[existing.scopeOfOrigin]) {
        // The whole entry is replaced, never merged field by field: a server
        // assembled from two files is a server neither file describes.
        existing.entry = entry;
        existing.scopeOfOrigin = scope;
      }
    }
  }

  const merged: MergedEntry[] = [];

  for (const name of [...byName.keys()].sort()) {
    const item = byName.get(name);
    if (item === undefined) {
      continue;
    }

    merged.push({
      entry: item.entry,
      scopeOfOrigin: item.scopeOfOrigin,
      scopes: item.scopes,
      shadowedScopes: item.scopes.filter((scope) => scope !== item.scopeOfOrigin),
    });
  }

  return { ok: true, value: merged };
}
