# Delta: help-lab — reference navigation

## ADDED Requirements

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
