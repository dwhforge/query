# Unified Suggest Right

Decision: [ADR-0049](../../../docs/adr/0049-unified-suggest-right.md).

## Ordered tuple semantics

Suggest Right SHALL derive every ordered pair from the current Join's left/right
ON arrays, for any positive arity. It SHALL open directly from the selected
unmatched source, without choosing a key, Composite Mode, or another tool.
Parts SHALL remain structured; display separators SHALL NOT identify tuples.

### Scenario: contexts sharing a label

Confirming `(ABC, UK) → (ABC Limited, UK)` SHALL NOT map `(ABC, US)`.
The same isolation SHALL hold when the distinguishing context is the third or
later key. Different column names and physical source order SHALL NOT change
the positional left/right ON correspondence.

## Candidate retrieval and confirmation

Candidates SHALL be complete real right tuples, with all key fields and visible
differences. Duplicate tuple occurrences and missing parts SHALL be visible.
Exact matches, multi-field fuzzy scoring, and configured/authorized LLM selection
SHALL be available without arity-based disabling. Fuzzy SHALL score all aligned
fields using the shared matcher, not require other fields to match one slot.
No score or LLM response SHALL select or confirm a target automatically.

### Scenario: several differing fields

For `(ABC, UK, Diesel)`, a real candidate `(ABC Limited, United Kingdom, Gas Oil)`
SHALL remain eligible for full-field scoring, manual selection, and LLM review.
The UI SHALL expose all three differences.

### Scenario: no fuzzy hit or ambiguous hits

With no fuzzy hit and a configured provider, the existing automatic LLM fallback
SHALL be reachable for any arity. With fuzzy hits, manual Ask LLM SHALL remain
available. Without a provider, explain configuration and retain manual search.
LLM SHALL receive the complete source and allowed complete targets, and its
response SHALL be validated against the exact arrays actually sent. Invented
values or recombinations SHALL NOT create mappings.

## Stable review shell and ranking visibility

The dialog SHALL use app-consistent styled controls and a fixed preferred width
and height bounded by the viewport. Header, ranking toolbar, and footer SHALL
remain pinned while the review body scrolls. Async retrieval, LLM busy/results,
and manual filtering SHALL NOT resize the shell or move the confirmation controls.
Field comparison SHALL preserve every ordered field, full values, differences,
field scores, occurrence/duplicate counts, and bounded-retrieval notices.

Ask LLM to rank candidates SHALL remain prominent and visible before and after
retrieval, including when fuzzy hits exist. While unavailable it SHALL be disabled
with a visible reason; an unconfigured provider SHALL explain configuration in
Options. Busy ranking SHALL be labeled and prevent repeated requests. No ranking
SHALL preselect or confirm a target. Manual browsing MAY start collapsed under
Search other records, with the retrieved tuple count and an all-field search. Manual results SHOULD
use compact labeled target values rather than repeated source/target tables,
while retaining every field, difference marker, count, and score.

### Scenario: search and ranking complete without layout jumps

At desktop and smaller viewport sizes, opening the dialog, completing retrieval,
requesting LLM ranking with fuzzy hits, receiving its response, and expanding or
filtering manual search SHALL retain shell geometry. Scrolling the body SHALL
leave ranking and confirmation controls visible. Without a provider, manual
selection SHALL remain available and configuration guidance SHALL be visible.

## Contextual Mapping and Apply

Confirmation SHALL store all source parts and all selected output values using
existing KeyMap fields. Explicit output bindings SHALL align every output with
the corresponding left Join column. Existing Apply review and validation SHALL
remain authoritative; Join execution SHALL NOT be rewritten around Apply.
Existing scalar mappings, Auto, and manual Mapping workflows SHALL remain valid.
Conflicting targets, duplicate From tuples, or unsaved editor changes SHALL NOT
be silently overwritten. Cancel/close SHALL NOT mutate Mapping.

### Scenario: multiple outputs and persistence

`(ABC, UK, Diesel) → (ABC Limited, United Kingdom, Diesel)` SHALL update both
differing fields through a single contextual Mapping row. Apply SHALL preserve
input cardinality. Save, application restart, Open, and execute SHALL reproduce
the pre-save Join result. A duplicate right target may multiply the Join; its
occurrence count SHALL NOT be presented as a unique row match.

## Safety and bounds

NULL, empty string, whitespace-only string, and literal ∅ SHALL remain distinct.
If existing ready Mapping cannot represent a selected value safely, confirmation
SHALL be blocked with an explanation rather than converting it into an alias.
Retrieval/LLM results and confirmation SHALL be invalidated by context changes.

Retrieval MAY remain bounded at 200 distinct tuples per side. Totals and
truncation SHALL be shown. Manual search and LLM SHALL NOT be described as
dataset-wide when limited to retrieved candidates. Prompt budgets MAY further
bound LLM candidates, but validation SHALL use that exact prompt allowlist.
