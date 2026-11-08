import type {
  CollaborationIssueControlResultV1,
  CollaborationIssueControlV1,
  CollaborationIssuesSnapshotV1,
} from '../../../new trylo cli/src/internal/protocol/collaboration-control'

export type {
  CollaborationIssueViewV1,
  CollaborationIssuesSnapshotV1,
  CollaborationIssueControlV1,
  CollaborationIssueControlResultV1,
} from '../../../new trylo cli/src/internal/protocol/collaboration-control'

/** The host supplies the real central control transport; this view owns no authority. */
export type CollaborationIssuesClient = {
  read(scope: string, signal: AbortSignal): Promise<CollaborationIssuesSnapshotV1>
  resolve(
    scope: string,
    control: CollaborationIssueControlV1,
    signal: AbortSignal,
  ): Promise<CollaborationIssueControlResultV1>
}
