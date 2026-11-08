/** Host coordinates are frozen before the independent checker runs. No caller-supplied verdict enters learning. */
export type CollaborationCheckSubjectV2 = {
  readonly scope: string;
  readonly teamRunId: string;
  readonly taskId: string;
  readonly memberId: string;
  readonly round: number;
  readonly episodeId: string;
  readonly artifactRef: string;
  readonly contentHash: string;
  readonly requirementsDigest: string;
  readonly generatorId: string;
};

export type CollaborationCheckReceiptV2 = {
  readonly schemaVersion: 2;
  readonly runRef: string;
  readonly subject: CollaborationCheckSubjectV2;
  readonly checkerId: string;
  readonly checkerVersion: string;
  readonly checksDigest: string;
  readonly verdict: "passed" | "failed" | "partial";
  readonly recordedAt: string;
};

/** Only an independent checker composition owns this reader and its immutable run records. */
export type CollaborationCheckerReaderV2 = {
  read(runRef: string, expected: CollaborationCheckSubjectV2): Promise<
    { readonly ok: true; readonly receipt: CollaborationCheckReceiptV2 } | { readonly ok: false; readonly reason: string }>;
};
