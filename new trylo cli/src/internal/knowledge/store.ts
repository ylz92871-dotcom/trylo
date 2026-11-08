import { existsSync } from "node:fs";
import { readFile, rename } from "node:fs/promises";
import path from "node:path";
import {
  createBoardReader,
  withBoardWriter,
} from "../adapters/learning-store/file-event-store.js";
import type { BoardCommand } from "../learning/control/commands.js";
import type { LearningProposal } from "../learning/control/contracts.js";
import type { BoardState } from "../learning/control/state.js";
import { parseFragment, type Fragment } from "./fragment.js";

const LEGACY_FILE = "fragments.json";

export type FragmentStore = {
  readonly rootDir: string;
  readAll(): Promise<Fragment[]>;
  write(fragment: Fragment): Promise<void>;
  remove(id: string): Promise<void>;
};

export function createFragmentStore(rootDir: string): FragmentStore {
  return {
    rootDir,
    async readAll() {
      return readFragments(rootDir);
    },
    async write(fragment) {
      const result = await withBoardWriter(rootDir, async (store) => {
        const loaded = await store.load();
        if (!loaded.ok) {
          throw new Error(`${loaded.reason}: ${loaded.detail}`);
        }

        const commands = commandsForWrite(fragment, loaded.state);

        for (const command of commands) {
          const applied = await store.apply(command);
          if (!applied.ok) {
            throw new Error(`${applied.reason}: ${applied.detail}`);
          }
        }
      });
      if (result !== undefined && "ok" in result && result.ok === false) {
        throw new Error(`${result.reason}: ${result.detail}`);
      }
    },
    async remove(id) {
      const result = await withBoardWriter(rootDir, (store) =>
        store.apply({
          type: "tombstone",
          commandId: `frag:tombstone:${id}`,
          issuedAt: issuedAt(),
          entityId: id,
          // fragment.id 即该 user_rule 资产的 versionId：remove 的语义是删除这条
          // 资产实体（Board 退役其激活），因此按 entityType=asset 精确限定作用域
          // （外审 P1-1：tombstone 不再跨实体空间产生副作用）。
          entityType: "asset",
          reason: "remove",
        }),
      );
      if (result !== undefined && "ok" in result && result.ok === false) {
        throw new Error(`${result.reason}: ${result.detail}`);
      }
    },
  };
}

export async function loadBoardOrThrow(rootDir: string): Promise<BoardState> {
  const reader = createBoardReader(rootDir);
  const loaded = await reader.load();
  if (!loaded.ok) {
    throw new Error(`${loaded.reason}: ${loaded.detail}`);
  }
  return loaded.state;
}

export function boardFilesExist(rootDir: string): boolean {
  return (
    existsSync(path.join(rootDir, "board-events.ndjson")) ||
    existsSync(path.join(rootDir, "board-snapshot.json"))
  );
}

export async function ensureMigrated(rootDir: string): Promise<void> {
  if (boardFilesExist(rootDir)) {
    return;
  }

  const file = path.join(rootDir, LEGACY_FILE);
  if (!existsSync(file)) {
    return;
  }

  const fragments = await readLegacy(rootDir);
  if (fragments.length === 0) {
    return;
  }

  const result = await withBoardWriter(rootDir, async (store) => {
    for (const fragment of fragments) {
      const loaded = await store.load();
      if (!loaded.ok) {
        throw new Error(`${loaded.reason}: ${loaded.detail}`);
      }

      for (const command of commandsForWrite(fragment, loaded.state)) {
        const applied = await store.apply(command);
        if (!applied.ok) {
          throw new Error(`${applied.reason}: ${applied.detail}`);
        }
      }
    }
  });
  if (result !== undefined && "ok" in result && result.ok === false) {
    throw new Error(`${result.reason}: ${result.detail}`);
  }

  await rename(file, `${file}.migrated`);
}

async function readFragments(rootDir: string): Promise<Fragment[]> {
  await ensureMigrated(rootDir);
  if (boardFilesExist(rootDir)) {
    const state = await loadBoardOrThrow(rootDir);
    return projectFragments(state);
  }
  return [];
}

async function readLegacy(rootDir: string): Promise<Fragment[]> {
  const file = path.join(rootDir, LEGACY_FILE);
  let raw: string;

  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (isNotFound(err)) {
      return [];
    }
    throw err;
  }

  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("fragments.json is not an array");
  }

  return parsed.map(parseFragment);
}

