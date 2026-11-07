# Proposal: join-lens-in-place-confirm

## Why

Fuzzy / LLM can propose join-key aliases quickly, but reviewing them in a KeyMap
grid (often ids-only) forces extra navigation. Decisions belong in Join Lens,
where both sides and scores are visible. Silent fuzzy Join ON stays forbidden
([ADR-0019](../../../docs/adr/0019-join-lens-ai-narrator.md),
[ADR-0020](../../../docs/adr/0020-join-key-mapping.md)).

## In scope

- Session staging of match proposals inside Join Lens (keys, labels, score,
  ambiguous / runner-up)
- Unambiguous proposals pre-accepted in session; disputed rows resolved with
  one-click choices (best / runner-up / skip)
- Single **Apply accepted** → KeyMap rows + ApplyKeyMap on the graph
- Optional LLM leftovers feed the same Lens queue (no Join ON writes)
- ADR-0042; composite slot rules from ADR-0024 unchanged

## Out of scope

- Automatic fuzzy merge into Join ON
- Using KeyMap editor as the primary dispute UI
- Changing Apply uniqueness / ready-map / export SoT rules
- New mapping cardinalities or universal schema mapper

## Success

- User can run Auto on a Join, confirm disputed pairs in Lens without opening a
  KeyMap tab for each row, and Apply once into a durable map.
- Unconfirmed session proposals never change preview SQL or export.
- Ambiguous pairs cannot land in the KeyMap without an explicit choice.

## References

- [ADR-0042](../../../docs/adr/0042-join-lens-in-place-confirm.md)
- [ADR-0020](../../../docs/adr/0020-join-key-mapping.md)
- [ADR-0019](../../../docs/adr/0019-join-lens-ai-narrator.md)
- [ADR-0024](../../../docs/adr/0024-keymap-composite.md)
