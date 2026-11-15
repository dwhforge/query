# Delta: Join Lens No match — read-only Candidates

Decision: [ADR-0051](../../../../../docs/adr/0051-unified-matching-workspace.md).
Delivered Candidates requirements merged on 2026-11-15. The existing Suggest Right modal is preserved.

## ADDED Requirements

### Requirement: Right selector exists only under No match

Join Lens SHALL retain only All rows and No match investigation modes, with one
Find Matches action opening the existing Matching workspace. RIGHT under No match
SHALL offer No match / Candidates. No match SHALL retain its existing diagnostic
unmatched-right list, filter, source Suggest action and explicit mapping workflow.
Candidates SHALL NOT introduce contextual/batch review, acceptance, LLM calls or writes.

### Requirement: One exact selected full source tuple

Candidates SHALL inspect one full ordered nullable LEFT tuple for 1–5 Join pairs,
preferring the selected LEFT card, otherwise the active unmatched ordinary result.
Missing source columns, right-only selection and hypothetical pairs SHALL NOT be
interpreted as a source. NULL, empty, significant whitespace, literal symbols and
embedded delimiters SHALL retain distinct identities. Every returned target SHALL
be one actual full ordered RIGHT tuple from existing Host tuple retrieval, not a
combination of fields from different targets. It SHALL NOT be restricted to right
unmatched diagnostics or filter out targets already joining elsewhere.

### Requirement: Bounded read-only evidence

Candidates SHALL display up to eight targets ordered by existing Host mean score,
with full values, counts and expandable ordered field differences/scores. Unknown
scores SHALL remain unknown. Totals, retrieved universe, truncation and incomplete
competitor coverage SHALL be explicit; Top-K SHALL NOT imply dataset-wide ranking
or automatic selection. The existing engine and tuple RPC SHALL be reused unchanged.

### Requirement: Lazy and context-safe retrieval

First opening MAY retrieve for the current source. Changing selection while open
SHALL NOT prefetch; explicit Find candidates retrieves the new source. A local
bounded LRU of at most sixteen source results MAY serve exact cache hits. Project
identity/session, workspace, connection, source, reference and JOIN changes SHALL
invalidate cached evidence. Late replies/errors after selection or context ABA,
closing/hiding, and unmount SHALL NOT publish results or revive old loading state.
No persistent cache or external in-place data freshness guarantee is introduced.

#### Scenario: A target already joins another source
- GIVEN the unmatched-right diagnostic list is empty
- AND the selected unmatched source resembles a real right tuple already used by another left row
- WHEN Candidates opens
- THEN that full right tuple remains eligible for read-only inspection
- AND no Mapping or project change occurs
- AND Suggest Right still opens its existing independent confirmation modal
