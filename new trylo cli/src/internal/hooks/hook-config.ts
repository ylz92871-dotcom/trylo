/**
 * WP17.1 — hook configuration, matching, and selection.
 *
 * Pure mechanical layer ported from the old CLI, same language, no runtime
 * borrowed: `matchesPattern` (`utils/hooks.ts`), matcher grouping and
 * source-priority ordering (`hooksSettings.ts` / `hooksConfigManager.ts`),
 * disable scoping (`hooksConfigSnapshot.ts`).
 *
 * What is deliberately *not* ported: `getAllHooks` (it reaches into
 * AppState/bootstrap/settings — the old runtime's big state steward, which
 * the work package forbids copying) and the executors themselves (they live
 * behind the ports in `hook-ports.ts`, so the config layer never spawns).
 *
 * Matching is call-site supplied: the runner hands over one string per event
 * (tool name for tool events, agent type for subagent events, path for file
 * events). Which field a matcher applies to is therefore the trigger site's
 * documented choice, not a second matcher language hiding in this file.
 */

import { isMatcherEvent, type HookEvent } from "./hook-events.js";

/** Where a hook was declared. Earlier in the order runs earlier. */
export type HookSource = "user" | "project" | "managed" | "session";

export const HOOK_SOURCE_ORDER: ReadonlyArray<HookSource> = ["user", "project", "managed", "session"];

export type HookKind = "command" | "http" | "prompt" | "agent";

type HookConfigBase = {
  readonly id: string;
  readonly event: HookEvent;
  readonly source: HookSource;
  /** Absent or empty means "every value". See {@link matchesMatcher}. */
  readonly matcher?: string | undefined;
};

export type HookConfig =
  | (HookConfigBase & {
      readonly kind: "command";
      readonly command: ReadonlyArray<string>;
      readonly timeoutMs: number;
    })
  | (HookConfigBase & {
      readonly kind: "http";
      readonly url: string;
      readonly allowedUrlPatterns: ReadonlyArray<string>;
      readonly timeoutMs: number;
    })
  | (HookConfigBase & {
      readonly kind: "prompt";
      readonly prompt: string;
      readonly timeoutMs: number;
      readonly maxDepth?: number | undefined;
    })
  | (HookConfigBase & {
      readonly kind: "agent";
      readonly task: string;
      readonly timeoutMs: number;
      readonly maxDepth?: number | undefined;
      readonly maxTurns: number;
    });

export type HookStore = {
  readonly hooks: ReadonlyArray<HookConfig>;
  readonly disabledIds?: ReadonlySet<string> | undefined;
  /** Fail-closed master switch: set means no hook fires. */
  readonly disableAll?: boolean | undefined;
};

function sourceRank(source: HookSource): number {
  const rank = HOOK_SOURCE_ORDER.indexOf(source);
  return rank < 0 ? HOOK_SOURCE_ORDER.length : rank;
}

/**
 * Whether one hook's matcher accepts one trigger value.
 *
 * Ported branch-for-branch from the old CLI `matchesPattern`
 * (`trylo cli/src/utils/hooks.ts`, verified 2026-10-06):
 *
 * 1. Absent/empty/`*` match everything.
 * 2. A matcher of only `[a-zA-Z0-9_|]` is matched EXACTLY — pipe branches by
 *    membership, a bare word by equality — and returns immediately. There is
 *    deliberately no regex fallthrough here: `Bash` must not fire on
 *    `BashTool`, and `Write|Edit` must not fire on `WriteFile`. An earlier
 *    revision of this file fell through to the regex and over-triggered;
 *    the truth-table test below pins the exact semantics.
 * 3. Anything else is a regular expression over the value; an invalid
 *    expression matches nothing.
 *
 * Two deliberate deviations, both documented rather than silently copied:
 * the old CLI normalises old→new tool renames (`normalizeLegacyToolName`)
 * and also tests regexes against legacy aliases (`getLegacyToolNames`).
 * This CLI's trigger values are its own canonical names with no legacy
 * aliases, so there is nothing to normalise — porting that map would be
 * cargo-culting another CLI's rename history.
 */
export function matchesMatcher(matcher: string | undefined, value: string): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*") {
    return true;
  }

  if (/^[a-zA-Z0-9_|]+$/.test(matcher)) {
    if (matcher.includes("|")) {
      return matcher
        .split("|")
        .map((branch) => branch.trim())
        .includes(value);
    }
    return value === matcher;
  }

  try {
    return new RegExp(matcher).test(value);
  } catch {
    // An unparsable matcher is a hook that cannot name its trigger. Running
    // it anyway would turn a typo into "run on everything".
    return false;
  }
}

function compareHooks(left: HookConfig, right: HookConfig): number {
  const bySource = sourceRank(left.source) - sourceRank(right.source);
  if (bySource !== 0) {
    return bySource;
  }

  const leftMatcher = left.matcher ?? "";
  const rightMatcher = right.matcher ?? "";
  if (leftMatcher !== rightMatcher) {
    return leftMatcher < rightMatcher ? -1 : 1;
  }

  if (left.id !== right.id) {
    return left.id < right.id ? -1 : 1;
  }

  return 0;
}

/**
 * The hooks that fire for one trigger, each at most once, in stable order.
 *
 * Order is source priority, then matcher, then id — the old CLI's
 * "SOURCES priority + matcher lexicographic" rule. Disabling is a read-time
 * filter: the store is never rewritten by selection.
 */
export function selectHooks(store: HookStore, event: HookEvent, matchValue: string): Array<HookConfig> {
  if (store.disableAll === true) {
    return [];
  }

  const matcherApplies = isMatcherEvent(event);
  const selected = store.hooks.filter((hook) => {
    if (hook.event !== event) {
      return false;
    }

    if (store.disabledIds?.has(hook.id) === true) {
      return false;
    }

    return matcherApplies ? matchesMatcher(hook.matcher, matchValue) : true;
  });

  selected.sort(compareHooks);

  return selected;
}
