# Proposal: Unified Matching relationship workbench

## Status and review boundary

**Phase 1 only — proposed, no runtime implementation.** Baseline branch:
**feature/redesign**; HEAD **0c152c8fa0a8b86f037389617ba8eb9a8d24a9cd**;
working tree clean at inspection on 2026-11-15.

Decision: [proposed ADR-0052](../../../docs/adr/0052-matching-relationship-workbench.md).
Review order: this proposal → [deltas](specs/) → [design](design.md) →
[tasks](tasks.md). [Investigation](investigation.md) distinguishes observed code
from proposed behavior and historical verification reports from tests run now.

## Why

The user's acceptance criterion is that users see actual records, relationships
and the consequences of decisions, not the Matching algorithm. The current review
is organized around tiers, proposal statuses, technical target identifiers and
permanently competing controls. Reverse investigation is not a first-class
interaction, and existing session baseline arrays do not establish complete
Mapping coverage.

## In scope

- Reorganize the existing Matching tab around readable labelled LEFT/RIGHT values,
  candidate inspection and explicit confirmation, with a compact consequence view.
- Bidirectional navigation over the existing session, without changing decisions
  or rerunning retrieval merely because focus changes.
- Four relationship groups: executed JOIN, existing Mapping, confirmed draft,
  suggestions; separate completeness and cardinality evidence for each.
- Memoized sparse reverse indexes; scoped read-only Mapping projections; explicit
  executed-key inspection using existing Host operations.
- Collapsed Matching Rules, optional assistant panel, contextual bulk actions and
  expandable technical evidence. Preserve every existing plan/LLM/manual/review
  capability and conservative eligibility distinction.
- Focused components/services rather than growth of the monolithic workspace or
  App. Preserve original JOIN binding, stale guards and atomic Mapping + Apply.
- Real Electron/Host verification, Help Lab adaptation and documentation.

## Not in scope

Another workspace, map representation, authoritative ledger, persistence model,
matching algorithm, LLM orchestration, external matching engine, global assignment,
arbitrary alias lineage, unbounded dictionary browsing or broad App/store refactor.
No new RPC is proposed. Complete large external reverse inspection unavailable
through existing APIs must report that limitation, not quietly sample.

## Delivery phases and gates

1. **Architecture and UX contract (this delivery):** repository evidence, proposed
   decision, layout/navigation, provenance/coverage model, deltas and gated plan.
   Stop before runtime implementation and obtain architecture review.
2. **Data-centric workspace:** focused components; same operations and ledger;
   full LEFT workflow regression gate through real Host, Save and cold reopen.
   This intermediate phase is not final workbench acceptance.
3. **RIGHT → LEFT:** indexed relationships, Mapping visibility and explicit
   executed-key inspection, freshness/ABA protection and coverage/refusal tests.
4. **Integration/acceptance:** complete Electron matrix, adapted existing lab,
   regressions, evidence report and capability merge. No screenshot-only closure.

## Success criteria

Immediately answer: which LEFT record, which possible RIGHT records, which LEFT
records relate to this RIGHT and on what evidence, and what confirmation/write
would change. Suggestions, inspection selection, confirmation, Mapping write and
project-file Save remain visibly distinct. Partial evidence never gains write
authority or a claim of complete warehouse coverage.

## Existing work interaction

Build on [ADR-0051](../../../docs/adr/0051-unified-matching-workspace.md) and the
[merged Matching contract](../../specs/matching-workspace/spec.md), not a competing
change to its ledger. The [older active tasks](../unified-matching-workspace/tasks.md)
retain their residual performance, confidence-bulk and preview risks. This change
does not close them by documentation. Its own behavior deltas remain in flight
until implemented and verified; do not merge proposed behavior into the source
of truth at the end of Phase 1.
