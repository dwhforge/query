# Proposal: Unified Matching Workspace

Status: architecture approved on 2026-11-15 / implementation not started.
Phase 1 is documentation only. Baseline supplied by parent:
30ead1dfd6e30b76865ca19d7b7d696134a4db18. No implementation or new tests claimed.

Decision: [ADR-0051](../../../docs/adr/0051-unified-matching-workspace.md).
Review order: this proposal → [spec deltas](specs/) → [design](design.md) →
[implementation tasks](tasks.md).

## Why

The existing Lens batch has working tuple fuzzy/LLM algorithms, explicit decisions
and atomic Mapping + Apply, while the existing Matching tab provides plan and
review infrastructure but ordinary UI trials truthfully report live unavailable.
Reusing both avoids a second UI, second engine and duplicated decisions.

## In scope

- One existing Matching tab, one proposal/candidate model, one decision ledger.
- Basic adapts real batch tuple results; Advanced edits evidence/ranking in the
  same session and later uses actual Host-acquired fields with contextual retrieval.
- Both JOIN-origin paths lock original ordered LEFT keys → RIGHT outputs;
  candidate record identity is independent. Both use atomic Mapping + Apply.
- Lazy right candidate detail in existing review, honest incomplete coverage,
  conservative bulk eligibility, explicit receipt acknowledgement and refresh.
- Preserve Suggest Right, demo separation, Mapping-origin Save, existing storage,
  permissions, lifecycle and runtime validation.
- Preserve the agreed Join Lens No match / Candidates selector and existing
  Suggest Right modal. Advanced remains in this same change after the Basic gate.
- Phase 4 implements that Lens selector as **read-only single-source inspection**:
  lazy bounded full-tuple candidates through the existing Suggest Right Host RPC,
  not another Matching review, extra-lookup acceptance path or Mapping writer.

## Not in scope

New UI/engine/store, detachment or Mapping-only transitions, arbitrary output
rebinding, new persistence format, durable drafts, new warehouse writes, global
one-to-one assignment, automatic fuzzy JOIN conditions, or external snapshot guarantees.

## Acceptance milestones

1. Architecture review only: contract and exact integration plan recorded; tasks
   remain unchecked and merged specs still describe shipped behavior.
2. Basic real integration: existing Matching review consumes actual Rust tuple
   fuzzy and optional batch LLM alternatives; no mutation until explicit write;
   real Electron Mapping/Apply/execution/Save/cold-reopen and negative guards pass.
3. Advanced after Basic gate: confirmed selected fields acquired through Host from
   actual JOIN inputs, contextual retrieval/LLM reuse, same decisions and commit
   authority; constraint/evidence/caps regression tests pass without fixtures.
4. Final release: review evidence and gaps, amend cross-references/product copy,
   merge delivered deltas to capability SoT and only then complete the change.
