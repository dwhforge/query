# Design — bounded scenario owner

Pure queryNavigation module resolves query/step destinations and revision-bound
JOIN targets, derives context transitions and exposes explicit openQuery,
inspectJoin, openMapping and openMatching commands via narrow effect ports.
App remains the adapter for React setters, editor hydration and layout. Existing
typed tabs remain navigation SoT; existing Mapping/Matching owners keep drafts.

Context revision advances on selection, view/mode, project or workspace revision.
Capture it before async panel work and validate against a live ref before applying
success, failure or progress. Reset diagnostics centrally rather than in each
Help Lab/Matching caller. Existing preview request generation remains authoritative
for preview; no second execution scheduler is introduced.

Render-only identical input preserves context identity; explicit semantic navigation
advances revision even for the same target, so Show me exits diagnostic samples.
View/tab transitions use the same central diagnostic reset as query/graph changes.
Opening a mounted Mapping activates its tab without re-merging the persisted map
over the independent editor draft.

Mounted Mapping Save API registration must not feed a new parent callback back
into a registration effect on every navigation render. Register by map identity
and owner availability, with live callback refs for Save capture/settlement. This
keeps the existing editor/store/acknowledgement owner, not a navigation-owned API.

Matching sessions carry an optional frontend-only captured target. Detached demos
have no target. Resolve against live project on render and again on invocation.
Missing/stale targets are disabled with explanation. Conservative query/side
revision validation prefers an honest unavailable result over a wrong JOIN.

Test pure resolution/transitions and stale checks, then focused real Electron
original-JOIN return, missing/replaced targets, Help Lab editor/Data/preview and
rapid switching. Keep unrelated known baseline failures separate.
