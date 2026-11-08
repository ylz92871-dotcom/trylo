export const FRAGMENT_TYPES = [
  "user",
  "feedback",
  "project",
  "reference",
  "method",
] as const;

export type FragmentType = (typeof FRAGMENT_TYPES)[number];

export const FRAGMENT_STATES = ["pending", "active", "withdrawn"] as const;

export type FragmentState = (typeof FRAGMENT_STATES)[number];

export const FRAGMENT_ORIGINS = ["user-stated", "inferred"] as const;

export type FragmentOrigin = (typeof FRAGMENT_ORIGINS)[number];

export type Fragment = {
  readonly id: string;
  readonly type: FragmentType;
  readonly origin: FragmentOrigin;
  readonly scope: string;
  readonly version: number;
  readonly state: FragmentState;
  readonly body: string;
  readonly why?: string;
};

const FRAGMENT_TYPE_SET: ReadonlySet<string> = new Set(FRAGMENT_TYPES);
const FRAGMENT_STATE_SET: ReadonlySet<string> = new Set(FRAGMENT_STATES);
const FRAGMENT_ORIGIN_SET: ReadonlySet<string> = new Set(FRAGMENT_ORIGINS);

export function isFragmentType(value: string): value is FragmentType {
  return FRAGMENT_TYPE_SET.has(value);
}

export function isFragmentState(value: string): value is FragmentState {
  return FRAGMENT_STATE_SET.has(value);
}

export function isFragmentOrigin(value: string): value is FragmentOrigin {
  return FRAGMENT_ORIGIN_SET.has(value);
}

export function parseFragment(value: unknown): Fragment {
  if (!isRecord(value)) {
    throw new Error("fragment is not an object");
  }

  const id = requiredString(value, "id");
  const type = requiredString(value, "type");
  const origin = requiredString(value, "origin");
  const scope = requiredString(value, "scope");
  const body = requiredString(value, "body");
  const state = requiredString(value, "state");
  const version = value.version;

  if (!isFragmentType(type)) {
    throw new Error(`unknown fragment type: ${type}`);
  }

  if (!isFragmentOrigin(origin)) {
    throw new Error(`unknown fragment origin: ${origin}`);
  }

  if (!isFragmentState(state)) {
    throw new Error(`unknown fragment state: ${state}`);
  }

  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new Error("fragment version must be an integer >= 1");
  }

  const fragment: Fragment = { id, type, origin, scope, version, state, body };

  if (typeof value.why === "string" && value.why.length > 0) {
    return { ...fragment, why: value.why };
  }

  return fragment;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`fragment.${key} must be a non-empty string`);
  }
  return field;
}
