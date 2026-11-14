# Join Lens No match

## ADDED Requirements

### Requirement: Mode controls the ordinary result scope
All rows (formerly This row) SHALL show the full Join preview. No match SHALL show only unmatched
rows in the ordinary center preview, retaining source row identity for active
selection, left context, and Suggest. Returning to All rows SHALL restore all
preview rows. Explicit hypothetical pair previews remain separate from the
ordinary result and SHALL NOT be represented as actual matches.

#### Scenario: Mixed matched and unmatched result
- GIVEN a Join preview containing both matched and unmatched rows
- WHEN No match is activated
- THEN matched rows are absent from the ordinary center table
- AND clicking a filtered row targets its original left key
- WHEN All rows is activated
- THEN matched and unmatched rows are visible again

### Requirement: Persistent left context for the active result
In No match mode, left unmatched cards sharing the active result's join-key tuple
SHALL remain visibly highlighted while that result is active. The first visible
matching card SHALL scroll into view. This contextual highlight SHALL NOT select a
mapping partner or filter the center result. It SHALL update or clear when the
active result, diagnostic sample, filter, or mode changes.

#### Scenario: Result click reveals the matching left key
- WHEN a user clicks an unmatched center result row
- THEN its visible left counterpart is revealed and persistently highlighted
- AND clicking a different result moves or clears the contextual highlight
- AND the center remains unfiltered by this interaction

### Requirement: Suggest resides in the right pane
The single-key Suggest action SHALL be in RIGHT · NO MATCH, above the right list,
with the source key visible. It SHALL use an explicitly selected left key when
available, otherwise the active unmatched result key. It SHALL remain available
when the right unmatched list is empty, and SHALL NOT suggest from a joined result,
a right-only selection, or an already selected pair. Existing explicit acceptance
and mapping write behavior SHALL remain unchanged.

#### Scenario: No right-side gaps
- GIVEN an active unmatched result and an empty right unmatched list
- WHEN the user activates Suggest in the right pane
- THEN the existing suggestion dialog opens for that result's left key

### Requirement: Mapping picker contains long content
The unmatched-key mapping picker SHALL keep mapping choices and actions inside
its card and viewport on narrow screens. Long map names and unmatched keys SHALL
wrap rather than widening the card; vertically overflowing content SHALL scroll.

#### Scenario: Long vendor mapping name on a narrow viewport
- GIVEN a mapping name longer than the available card width
- WHEN the unmatched-key mapping picker opens on a narrow screen
- THEN choices stay within the card, the card stays within the viewport, and its actions remain reachable
