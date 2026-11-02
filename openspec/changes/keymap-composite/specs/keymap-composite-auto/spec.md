# Spec Delta: keymap-composite-auto

## ADDED Requirements

### Requirement: Multi-key Join does not dead-end Auto

When Join `left_on` / `right_on` length > 1, Auto/Suggest SHALL NOT only return a disabled dead-end. The system SHALL offer **per-column** and **composite-map** modes.

#### Scenario: Per-column mode
- **GIVEN** Join ON `[sku_code, day]` / `[item_code, day]`
- **WHEN** the user chooses per-column and selects `sku_code`
- **THEN** fuzzy suggestions run on that column pair and Accept can fill an arity-1 KeyMap / ApplyKeyMap on `sku_code`

#### Scenario: Composite-map mode
- **GIVEN** the same Join
- **WHEN** the user chooses composite map on `[sku_code, day]`
- **THEN** the flow targets an arity-2 KeyMap whose From parts align to those columns

### Requirement: No glued separator From

The system MUST NOT invent KeyMap From values by joining columns with a display separator (e.g. ` · `) as a substitute for composite From.

#### Scenario: Reject glue strategy
- **GIVEN** a multi-key Join
- **WHEN** suggestions are produced in composite mode
- **THEN** accepted entries use `from_parts` arrays, not a single glued string
