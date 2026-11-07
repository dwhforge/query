# ADR-0042 — Join Lens in-place match confirm

## Status

**Accepted** (2026-11-07) — implemented; contract merged to
`openspec/specs/join-lens-in-place-confirm/`.

## Context

Matching two sides (e.g. CSV `name1`/`id1` ↔ `name2`/`id2`) already has Join +
Join Lens **Auto**: fuzzy (and optional LLM on leftovers) propose pairs; the user
checks boxes and Accept opens or fills a KeyMap.

That last hop is the wrong review surface for speed. A KeyMap often stores **ids**
only; the decision needs left/right context, labels, score, and runner-up — which
Join Lens already has. Sending the user to a KeyMap tab per batch adds navigation
without improving trust.

Silent auto-merge into Join ON remains forbidden
([ADR-0019](0019-join-lens-ai-narrator.md), [ADR-0020](0020-join-key-mapping.md)).
What we want is an **attempted match** with confirmation **in the Lens**, minimum
clicks, then one apply into the existing KeyMap / ApplyKeyMap path.

## Decision

1. **Review surface = Join Lens (session staging), not the KeyMap editor.**
   Fuzzy / LLM proposals are staged in the Lens UI with proposed To values and
   enough context to decide (keys, optional labels, score, ambiguous flag,
   runner-up). The KeyMap grid is not the primary place to resolve disputes.

2. **Attempted match, not silent Join ON.** Running Auto (or equivalent) builds a
   session proposal set. Join keys and ON clauses do not change until the user
   confirms. Unconfirmed proposals do not affect preview, export, or dbt SQL.

3. **Default selection policy.** Unambiguous proposals are pre-accepted in the
   session. Ambiguous / low-confidence / leftover proposals require an explicit
   choice: accept best, pick runner-up (or another listed candidate), or skip.
   One click per disputed row is the target; no required open of a KeyMap tab.

4. **One confirm action.** A single control (e.g. **Apply accepted**) commits the
   currently accepted session proposals into an existing or new KeyMap and ensures
   ApplyKeyMap is on the graph (same SoT rules as today: seed / source / query /
   ref). Cancel or dismiss leaves the project KeyMap and Join unchanged.

5. **LLM stays optional and bounded.** LLM may only propose for leftovers the
   deterministic matcher did not claim, into the same Lens queue. It must not write
   Join ON, invent counts, or bypass confirm ([ADR-0019](0019-join-lens-ai-narrator.md)).

6. **Composite Join.** Per-column / slot rules from [ADR-0024](0024-keymap-composite.md)
   remain: the user (or prior Auto step) selects which ON column the suggestions
   remap; confirm still writes ApplyKeyMap for that column, not a fuzzy multi-key ON.

## Consequences

- Extends Join Lens Auto UX; does not replace KeyMap as SoT after confirm.
- Amends the practical “Accept → open map tab” hop from ADR-0020 without lifting
  the ban on automatic fuzzy Join ON.
- OpenSpec change: `openspec/changes/join-lens-in-place-confirm/`.
- Out of scope here: silent auto-merge; KeyMap as the dispute UI; universal schema
  mapper; changing Apply uniqueness / ready-map rules.
