# Spec: keymap-composite-ui

## Requirements

### Requirement: Editor supports arity N From columns

The KeyMap editor SHALL edit `from_columns` names (map relation) and a grid with one input per From part plus To (and attrs).

#### Scenario: Add From column
- **GIVEN** an arity-1 seed map
- **WHEN** the user adds a second From column name
- **THEN** each row gains a second From cell and validation uses tuple uniqueness

### Requirement: Apply uses columns list

Apply L/R/Both SHALL insert/update ApplyKeyMap with `columns` matching map arity (and optional output column).

#### Scenario: Apply composite map
- **GIVEN** arity-2 map bound to fact columns `ext_offer_id`, `day`
- **WHEN** Apply left is confirmed
- **THEN** the host query gains ApplyKeyMap with those two columns before the Join
