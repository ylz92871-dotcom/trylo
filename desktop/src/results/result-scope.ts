// Trylo Desktop — P2-1 (CODE-WORK-P2-1-UNIFIED-RESULT-DOCK-IMPLEMENTATION-SPEC).
//
// The single legal runtime partitition key for streamed results. Every
// result projector writes into the scope that produced the event; the UI
// subscribes only to the currently visible (projectKey, conversationId,
// mode). `turnId` associates a result with the originating user message —
// it is NOT a Run primary-key substitute (Work's `taskId` is a durable
// thread id and also cannot replace `runId`). Spec §4.1.

import type { FilePath } from '../host-adapter/types';

export type ResultMode = 'code' | 'work';

export interface RuntimeResultScope {
  readonly projectKey: string;
  readonly projectRoot: FilePath;
  readonly conversationId: string;
  readonly mode: ResultMode;
  readonly runId: string;
  readonly turnId: string;
  readonly startedAt: number;
}

/** Stable partition key. Nothing else may cross conversation / run
 *  boundaries on this key. */
export function resultScopeKey(scope: {
  readonly projectKey: string;
  readonly conversationId: string;
  readonly mode: ResultMode;
  readonly runId: string;
}): string {
  return [
    scope.projectKey,
    scope.conversationId,
    scope.mode,
    scope.runId,
  ].join('/');
}

/** Whether a later async snapshot/scan may still write to `scope` given
 *  the partition it was launched for (spec §13.2). This validates the
 *  TARGET partition, not whether the UI is still selected. */
export function sameResultScope(
  expected: RuntimeResultScope,
  actual: {
    readonly projectKey: string;
    readonly conversationId: string;
    readonly mode: ResultMode;
    readonly runId: string;
  },
): boolean {
  return (
    expected.projectKey === actual.projectKey &&
    expected.conversationId === actual.conversationId &&
    expected.mode === actual.mode &&
    expected.runId === actual.runId
  );
}