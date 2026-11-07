# Design: Help Lab catalog

## Catalog

`fixtures/labs/catalog.json` is a JSON array of lab cards. Tracks: `start`, `mapping`, `quality`, `advanced`. Host parses with serde; unknown fields ignored for forward compat. FE types mirror the wire shape in `src/help/labCatalog.ts`.

## Load

Unchanged RPC `load_demo_workspace`. New id `recon_ship_sales` builds workspace from `fixtures/labs/recon_ship_sales/*.csv`. Other ids keep existing builders (`api.rs`, `demo_keymap_labs`, `demo_mapping_quality`).

## UI

`HelpLab.tsx` is a center-tab panel (not a modal). Featured cards (recon + mapping quality) sit above track sections. Open → App `loadDemo(id)`. Menu: Help Lab…; drop the long Mapping labs list (Advanced live in Lab).

## Maintainability

Add a lab: catalog row + fixtures (+ Rust builder if new). Do not add AppMenu items for teaching demos.
