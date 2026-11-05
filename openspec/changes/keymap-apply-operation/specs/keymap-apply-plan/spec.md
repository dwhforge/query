## ADDED Requirements

### Requirement: ApplyPlan is the only post-confirm Apply SoT
After the user confirms Apply review, the product SHALL resolve an ApplyPlan that includes side-specific output bindings, optional Join rewrite with frozen Join identity, and a map revision fingerprint. The UI SHALL NOT re-derive bindings or Join ON defaults in App shell code.

#### Scenario: Right-side destinations
- **WHEN** the user confirms right Apply with destinations different from map column names
- **THEN** the ApplyKeyMap step on the right query carries those destinations in `output_bindings`

#### Scenario: Incomplete Join rewrite refused
- **WHEN** Apply+Join is requested without a frozen Join identity
- **THEN** the fold fails without inserting a lone Apply that would retarget another Join

### Requirement: Confirmed choice is not silent defaults
When an `ApplyUserChoice` is present, empty or invalid bindings SHALL fail resolve. Omitting the choice MAY apply the documented no-review defaults. The resolver SHALL refuse unknown `map_column`, empty or duplicate destinations, and Apply key arity that cannot cover map From columns.

#### Scenario: Empty confirmed bindings
- **WHEN** review confirms with `bindings: []`
- **THEN** resolve returns an error and does not invent default destinations

### Requirement: Commit checks map revision
`applyKeyMapOntoProject` SHALL compare `expectedMapRevision` to the live Project map before mutation. On mismatch or missing map it SHALL return `stale` and leave the Project unchanged. On match it SHALL Apply using the live map and SHALL NOT upsert the plan's map snapshot over a newer revision.

#### Scenario: Value change at same row count
- **WHEN** a seed map's output values change after plan prepare without changing entry count
- **THEN** commit refuses as stale and the newer map remains in the Project
