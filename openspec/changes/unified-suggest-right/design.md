# Design

1. Add optional `tuple.source_parts` to the existing host fuzzy command and
   optional `tuple_report` to its response. Legacy callers keep their behavior.
2. Group tuples in SQL in Join order; retain nullable parts, occurrence totals,
   and bounded retrieval metadata. Focus the source predicate before sampling.
3. Use the shared field scorer for each aligned pair and their equal-weight mean.
   Return all retrieved candidates; frontend labels candidates above the existing
   cutoff as fuzzy suggestions, retaining the others for manual/LLM selection.
4. Render source/target fields, differences, scores, and counts. Never preselect
   a fuzzy or LLM result. LLM fallback after no fuzzy hit is allowed only with a
   configured provider; manual Ask LLM remains available with fuzzy hits.
5. Validate structured LLM source and target arrays against the precise prompt
   allowlist. Keep asynchronous replies owned by the complete request context.
6. Confirm and plan a contextual seed map using disjoint generated From/To column
   names. Save all source/output values and propagate explicit destination bindings
   into the existing multi-output Apply review. Keep conflict/dirty-tab guards.
7. Use unchanged project persistence and execution. Validate real host and Electron
   cold-restart Save/Open, not just a serialized UI fixture.

No new project schema or independent matching engine is introduced. Boundaries
and verification evidence are in the report.

## UI polish follow-up

- Reuse Options dialog palette, typography, borders, hover/focus treatment.
- Preferred 840 × 740 px shell, bounded by viewport minus 32 px. Pinned header,
  ranking toolbar, and fixed-height footer; only the body scrolls.
- Stable-width Ask LLM to rank candidates action with configuration/search/block
  reasons and an explicit busy state, independent of fuzzy hit availability.
- Four-column field review combines aligned field names without hiding values or
  differences. Manual universe starts behind Search other records; counts and
  all-field search remain discoverable. No backend or Mapping changes.
- Manual browsing uses compact labeled target-value grids rather than repeating
  full source/target tables for every record. Source values remain in the source
  section; each target retains all values, per-field change markers, counts and
  scores, with the whole card serving as the selection label.
- Component tests load actual app CSS through Vite, checking geometry through
  delayed search and LLM completion at desktop and smaller viewport sizes.
