# Query workspace and Inspector ownership

Merged from [PR-05](../../changes/query-workspace-inspector/proposal.md), under
[ADR-0032](../../../docs/adr/0032-ui-host-decomposition.md). Existing execution,
navigation, lifecycle, workspace-tab and Matching contracts remain authoritative.

## Requirements

### Requirement: Functional Query composition
QueryWorkspace SHALL compose the query pipeline, result dock and Inspector.
The shell SHALL retain top-level tool tabs and mounted Mapping/Matching owners.
Existing application transformations remain the authoring source of truth.
Narrow named integration slots MAY retain cross-tool Lens workflows in App;
they SHALL NOT expose a general setter bag or own editor drafts.

### Requirement: Identity-scoped local editors
Inspector drafts SHALL be local to a concrete project/query/step editor.
Changing editor identity SHALL hydrate from that target, never another query's
same-index step. Applying a draft SHALL preserve its exact visible input,
including whitespace and comma formatting, even if committed IR is normalized.
Recompute, async column replies and tool tab navigation SHALL NOT reseed input.
Schema replies SHALL be ignored after target changes and supply choices only.

#### Scenario: Commit and recompute
Type a formatted Filter or GroupBy draft, Apply, then Recompute and switch tool
tabs. The same editor retains the exact draft and the committed project is dirty.

#### Scenario: Switch target during schema request
Start a column request, select another query/step and type. The old reply cannot
overwrite or hydrate the new editor. Same-index same-kind steps remain distinct.

### Requirement: Preserved scenario owners
Navigation/focus, lifecycle dirty/save/error/replacement, independent preview and
Join resets, original Matching Join return, stable Mapping Save registration,
demo nonwrite/live unavailable and lab assistance SHALL remain unchanged.
