# Spec: keymap-multi-output-checks

ADR: [0037](../../../docs/adr/0037-keymap-multi-output.md).

## Requirements

### Requirement: MappingCheck respects multi-output without changing grain
[ADR-0035](../../../docs/adr/0035-mapping-check-attrs-ux.md) grain and axes SHALL remain: grain is the Join keys; axes are selected side attributes; composite keys keep every part including date. The Apply↔Join link, revision fingerprint, Inspect, and jump into Lens SHALL include `output_columns` and each step's `output_bindings`. Inspect SHALL show the full matched output tuple.

#### Scenario: Two outputs are not two matches
- **GIVEN** a check scope where one key maps to two filled destinations
- **WHEN** coverage is computed
- **THEN** the key counts as one correspondence
- **AND** not as two successful matches

### Requirement: Distinct failure outcomes
Overview / Inspect SHALL distinguish: no map row; ambiguous map row; map row found but target Join missed; target Join multiplied rows.

#### Scenario: Ambiguous map separate from Join miss
- **WHEN** the map match is ambiguous for a key
- **THEN** the outcome is not classified as a target Join miss
