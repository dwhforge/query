# Proposal: Matching Save acknowledgement (PR-00A)

Repair the existing ADR-0044 final Save contract without changing host IPC,
project formats, runtime Apply, retrieval, or workspace architecture.

Scope: separate validated commit planning from persistence acknowledgement;
check live Mapping data and actual Save outcomes; retain retryable confirmed
drafts on refusal/conflict/error/cancellation. Preserve existing source-map
exact-key reads, dirty-delta concurrency, and import policy.

Review order: proposal → specs → design → tasks. Assignment review and baseline:
[baseline report](../../../docs/stabilization/PR-00A-baseline.md).
