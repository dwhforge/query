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

## Safe project replacement

Merged from [safe-help-lab-switch](../../changes/safe-help-lab-switch/proposal.md);
[ADR-0045](../../../docs/adr/0045-safe-help-lab-switch.md).

### Requirement: Explicit replacement permission

Opening a Help lab or quick-load demo SHALL use the same project-replacement
semantics as opening an existing project. If the current project has unsaved
changes or unsaved Mapping/Matching drafts, the operation SHALL offer
**Save / Discard / Cancel**. A saved path alone SHALL NOT mean the current work
is saved. An unchanged saved project SHALL NOT trigger an unnecessary warning.
Save SHALL permit switching only after successful persistence. Picker
cancellation, save failure, or remaining unsaved separate drafts SHALL keep the
current project open. Project Save SHALL NOT imply that separate warehouse or
Matching drafts have been committed. The same protection SHALL apply to
user-initiated Open and Open Recent through a shared lifecycle path.

#### Scenario: Save changed current project before switching
- **GIVEN** a saved project with an unsaved query or step change
- **WHEN** the user opens a lab and chooses Save
- **THEN** the current project is successfully saved before replacement
- **AND** the clean lab opens with independent identity and no save target

#### Scenario: First save before switching
- **GIVEN** a new project with unsaved work and no save path
- **WHEN** the user opens a lab and chooses Save
- **THEN** the existing save picker requests a path for the current project
- **AND** the lab opens only after saving succeeds

#### Scenario: Save cancelled or failed
- **GIVEN** unsaved work and a pending lab switch
- **WHEN** the user chooses Save but cancels the file picker or saving fails
- **THEN** the current project and drafts remain open with no replacement
- **AND** a save failure is shown through the existing error UI

#### Scenario: Separate drafts remain unsaved
- **GIVEN** local Mapping or Matching drafts not persisted by project-file Save
- **WHEN** the user chooses Save before switching
- **THEN** the current project stays open unless those drafts are safely persisted
- **AND** the UI explains what still needs saving without silently writing a warehouse or accepting proposals

#### Scenario: Discard before switching
- **GIVEN** unsaved work in the current project
- **WHEN** the user opens a lab and explicitly chooses Discard
- **THEN** the lab opens without saving the current changes

#### Scenario: Unchanged saved project
- **GIVEN** a saved project without later edits or separate dirty drafts
- **WHEN** the user opens a lab
- **THEN** it opens without an unsaved-work warning

#### Scenario: Cancel replacement
- **GIVEN** an existing project with a changed query or step
- **WHEN** the user opens a lab and cancels the replacement warning
- **THEN** the graph, changes, tabs, selection, identity and save path remain unchanged
- **AND** Mapping and Matching drafts remain available

#### Scenario: Empty startup
- **GIVEN** an initial empty project without local drafts
- **WHEN** the user opens a lab
- **THEN** no unnecessary replacement warning is shown

#### Scenario: Matching decisions
- **GIVEN** unsaved Matching decisions and existing workspace content
- **WHEN** the user opens a lab
- **THEN** one warning covers discarded content and decisions, rather than duplicate prompts

### Requirement: Independent lab save identity

A successful lab switch SHALL create a new unsaved project using existing
project identity and construction conventions. It SHALL NOT inherit the previous
project's save path, identity, linked dbt export tree, references, project-specific
connection bindings, outputs, checks, or history. App-global connections and
settings SHALL remain available. Explicit advanced-demo routing presets SHALL
remain supported. The offline reconciliation lab SHALL execute in DuckDB.

#### Scenario: Save lab after discarding current edits
- **GIVEN** a working project saved to a known file
- **WHEN** the user opens a lab, discards current edits if prompted, and invokes Save in the lab
- **THEN** a save destination is requested, not implicitly set to the previous project file
- **AND** the previous file's bytes remain unchanged unless explicitly selected for overwrite
- **AND** saving and reopening the lab preserves its independent identity and content

#### Scenario: Offline flagship with PostgreSQL defaults
- **GIVEN** app defaults configured for PostgreSQL and no live PostgreSQL connection
- **WHEN** the user opens the reconciliation flagship lab
- **THEN** it loads using DuckDB with its existing dirty recon join focus and partial map
- **AND** app-global connections and defaults are not rewritten

### Requirement: Replacement is atomic with respect to load completion

Cancellation, a failed load, or a superseded load SHALL NOT commit replacement
project state. A switch SHALL NOT discard a map write in flight or allow a late
reply from the previous project to mutate the new project. These protections
SHALL reuse existing execution lifecycle mechanisms rather than add a new bus.

#### Scenario: Failed lab load
- **GIVEN** an existing project and permission to switch
- **WHEN** lab loading fails
- **THEN** the original project content, identity, drafts and save path remain intact
- **AND** the failure is reported through existing error UI

#### Scenario: Lab load fails after successful save
- **GIVEN** the current project was successfully saved as part of the switch
- **WHEN** subsequent lab loading fails
- **THEN** the saved current project stays open and the successful save is not rolled back