function projectFragments(state: BoardState): Fragment[] {
  // Tombstone 现按 entityType 限定作用（外审 P1-1）：proposal 撤回与 asset 删除
  // 都会把对应 id 的 fragment 从投影里隐藏；observation/fragment 等
  // 不落资产实体的 tombstone 不影响 fragment 视图。
  const removed = new Set(
    state.tombstones
      .filter((item) => item.entityType === "asset" || item.entityType === "proposal")
      .map((item) => item.entityId),
  );
  const fragments: Fragment[] = [];

  for (const proposal of state.proposals) {
    if (removed.has(proposal.proposalId)) {
      continue;
    }
    fragments.push(fragmentFromProposal(state, proposal));
  }

  return fragments;
}

function fragmentFromProposal(state: BoardState, proposal: LearningProposal): Fragment {
  const asset = state.assets.find(
    (item) => item.createdFromProposalId === proposal.proposalId,
  );
  const activation = state.activations.find(
    (item) => item.scope === proposal.scope && item.assetKind === proposal.assetKind,
  );
  const active =
    proposal.lifecycle === "active" &&
    activation?.pointer === "active" &&
    (asset === undefined || activation.versionId === asset.versionId);
  const stateName: Fragment["state"] = active
    ? "active"
    : proposal.lifecycle === "rejected" ||
        proposal.lifecycle === "retired" ||
        proposal.lifecycle === "suspended" ||
        proposal.lifecycle === "rolled_back"
      ? "withdrawn"
      : "pending";
  const fragment: Fragment = {
    id: proposal.proposalId,
    type: proposal.source === "user_explicit" ? "feedback" : "method",
    origin: proposal.source === "user_explicit" ? "user-stated" : "inferred",
    scope: proposal.scope,
    version: 1,
    state: stateName,
    body: typeof asset?.content === "object" && asset.content !== null && "text" in asset.content
      ? String((asset.content as { text: unknown }).text)
      : proposal.hypothesis,
  };

  return fragment;
}

function commandsForWrite(fragment: Fragment, state: BoardState): BoardCommand[] {
  const issued = issuedAt();

  if (fragment.state === "withdrawn") {
    const existing = state.proposals.find((item) => item.proposalId === fragment.id);
    if (existing?.lifecycle === "active") {
      return [
        {
          type: "suspend",
          commandId: `frag:suspend:${fragment.id}`,
          issuedAt: issued,
          proposalId: fragment.id,
          breakerReason: "withdrawn",
        },
      ];
    }

    if (existing !== undefined) {
      return [
        {
          type: "reject",
          commandId: `frag:reject:${fragment.id}`,
          issuedAt: issued,
          proposalId: fragment.id,
          reason: "withdrawn",
        },
      ];
    }

    return [
      {
        type: "submit_proposal",
        commandId: `frag:submit:${fragment.id}`,
        issuedAt: issued,
        proposal: draftFrom(fragment),
      },
      {
        type: "reject",
        commandId: `frag:reject:${fragment.id}`,
        issuedAt: issued,
        proposalId: fragment.id,
        reason: "withdrawn",
      },
    ];
  }

  if (fragment.origin === "inferred") {
    return [
      {
        type: "submit_proposal",
        commandId: `frag:submit:${fragment.id}`,
        issuedAt: issued,
        proposal: draftFrom(fragment),
      },
      {
        type: "quarantine",
        commandId: `frag:quarantine:${fragment.id}`,
        issuedAt: issued,
        proposalId: fragment.id,
      },
    ];
  }

  const versionId = fragment.id;

  return [
    {
      type: "submit_proposal",
      commandId: `frag:submit:${fragment.id}`,
      issuedAt: issued,
      proposal: draftFrom(fragment),
    },
    {
      type: "fast_lane_validate",
      commandId: `frag:validate:${fragment.id}`,
      issuedAt: issued,
      proposalId: fragment.id,
    },
    {
      type: "commit_asset",
      commandId: `frag:asset:${fragment.id}`,
      issuedAt: issued,
      proposalId: fragment.id,
      versionId,
      content: { text: fragment.body },
      schemaVersion: 1,
    },
    {
      type: "activate",
      commandId: `frag:activate:${fragment.id}`,
      issuedAt: issued,
      proposalId: fragment.id,
      versionId,
    },
  ];
}

function draftFrom(fragment: Fragment) {
  return {
    proposalId: fragment.id,
    domain: "user" as const,
    scope: fragment.scope,
    assetKind: "user_rule" as const,
    candidateRef: fragment.id,
    hypothesis: fragment.body,
    observationRefs: [],
    risk: "low" as const,
    requiredVerifiers: [],
    requestedAuthorities: [],
    source: fragment.origin === "user-stated" ? ("user_explicit" as const) : ("inferred" as const),
  };
}

function issuedAt(): string {
  return "2026-09-12T00:00:00.000Z";
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}


