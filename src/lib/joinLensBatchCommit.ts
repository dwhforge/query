/** LOCAL ONLY: context fingerprints can contain credentials. Never persist/log receipts. */
export type TupleBatchCommitReceipt = {
  status: "applied";
  contextFingerprint: string;
  projectIdentity: string;
  joinStepIndex: number;
  appliedCount: number;
};
export type TupleBatchCommitResult = TupleBatchCommitReceipt | { status: "error"; error: string };
