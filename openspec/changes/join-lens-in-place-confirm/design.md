# Design: join-lens-in-place-confirm

## Session model

Join Lens Auto (or successor panel) holds a **session proposal list** keyed by the
current Join (`host_query_id` + step index + remap column / composite slot):

| Field | Role |
|-------|------|
| `from` / optional `from_parts` | Left unmatched key |
| `to` (proposed) | Best right key |
| `runner_up` / candidates | Ambiguity UI |
| `score`, `ambiguous` | Ranking |
| `source` | `fuzzy` \| `llm` \| `manual` |
| `decision` | `accepted` \| `skipped` \| `pending` |

Unambiguous fuzzy rows start as `accepted`. Ambiguous and LLM rows start as
`pending` until the user picks. Dismiss / Cancel / change Join focus drops the
session list without touching the project.

## Confirm

**Apply accepted** collects `decision=accepted` rows and reuses the existing
Accept path into a KeyMap (create or append) plus ApplyKeyMap on the remap side.
No new IR step. Preview updates only after that fold.

## UX constraints

- Dispute row: accept best | pick runner-up | skip — without leaving Lens.
- Batch Apply is one control; do not require opening the KeyMap tab to finish.
- Show labels when the matcher had label columns; never require the KeyMap grid
  to display human names for the confirm step.

## Host

Reuse `join_key_near_miss` / `key_map_fuzzy_suggest` (and existing LLM chat for
leftovers). No new “auto merge ON” RPC. Optional later: a single suggest RPC that
returns the same shape the UI already stages.