#### Scenario: Map write in flight
- **GIVEN** a Mapping Save is still in flight
- **WHEN** the user requests a lab switch
- **THEN** replacement waits for settlement or is blocked with an explanation
- **AND** no committed write is described as rolled back

#### Scenario: Late load response
- **GIVEN** a lab request is pending and a later project transition has taken precedence
- **WHEN** the older lab response arrives
- **THEN** it does not replace or mutate the later project

## Flagship task card (ADR-0046)

### Requirement: Session-local reconciliation task

After successful opening of the reconciliation flagship, the workspace SHALL
show one compact dismissible English task card explaining mismatched commercial
SKU versus plant identifiers and pointing to the original Join and Join Lens.
The prepared mapped query SHALL be described as a partial example, not a result
achieved by the user. The card SHALL NOT block Data/Model or Mapping work.

#### Scenario: Open, dismiss, restore
- **WHEN** the user opens the flagship lab
- **THEN** its original dirty recon Join is selected and the task is visible
- **WHEN** the user dismisses the card and navigates or previews
- **THEN** the card remains dismissed until explicitly restored using Lab task

### Requirement: Deterministic task start

Show me SHALL resolve the actual Join in the existing original query, select it
using existing actions and enable Data/Join Lens without changing the graph or
forcing layout collapse. If the query/Join no longer exists, the action SHALL
be unavailable with a readable explanation rather than targeting another step.

#### Scenario: Start from another query
- **GIVEN** the lab session is on another query or Model view
- **WHEN** the user activates Show me
- **THEN** the original Join and Data/Join Lens are selected without pipeline edits

### Requirement: Task state never leaks to another project

Task visibility SHALL be session-local, owned by project identity, and cleared
on successful project/lab replacement. Failed/cancelled replacement SHALL retain
the current session. Matching query names in a normal/reopened project SHALL NOT
activate the task. No tutorial state SHALL be persisted in the project file.

#### Scenario: Switch away
- **WHEN** the user opens another project or a different lab
- **THEN** no stale flagship task remains

## Flagship opt-in hints (ADR-0046)

### Requirement: Bounded opt-in flagship hints

Only a live flagship task session SHALL offer hints, started explicitly by Show
me. At most one hint SHALL be visible. The goals SHALL be original Join selection
and actual Join Lens No match mode. Existing selection of the Join SHALL satisfy
the first goal. Reaching No match by any route SHALL complete and remove hints;
no mapping success or reconciliation success SHALL be inferred.

#### Scenario: Existing Join selection
- **GIVEN** the original Join is already selected
- **WHEN** the user activates Show me
- **THEN** assistance advances directly to Join Lens / No match
- **AND** selecting No match removes hints without another prescribed click

### Requirement: Local anchors, suspension and dismissal

Hints SHALL attach to the actual Join step, Lens toggle or No match control,
without screen-coordinate assumptions, content-blocking overlays or forced
scrolling. If the target is unavailable in the current layout, show readable
fallback text. Non-canvas tabs SHALL suspend rendering. Dismiss/Got it/Escape
SHALL stop hints until explicit Show me. Project replacement SHALL clear them.
No timer SHALL revive hints or escalate them in this slice.

#### Scenario: Hidden target
- **WHEN** the user hides the inspector/dock or switches to Model while hints are active
- **THEN** assistance uses text fallback or is suspended, never an arrow pointing at empty space

#### Scenario: Dismiss, resize and switch
- **WHEN** the user dismisses hints, resizes or rerenders the view
- **THEN** hints stay off until explicit activation
- **WHEN** the user opens another project/lab
- **THEN** no hint remains

### Requirement: Accessible hints

Hints SHALL include readable text and keyboard-operable dismissal without moving
focus. Reduced-motion preference SHALL remove pulse. Hint controls SHALL NOT
intercept ordinary target clicks or generate pipeline edits.

## Flagship comparison navigation (ADR-0046)

### Requirement: Honest original/example/reconciliation navigation

The flagship task SHALL offer explicit navigation to the original Join, the
prepared mapped example and final monthly reconciliation preview using existing
query/step selection. Missing or empty targets SHALL disable their links.
The mapped example SHALL be labelled partial/pre-existing, not a result created
by the current user. No fixed, fully matched or success claim SHALL be invented.
The instructions SHALL distinguish preview samples from full-input proof and
require recomputation after mapping edits before comparing results.

#### Scenario: Inspect the three views
- **WHEN** the user follows original, mapped example and monthly links
- **THEN** the actual original Join, mapped query final step and monthly final step are selected respectively
- **AND** Data shows the existing normal previews, not a cloned workspace or new calculation

#### Scenario: Edited or deleted target
- **WHEN** a comparison target has been deleted or has no steps
- **THEN** its action is disabled rather than silently navigating to another query

#### Scenario: Mapping edited
- **WHEN** the user edits the existing mapping and recomputes a relevant preview
- **THEN** any comparison is based on the current map through existing preview semantics
- **AND** the task never declares automatic success
