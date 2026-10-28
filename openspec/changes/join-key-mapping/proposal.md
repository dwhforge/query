# Proposal: Join Key Mapping Tool

## Why

Unmatched join keys often need **trim/case** cleanup or **business aliases** (channel codes, region synonyms). Diagnostics alone leave users stuck; silent fuzzy ON would break inspectable trust ([ADR-0019](../../../docs/adr/0019-join-lens-ai-narrator.md)). Industry pattern: suggest → explicit step before Join; ship aliases as dbt seeds ([ADR-0020](../../../docs/adr/0020-join-key-mapping.md)).

## What changes

| In scope | Out of scope |
|----------|--------------|
| IR: `KeyMapDef`, `NormalizeKey`, `ApplyKeyMap` | Automatic fuzzy merge in Join ON |
| `join_key_near_miss` + Apply → NormalizeKey | AI inventing aliases |
| From→To editor + entry points + Apply L/R/Both | Universal column schema mapper |
| Export `seeds/map_*.csv` + model join; **seed SoT after first export** + seed→KeyMap sync | Automatic fuzzy merge |
| Optional KeyMap bound to existing WH table / source (same From→To) | Universal column schema mapper |
| ADR-0020, DESIGN §9 link, userGuide | Fuzzy suggest→Accept (after MVP) |

## Capabilities

1. **key-map-ir** — Workspace maps + NormalizeKey/ApplyKeyMap emit (preview + dbt)
2. **near-miss** — score hypotheses; Apply inserts NormalizeKey before Join
3. **key-map-ui** — From→To editor, entry points, Apply L/R/Both, unique-from
4. **key-map-export** — seeds as table materialization; after first export seed is SoT with sync back into KeyMap; stable re-export / conflict refuse

## Success

- Near-miss with positive delta can be applied; preview join overlap improves without changing Join keys.
- User can map unmatched values From→To, Apply on a side, see remapped preview; export contains `seeds/map_*.csv` and model SQL that refs the seed.
- After first export, editing `seeds/map_*.csv` and re-opening / sync updates the KeyMap editor; re-export does not silently wipe that edit (hash conflict or adopt).
- Duplicate `from` blocks save; empty `to` rejected.

## References

- [ADR-0020](../../../docs/adr/0020-join-key-mapping.md)
- [DESIGN.md](../../../docs/DESIGN.md) §9
