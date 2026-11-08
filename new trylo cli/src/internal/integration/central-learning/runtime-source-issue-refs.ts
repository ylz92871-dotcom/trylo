/** These two addresses are authored together for one exact issueView digest.
 * Recognizing their relationship grants neither body reading nor notice ack. */
export function centralIssueSourceRefs(digest: string): { readonly body: string; readonly notice: string } {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("central_issue_source_digest_invalid");
  return { body: `central-runtime-issue:${digest}`, notice: `central-runtime-issue-notice:${digest}` };
}

export function isConsideredCentralIssueNotice(ref: string, considered: ReadonlySet<string>): boolean {
  const match = /^central-runtime-issue-notice:([a-f0-9]{64})$/.exec(ref);
  return match !== null && considered.has(centralIssueSourceRefs(match[1]!).body);
}
