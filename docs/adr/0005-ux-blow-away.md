# ADR-0005: UX must blow everyone away

## Status

Accepted (2026-10-24)

## Context

The product is first and foremost a **visual tool**. Technical axes (dbt export, DuckDB, multi-source, two-way SQL, PQ-path) are secondary if the product is hard to use.

Explicit goal from v1: on convenience, beat Power Query / typical SQL IDEs / “click dbt in a wiki” — not “good enough”, but set the bar for *delight + speed of thought*.

## Decision

### Priority rule

On conflict: **clarity and speed of the visual flow > feature completeness > export edge-case fidelity**.  
Export/IR stay intact (ADR-0002/0004), but UX debt must not wait “until after dbt”.

### Non-negotiable UX principles (from the first UI)

1. **One mental model** — Workspace = queries + steps; no hidden “pipeline mode vs dbt mode”.  
2. **Instant feedback** — preview ≤150ms debounce; join/schema errors next to the step, not a context-free toast.  
3. **Direct manipulation** — click/drag on steps and links beats 12-field forms; Join in ≤3 actions.  
4. **Empty state teaches** — first run: 2 clicks to “I see a table”; sample fixtures in one click.  
5. **Density without dashboard clutter** — one composition; secondary chrome (SQL, export path) must not fight brand/preview.  
6. **Keyboard first-class** — add step, focus preview, export without requiring a mouse (v1 baseline shortcuts).  
7. **Honest dual view** — visual is canon; SQL read-only now, editable later without two truths (ADR-0004).  
8. **Beauty is function** — typography, 2–3 intentional motions, data contrast; not generic AI-slop chrome.

### Anti-goals

- PQ feature parity at the cost of an overloaded UI.  
- “Enterprise gray” as a signal of seriousness.  
- Modals for everything; wizards longer than 2 steps for Load/Join.

### Definition of “blow everyone away”

Subjective gates before shipping a horizon:

- A new user builds 2 CSV → Join → preview in **&lt;2 minutes**.  
- Tweaking a join key / filter feels **instant**.  
- dbt export is one gesture after the graph is ready, no file surprises.  
- Blind session: a PQ user says “this is nicer for building joins”, even with a smaller transform catalog.

## Consequences

- DESIGN / UI reviews check these principles, not only SPEC DoD.  
- Before growing the PQ catalog — polish the core loop (load → join → preview → export).  
- UX tech debt (virtualization, layout, empty states) is P0 alongside compiler bugs.
