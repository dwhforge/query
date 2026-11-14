# Join Lens No match focus

## Why
The active result's left key is hard to locate after the temporary flash expires.
Suggest belongs with the right-side target search, including an empty right list.
No match must also exclude matched center rows; All rows retains the full result.
The unmatched-key mapping picker must contain long mapping names on narrow screens.

## Scope
Persistently highlight and reveal left unmatched cards for the active result key,
without selecting a mapping partner or filtering the result. Move the single-key
Suggest action into RIGHT · NO MATCH, using the selected left key or active
unmatched result. Preserve explicit confirmation and mapping semantics under
ADR-0020 and ADR-0042; no new architecture or matching policy is introduced.
Filter the ordinary center preview to unmatched rows in No match and translate
displayed row positions back to the original preview indices for all actions.
Rename This row to All rows, update help, and contain the existing mapping picker
without changing its selection or persistence behavior.

## Status
Completed. Contract merged into `openspec/specs/join-lens-no-match/spec.md`.

## Validation
- TypeScript check and rebuilt Electron UI passed.
- Unit suite passed.
- Two focused Electron regressions passed: persistent left context and right-pane
  Suggest; mixed/composite result filtering, empty right gaps, and mapping-picker
  containment at 738 × 526.
- Two existing Help Lab hint/navigation regressions passed after the All rows rename.
- Narrow mapping-picker screenshot visually reviewed; long names wrap inside the card.
- Host binary reused for Electron tests; no backend code changed.
