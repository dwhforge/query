# Spec: help-lab

Merged from [`openspec/changes/help-lab-catalog/`](../../changes/help-lab-catalog/). Canon: [ADR-0039](../../../docs/adr/0039-help-lab-catalog.md).

## Requirements

### Requirement: Catalog is the demo metadata SoT
The product SHALL expose Help labs from a committed `fixtures/labs/catalog.json`. Each entry SHALL include `id`, `track`, `title`, `tagline`, `teaches`, `youKeep`, `requires`, and `featured`. The Help menu SHALL NOT be the primary place where new labs are listed as flat items.

#### Scenario: List labs
- **WHEN** the client requests `list_help_labs`
- **THEN** the host returns catalog entries in file order
- **AND** each entry id is a valid `load_demo_workspace` name (or documented alias)

### Requirement: Help Lab workspace tab
The UI SHALL provide an always-available workspace center tab **Help Lab** that renders catalog cards with story, teaches, you-keep, requires badge, and Open. Opening a lab SHALL call the existing demo load path and focus the workspace appropriately (canvas, or Mapping quality for the quality lab).

#### Scenario: Open reconciliation lab
- **WHEN** the user opens `recon_ship_sales` from Help Lab
- **THEN** an offline DuckDB workspace loads with focus on the dirty recon join
- **AND** a partial KeyMap is present for further mapping

### Requirement: Reconciliation flagship fixtures
Help SHALL include offline lab `recon_ship_sales` with committed CSVs under `fixtures/labs/recon_ship_sales/` (shipments, sales, dim_product, partial map seed). Generation scripts SHALL NOT be required for this lab.

#### Scenario: First open without examples generate
- **WHEN** `fixtures/examples/` has not been generated
- **THEN** `recon_ship_sales` still loads successfully from committed lab fixtures

### Requirement: Flattened discovery
EmptyHero and Help SHALL prefer Help Lab over a long equal-weight demo button row. Postgres-only labs MAY appear only under an Advanced track in the catalog.

#### Scenario: Empty project
- **WHEN** the user views EmptyHero
- **THEN** a primary control opens Help Lab
- **AND** at most one secondary quick-load demo remains for Key mapping
