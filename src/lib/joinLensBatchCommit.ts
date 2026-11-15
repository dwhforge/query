/** LOCAL ONLY: context fingerprints can contain credentials. Never persist/log receipts. */
export type TupleBatchCommitReceipt = {
  status: "applied";
  contextFingerprint: string;
  projectIdentity: string;
  joinStepIndex: number;
  appliedCount: number;
  /** Present only for the session-bound Matching transaction. */
  matchingSessionId?: string;
  matchingRunId?: string;
};
export type TupleBatchCommitResult = TupleBatchCommitReceipt | { status: "error"; error: string };
