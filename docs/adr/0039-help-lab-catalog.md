# ADR-0039 — Help Lab catalog

## Status

**Accepted** (2026-11-05).

OpenSpec: [`openspec/specs/help-lab/`](../../openspec/specs/help-lab/) (merged from [`openspec/changes/help-lab-catalog/`](../../openspec/changes/help-lab-catalog/)).

Related: [ADR-0005](0005-ux-blow-away.md), [ADR-0018](0018-return-and-edit.md), [ADR-0020](0020-join-key-mapping.md), [ADR-0026](0026-mapping-quality-overview.md).

## Context

Help → Load demo / Mapping labs grew into a flat list of ~16 workspaces. Labels name mechanisms (`seed`, `RIGHT OUTER`) instead of the job a user finishes. EmptyHero duplicated another subset. New demos meant more menu JSX — metadata was not maintainable.

The product narrative is: agree data from different systems, explain gaps, keep a checked calculation as SQL/dbt. Teaching surfaces must show **what the lab demonstrates** and **what remains after** (KeyMap seed, recon queries, export), not only “open this workspace”.

## Decision

1. **Help Lab is a first-class workspace center tab** (always available), opened from Help and EmptyHero. It is a teaching gallery, not a second editor or a second IR.

2. **Committed catalog is SoT for demo metadata.**  
   `fixtures/labs/catalog.json` owns id, track, title, tagline, `teaches[]`, `youKeep[]`, `requires`, `featured`. The UI and Help menu read this catalog (via host). Do **not** grow flat Help → item lists as the primary path.

3. **Load path stays `load_demo_workspace(id)`.** Catalog entries map 1:1 to existing (or new) demo builders. Generated `fixtures/examples/*` labs remain generated; the catalog may reference them under Advanced.

4. **Flagship offline lab: `recon_ship_sales`.** Plant shipments ↔ commercial sales with different SKU codes; partial KeyMap; dirty Join for Lens; monthly qty/amount gaps. Encodes the reconciliation story without becoming an MDM product.

5. **Out of scope here:** map-delta / month-2 refresh product, impact-of-edit run compare, weighted many-to-many, deleting legacy keymap_* builders.

## Consequences

- Help menu primary path: User guide · Help Lab… (Advanced/PG only via Lab tracks).
- EmptyHero: open Lab + one quick Key mapping load — not five equal demo buttons.
- New teaching demos = catalog row + fixtures (+ optional Rust builder); no menu-only additions.
- OpenSpec change `help-lab-catalog` must merge into `openspec/specs/help-lab/` when done.
