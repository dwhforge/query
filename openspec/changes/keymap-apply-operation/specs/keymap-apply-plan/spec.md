## ADDED Requirements

### Requirement: ApplyPlan is the only post-confirm Apply SoT
After the user confirms Apply review, the product SHALL resolve an ApplyPlan that includes side-specific output bindings, optional Join rewrite with frozen Join identity, and a map revision fingerprint. The UI SHALL NOT re-derive bindings or Join ON defaults in App shell code.

#### Scenario: Right-side destinations
- **WHEN** the user confirms right Apply with destinations different from map column names
- **THEN** the ApplyKeyMap step on the right query carries those destinations in `output_bindings`

#### Scenario: Incomplete Join rewrite refused
- **WHEN** Apply+Join is requested without a frozen Join identity
- **THEN** the fold fails without inserting a lone Apply that would retarget another Join
