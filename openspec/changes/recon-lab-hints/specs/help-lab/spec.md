# Delta: help-lab — opt-in hints

## ADDED Requirements

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
