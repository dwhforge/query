# Proposal: Help Lab catalog

## Why

Demo discovery is a flat Help menu and a duplicate EmptyHero row. Users cannot see what a lab teaches or what they keep after working it. Metadata lives in JSX, so every new demo makes the list worse ([ADR-0039](../../../docs/adr/0039-help-lab-catalog.md)).

## What changes

| In scope | Out of scope |
|----------|--------------|
| Help Lab workspace tab + catalog-driven cards | Map-delta / month-2 refresh product |
| `fixtures/labs/catalog.json` as metadata SoT | Impact-of-edit / run comparison |
| Host `list_help_labs` + `recon_ship_sales` demo | Weighted many-to-many |
| Flatten Help / EmptyHero demo lists | Deleting legacy keymap_* builders |
| ADR-0039, DEMOS / DESIGN pointers | Second IR or separate recon editor |

## Capabilities

1. **help-lab** — catalog contract, Lab tab, load from catalog id, recon flagship

## Success

- User opens Help Lab, reads story / teaches / you-keep, loads a lab without hunting a flat menu.
- `recon_ship_sales` loads offline; dirty join and partial map are inspectable.
- Renaming or reordering a lab is a catalog edit, not AppMenu JSX.

## References

- [ADR-0039](../../../docs/adr/0039-help-lab-catalog.md)
- [ADR-0020](../../../docs/adr/0020-join-key-mapping.md), [ADR-0026](../../../docs/adr/0026-mapping-quality-overview.md)
