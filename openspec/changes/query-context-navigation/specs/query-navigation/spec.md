# Query navigation

## Requirements

### Requirement: One explicit semantic navigation route

Query/step selection, Help Lab Show me/comparison and Matching Lens return SHALL
use the same small command owner. Resolved selection SHALL hydrate the existing
editor and use the existing preview input; navigation SHALL NOT publish focus,
replace the project or reset Mapping/Matching owners. Layout collapse SHALL stay
explicit; Help Lab Show me SHALL NOT collapse layout or steal keyboard focus.

### Requirement: Ephemeral current context and stale completion refusal

Frontend-only context SHALL identify project, query, step, view/mode and a
revision. Selection, graph revision or project changes SHALL invalidate old
diagnostics and selected-step assumptions. Async navigation/panel handoffs SHALL
ignore completion after their captured context changes, including switch-away/
back and changed JOIN payload. No context SHALL be added to persisted IR.

#### Scenario: Return to the same selection
- WHEN explicit navigation returns to the already-selected Join or switches away and back
- THEN earlier diagnostic work is invalidated and stale loading/panel state is cleared
- AND Show me restores the ordinary preview rather than leaving a diagnostic sample open

### Requirement: Matching returns to its original JOIN

Matching opened from Lens SHALL retain a revision-bound original host query and
JOIN index. Open Mapping in Lens SHALL select that original target even after
another Query is selected. Missing/replaced/changed targets or detached sessions
SHALL disable the action with an unavailable explanation and SHALL NOT fall back
to the current JOIN. Ordinary navigation SHALL preserve the Matching draft.

#### Scenario: Another query is now active
- WHEN Matching's original target is unchanged and another query is selected
- THEN Lens return selects the original host/JOIN and hydrates its editor
- AND the current project identity, export focus and Matching draft are preserved

#### Scenario: Target no longer matches
- WHEN the original query/JOIN is deleted, moved or semantically changed
- THEN Lens return is unavailable and no arbitrary current JOIN is selected

### Requirement: Preserve prior delivery boundaries

Typed tab identities, mounted drafts, replacement-only resets, honest sample
previews, explicit non-writing demo origin, live-unavailable and acknowledged
Mapping Save SHALL remain unchanged.
