# Proposal: Reproduced preview-state confidence fixes (PR-04)

Electron reproducers on PR-03 confirmed old rows under a new query while a preview
was held, nonterminal local Cancel, and an ambiguous waiting state after actual
host failure. Additional offline reproducers confirmed missing ready-empty text
and Load full being hidden for a heavy query with no Join. Fix these using [ADR-0031](../../../docs/adr/0031-execution-lifecycle.md)
generation guards, existing error/progress UI and [ADR-0041](../../../docs/adr/0041-heavy-preview-sample.md)
sample policy. Add explicit sample/scope labels and a recompute action; no new shell,
engine, IR, diagnostic backend or automatic mapping success.

Review: proposal → [spec](specs/execution-lifecycle/spec.md) → [design](design.md) → [tasks](tasks.md).
