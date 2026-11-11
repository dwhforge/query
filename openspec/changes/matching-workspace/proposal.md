# Proposal: matching-workspace

## Why

Contextual mapping needs a dedicated workplace: structured plan, proposals and
alternatives, draft decisions, then Save into an existing Mapping. Join Lens
**Quick match** ([ADR-0042](../../../docs/adr/0042-join-lens-in-place-confirm.md))
covers fast batches under current Lens rules. Matching covers multi-field /
constraint-heavy review. Split by **task complexity**, not by LLM usage.
Guards (host validation, merge rules, caps) ship before “smart” generation.

## In scope

- Matching workspace tab + structured plan editor (chat optional)
- Explicit UX boundary and copy vs Lens Auto / Mapping editor
- Contracts: task / plan (semantic vs UI revision) / proposal / decision
- Numeric first-slice run caps aligned or justified vs HEAD fuzzy/LLM limits
- Host-side trust boundary: renderer sends candidate/proposal ids + revisions;
  host materializes outputs
- Merge / bulk confirm matrix + fixtures **before** polished UI
- Draft confirm / final diff → existing Mapping Save paths
- Session lifecycle banner (no restart restore) + limited-preview product gate
- ADR-0044; reuse multi-output, dirty-delta, import write policy, ApplyPlan
  (post-Save only)

## Out of scope

- Auto-accept + auto-Save of LLM decisions
- Global one-to-one assignment
- LLM inside runtime Apply
- New map storage / typed outputs / temporal semantics
- Durable session restore across restart (blocks “full workplace” positioning)
- Save-as-Seed for live Postgres relations; dbt migration / DDL
- New graph profiler engines; implicit rule learning from one choice
- Dual identically labelled Auto/AI buttons with different behaviour

## Success

- Forged / stale / conflicting proposals cannot be silently accepted or Saved
  (proven via host/application API tests, not UI alone).
- User can explain the task in the plan editor, inspect alternatives, confirm
  consciously, and Save only those draft decisions.
- Incomplete retrieval is never shown as proven non-match.
- Read-only maps refuse write-back via the shared write command.
- Without restart persistence, Matching is positioned only as capped preview.

## Baseline

- SHA: `60e68ee88a78316bf439260d2662c3065808ecd6` (`feature/matching`)
- Agents re-verify against current HEAD before code changes

## References

- [ADR-0044](../../../docs/adr/0044-matching-workspace.md)
- [ADR-0042](../../../docs/adr/0042-join-lens-in-place-confirm.md)
- [ADR-0038](../../../docs/adr/0038-keymap-apply-operation.md)
- [ADR-0037](../../../docs/adr/0037-keymap-multi-output.md)
- [ADR-0022](../../../docs/adr/0022-keymap-postgres-live-bind.md)
- [ADR-0020](../../../docs/adr/0020-join-key-mapping.md)
- [ADR-0019](../../../docs/adr/0019-join-lens-ai-narrator.md)
