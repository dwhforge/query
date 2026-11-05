## ADDED Requirements

### Requirement: Emitter takes ApplyEmitSpec
Apply SQL emission SHALL consume a typed ApplyEmitSpec (fact keys, map columns, bindings, temporal fields, dialect-neutral flags). The emitter SHALL NOT invent output bindings or choose destinations.

#### Scenario: Missing bindings refuse
- **WHEN** ApplyEmitSpec has empty bindings
- **THEN** emit fails with a clear error before SQL is produced
