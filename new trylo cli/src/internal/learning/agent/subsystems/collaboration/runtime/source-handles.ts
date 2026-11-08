type Row = Record<string, unknown>;

const row = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);

export type SourceHandles = Readonly<Record<string, string>>;

/** Private to one provider request. A handle can never shadow a known canonical reference. */
export function createSourceHandles(knownRefs: readonly string[] = []): SourceHandles {
  const canonical = new Set(knownRefs), handles: Record<string, string> = {};
  let ordinal = 1;

  for (const ref of canonical) {
    let handle = `R${ordinal++}`;
    while (canonical.has(handle)) handle = `R${ordinal++}`;
    handles[handle] = ref;
  }

  return handles;
}

/** Only reference fields expand. Unknown handles, shortened hashes and identity fields remain verbatim. */
export function expandActionSourceHandles(value: unknown, handles: SourceHandles): unknown {
  if (!row(value) || value.kind !== "propose" && value.kind !== "no_change") return value;

  const expand = (ref: unknown) => typeof ref === "string" && Object.hasOwn(handles, ref) ? handles[ref] : ref;
  const refs = (source: Row) => Array.isArray(source.sourceRefs) ? { sourceRefs: source.sourceRefs.map(expand) } : {};

  return { ...value, ...refs(value), ...(value.kind === "propose" && Array.isArray(value.experiences) ? {
    experiences: value.experiences.map(draft => !row(draft) ? draft : { ...draft, ...refs(draft),
      ...(typeof draft.parentVersion === "string" ? { parentVersion: expand(draft.parentVersion) } : {}) }),
  } : {}) };
}
