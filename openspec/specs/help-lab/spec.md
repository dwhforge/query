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

### Requirement: Name→id match lab
Help SHALL include offline lab `name_id_match` with two independent CSV catalogs (`crm_id`/`name`, `erp_id`/`name`), a dirty Join on ids, and a KeyMap seed whose From/To are ids with `from_name`/`to_name` attrs for editing. Join Lens Auto SHALL score sibling name labels while proposing id→id pairs.

#### Scenario: Open name_id_match
- **WHEN** the user opens `name_id_match` from Help Lab
- **THEN** the workspace focuses `dirty_by_id`
- **AND** KeyMap `map_crm_to_erp` has editable columns `from_name` and `to_name`

### Requirement: Name+region soft-match lab
Help SHALL include offline lab `name_region_match` with POS invoices (`vendor_label`/`region`/`qty`) vs vendor master (`vendor_name`/`region`/`category`/`vendor_id`) covering **two** example families: (1) the **exact same** vendor name in multiple regions as distinct companies (e.g. `ComputerParts LLC` US vs DE); (2) brand names with English LLM synonyms on name **and** region (e.g. `Nestlé Waters` / `Danone Waters` with `NW bottled water`, `EU`/`RF`/`Russia`). It SHALL include a dirty dual-key Join, a name-only Join that fans shared names across regions, and a composite KeyMap seed covering only exact pairs so Matching / LLM must complete synonym rows. The lab SHALL include mart query `by_vendor_region` with grain `vendor_name`, `region` and measure `SUM(qty)`.

#### Scenario: Open name_region_match
- **WHEN** the user opens `name_region_match` from Help Lab
- **THEN** the workspace focuses `dirty_exact_pair`
- **AND** KeyMap `map_pos_to_vendor` has composite From columns `vendor_label` and `region`
- **AND** queries `dirty_name_only`, `invoices_mapped`, and `by_vendor_region` are present

#### Scenario: Same name different regions stay separate
- **WHEN** the user previews `by_vendor_region`
- **THEN** columns are `vendor_name`, `region`, `qty`
- **AND** `ComputerParts LLC` appears once for US and once for DE
- **AND** `Nestlé Waters` appears once for Europe and once for RUS

### Requirement: Flattened discovery
EmptyHero and Help SHALL prefer Help Lab over a long equal-weight demo button row. Postgres-only labs MAY appear only under an Advanced track in the catalog.

#### Scenario: Empty project
- **WHEN** the user views EmptyHero
- **THEN** a primary control opens Help Lab
- **AND** at most one secondary quick-load demo remains for Key mapping
